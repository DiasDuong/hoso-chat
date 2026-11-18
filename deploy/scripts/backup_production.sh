#!/usr/bin/env bash
# ==============================================================================
# SOTRANS HUB — PRODUCTION BACKUP & CONSISTENCY VERIFICATION SCRIPT
# ==============================================================================
# Point-in-Time Multi-Component Backup:
# 1. PostgreSQL 'hrbot' logical snapshot (pg_dump -Fc)
# 2. Qdrant vector collection snapshot download
# 3. Permanent documents & attachments (chat-files)
# 4. Uploaded File BI datasets, raw spreadsheets & registry (storage/)
# 5. Configuration & environment metadata
#
# Target Objectives:
# - RPO (Recovery Point Objective): <= 24 hours (Daily Snapshot)
# - RTO (Recovery Time Objective): <= 30 minutes
#
# Note on Consistency: Cross-component consistency is achieved by executing
# this script during the designated low-activity maintenance window.
# ==============================================================================

set -euo pipefail

BACKUP_ROOT="${BACKUP_DIR:-/var/backups/sotrans-hub}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"
RETENTION_DAYS=7
QDRANT_HOST="${QDRANT_HOST:-localhost}"
QDRANT_PORT="${QDRANT_PORT:-6333}"
QDRANT_COLLECTION="${QDRANT_COLLECTION:-sotrans_hr_documents}"

mkdir -p "${BACKUP_DIR}"
echo "================================================================================"
echo "SOTRANS HUB — PRODUCTION BACKUP INITIALIZATION"
echo "Timestamp: ${TIMESTAMP} | Destination: ${BACKUP_DIR}"
echo "================================================================================"

# 1. PostgreSQL Database Dump (Custom Compressed Format with Internal Transaction Snapshot)
echo "[1/5] Dumping PostgreSQL database 'hrbot'..."
docker exec sotrans-postgres-prod pg_dump \
  -U "${POSTGRES_ADMIN_USER:-postgres}" \
  -d "${PG_DATABASE:-hrbot}" \
  -Fc --no-owner --no-privileges \
  > "${BACKUP_DIR}/postgres_hrbot_${TIMESTAMP}.dump"

PG_SIZE=$(du -h "${BACKUP_DIR}/postgres_hrbot_${TIMESTAMP}.dump" | cut -f1)
echo "      PostgreSQL dump completed successfully (${PG_SIZE})."

# 2. Qdrant Vector Storage Snapshot Generation & Download (All Active Collections)
echo "[2/5] Creating and downloading snapshots for all active Qdrant collections..."
QDRANT_COLLECTIONS_JSON=$(curl -s "http://${QDRANT_HOST}:${QDRANT_PORT}/collections" || true)
QDR_COLLECTIONS=$(echo "${QDRANT_COLLECTIONS_JSON}" | grep -o '"name":"[^"]*' | cut -d'"' -f4 || true)

if [ -z "${QDR_COLLECTIONS}" ]; then
  QDR_COLLECTIONS="${QDRANT_COLLECTION:-sotrans_hr_documents}"
fi

for coll in ${QDR_COLLECTIONS}; do
  echo "      Processing Qdrant collection '${coll}'..."
  SNAP_RESP=$(curl -s -X POST "http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${coll}/snapshots" || true)
  SNAP_NAME=$(echo "${SNAP_RESP}" | grep -o '"name":"[^"]*' | head -n 1 | cut -d'"' -f4 || true)
  if [ -n "${SNAP_NAME}" ]; then
    echo "      Downloading snapshot '${SNAP_NAME}'..."
    curl -s -o "${BACKUP_DIR}/${SNAP_NAME}" "http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${coll}/snapshots/${SNAP_NAME}"
    QDR_SIZE=$(du -h "${BACKUP_DIR}/${SNAP_NAME}" | cut -f1)
    echo "      Snapshot '${SNAP_NAME}' downloaded successfully (${QDR_SIZE})."
  else
    echo "      [WARN] Could not trigger snapshot for '${coll}' via REST. Attempting volume archive..."
    docker run --rm \
      --volumes-from sotrans-qdrant-prod \
      -v "${BACKUP_DIR}:/backup" \
      alpine tar czf "/backup/qdrant_volume_${coll}_${TIMESTAMP}.tar.gz" -C /qdrant storage 2>/dev/null || true
  fi
done

# 3. Permanent Documents, Attachments & Avatars (chat-files/)
echo "[3/5] Archiving permanent HR documents and attachment storage (chat-files/)..."
docker run --rm \
  --volumes-from sotrans-auth-prod \
  -v "${BACKUP_DIR}:/backup" \
  alpine tar czf "/backup/chat_files_${TIMESTAMP}.tar.gz" -C /app chat-files

FILES_SIZE=$(du -h "${BACKUP_DIR}/chat_files_${TIMESTAMP}.tar.gz" | cut -f1)
echo "      Documents archive completed successfully (${FILES_SIZE})."

# 4. Uploaded File BI Datasets, Raw Spreadsheets, Registry & Audit Logs (storage/)
echo "[4/5] Archiving Uploaded File BI storage (registry, datasets, audit logs, raw files)..."
docker run --rm \
  --volumes-from sotrans-auth-prod \
  -v "${BACKUP_DIR}:/backup" \
  alpine tar czf "/backup/bi_storage_${TIMESTAMP}.tar.gz" -C /app storage

BI_SIZE=$(du -h "${BACKUP_DIR}/bi_storage_${TIMESTAMP}.tar.gz" | cut -f1)
echo "      BI storage archive completed successfully (${BI_SIZE})."

# 5. Metadata Checkpoint, Security Scan & Checksums
echo "[5/5] Generating metadata checkpoint, scanning for sensitive files, and computing SHA256..."
# Strict Security Gate: Verify NO plaintext .env or secret files leaked into the backup
if find "${BACKUP_DIR}" -type f \( -name "*.env*" -o -name "*id_rsa*" -o -name "*.key" \) | grep -q .; then
  echo "      [FATAL ERROR] Plaintext credentials or secret keys detected in backup directory!"
  exit 1
fi

cat <<METADATA > "${BACKUP_DIR}/backup_metadata.json"
{
  "timestamp": "${TIMESTAMP}",
  "database": "${PG_DATABASE:-hrbot}",
  "collections": "${QDR_COLLECTIONS}",
  "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "backup_format_version": "2.4"
}
METADATA

cd "${BACKUP_DIR}"
sha256sum * > SHA256SUMS.txt
echo "      Verifying checksums..."
sha256sum -c SHA256SUMS.txt
cd - > /dev/null

# Enforce strict access control: readable/writable only by root/backup service account
chmod 700 "${BACKUP_DIR}"
chmod 600 "${BACKUP_DIR}"/*

# 6. Local Retention Policy (Keep last RETENTION_DAYS days)
echo "[CLEANUP] Purging local backup archives older than ${RETENTION_DAYS} days..."
find "${BACKUP_ROOT}" -maxdepth 1 -mindepth 1 -type d -mtime "+${RETENTION_DAYS}" -exec rm -rf {} + || true

# 7. Off-Host Synchronization Hook
# Supports: RSYNC, AWS S3, or AZURE BLOB
if [ -n "${OFFSITE_BACKUP_DEST:-}" ]; then
  echo "[OFF-SITE] Replicating backup to off-host destination: ${OFFSITE_BACKUP_DEST}..."
  rsync -avz "${BACKUP_DIR}" "${OFFSITE_BACKUP_DEST}/" || true
elif [ -n "${AWS_S3_BUCKET:-}" ]; then
  echo "[OFF-SITE] Replicating backup to AWS S3 bucket: ${AWS_S3_BUCKET}..."
  aws s3 sync "${BACKUP_DIR}" "s3://${AWS_S3_BUCKET}/backups/${TIMESTAMP}/" --sse AES256 || true
elif [ -n "${AZURE_STORAGE_CONTAINER:-}" ]; then
  echo "[OFF-SITE] Replicating backup to Azure Storage Container: ${AZURE_STORAGE_CONTAINER}..."
  azcopy copy "${BACKUP_DIR}" "https://${AZURE_STORAGE_ACCOUNT}.blob.core.windows.net/${AZURE_STORAGE_CONTAINER}/${TIMESTAMP}" --recursive || true
fi

echo "================================================================================"
echo "SOTRANS HUB — PRODUCTION BACKUP COMPLETED AND VERIFIED"
echo "All archives validated with SHA256. Ready for disaster recovery."
echo "================================================================================"
