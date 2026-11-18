'use strict';

/**
 * SOTRANS HUB — DATASET REGISTRY RECONCILIATION SCRIPT (TASK S5)
 * 
 * Safely reconciles datasets_registry.json against physical disk files:
 * - Default: --dry-run (non-destructive audit)
 * - --apply requires explicit --dir <target_dir>
 * - Hard safety guard: rejects production storage paths
 * - Transitions MISSING_DATA or physically missing files to ARCHIVED
 * - ZERO physical file deletions (never calls unlink)
 * - Detects and reports unindexed orphan files on disk
 */

const fs = require('fs');
const path = require('path');

// Parse CLI args
const args = process.argv.slice(2);
let isApply = false;
let targetDir = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') isApply = true;
  if (args[i] === '--dry-run') isApply = false;
  if (args[i] === '--dir' && args[i + 1]) {
    targetDir = path.resolve(args[i + 1]);
    i++;
  }
}

if (!targetDir) {
  console.error('Usage: node scripts/reconcile_dataset_registry.js --dir <storage_directory> [--apply]');
  console.error('Note: Default mode is --dry-run. Use --apply to execute changes.');
  process.exit(1);
}

// 1. HARD SAFETY GUARD — Prohibit running on production storage
const normalizedTarget = targetDir.toLowerCase().replace(/\\/g, '/');
if (
  normalizedTarget.startsWith('d:/hoso-chat/storage') ||
  normalizedTarget.startsWith('d:/hoso-chat/auth-service/storage')
) {
  console.error(`[FATAL SAFETY GUARD] Operation forbidden on production directory: ${targetDir}`);
  process.exit(101);
}

const registryFile = path.join(targetDir, 'datasets_registry.json');
if (!fs.existsSync(registryFile)) {
  console.error(`Registry file not found at: ${registryFile}`);
  process.exit(1);
}

console.log('================================================================');
console.log('SOTRANS HUB — BI DATASET REGISTRY RECONCILIATION UTILITY');
console.log(`Target Storage: ${targetDir}`);
console.log(`Execution Mode: ${isApply ? 'APPLY (Modifications Enabled)' : 'DRY RUN (Audit Only)'}`);
console.log('================================================================\n');

// Read current registry
let registryData;
try {
  registryData = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  if (!Array.isArray(registryData)) throw new Error('Registry root is not an array');
} catch (e) {
  console.error(`Failed to read registry: ${e.message}`);
  process.exit(1);
}

// Scan storage directory files
const diskFiles = fs.readdirSync(targetDir);
const diskDatasetFiles = new Set(
  diskFiles.filter((f) => f.endsWith('.dataset.json')).map((f) => f.replace('.dataset.json', ''))
);

console.log(`Total registry entries: ${registryData.length}`);
console.log(`Physical .dataset.json files on disk: ${diskDatasetFiles.size}\n`);

// 2. Reconcile Registry Entries
let readyCount = 0;
let missingDataCount = 0;
let archivedCount = 0;
let updatedToArchived = 0;
const reconciledRegistry = [];
const statusTransitions = [];

for (const entry of registryData) {
  const fileId = entry.file_id;
  const hasPhysicalFile = diskDatasetFiles.has(fileId);
  const currentStatus = entry.processing_status || 'UNKNOWN';

  if (currentStatus === 'READY' && hasPhysicalFile) {
    readyCount++;
    reconciledRegistry.push(entry);
  } else if (currentStatus === 'MISSING_DATA' || (currentStatus === 'READY' && !hasPhysicalFile)) {
    missingDataCount++;
    updatedToArchived++;
    const updatedEntry = {
      ...entry,
      processing_status: 'ARCHIVED',
      previous_status: currentStatus,
      archived_at: new Date().toISOString(),
      archive_reason: 'PHYSICAL_FILE_MISSING',
    };
    statusTransitions.push({
      file_id: fileId,
      filename: entry.original_filename || 'unknown',
      company_id: entry.company_id || 'UNKNOWN',
      from: currentStatus,
      to: 'ARCHIVED',
      reason: 'Physical .dataset.json missing on disk',
    });
    reconciledRegistry.push(updatedEntry);
  } else if (currentStatus === 'ARCHIVED') {
    archivedCount++;
    reconciledRegistry.push(entry);
  } else {
    // Keep other statuses (e.g. PROCESSING, UPLOADED) intact
    reconciledRegistry.push(entry);
  }
}

// 3. Detect Orphan Physical Files (files on disk not in registry)
const registryFileIds = new Set(registryData.map((d) => d.file_id));
const orphanFiles = [];

for (const fileId of diskDatasetFiles) {
  if (!registryFileIds.has(fileId)) {
    const filename = `${fileId}.dataset.json`;
    const fullPath = path.join(targetDir, filename);
    const stat = fs.statSync(fullPath);
    orphanFiles.push({
      file_id: fileId,
      filename,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    });
  }
}

// 4. Output Summary Report
console.log('--- RECONCILIATION AUDIT RESULTS ---');
console.log(`- Operational READY datasets (verified with physical files): ${readyCount}`);
console.log(`- Entries transitioned to ARCHIVED: ${updatedToArchived}`);
console.log(`- Existing ARCHIVED entries: ${archivedCount}`);
console.log(`- Unindexed orphan physical files detected: ${orphanFiles.length}\n`);

if (statusTransitions.length > 0) {
  console.log('Status Transitions:');
  console.table(statusTransitions);
}

if (orphanFiles.length > 0) {
  console.log('\nUnindexed Orphan Files on Disk (ZERO deletion performed):');
  console.table(orphanFiles);
}

// 5. Apply changes if requested
if (isApply) {
  if (updatedToArchived > 0) {
    // Rotating backup before applying
    const bakFile = `${registryFile}.reconcile_bak_${Date.now()}`;
    fs.copyFileSync(registryFile, bakFile);
    fs.writeFileSync(registryFile, JSON.stringify(reconciledRegistry, null, 2), 'utf8');
    console.log(`\n[APPLY SUCCESS] Registry updated with ${updatedToArchived} entries transitioned to ARCHIVED.`);
    console.log(`Backup saved to: ${bakFile}`);
  } else {
    console.log('\n[APPLY] No entries needed reconciliation. Registry untouched.');
  }
} else {
  console.log('\n[DRY RUN COMPLETE] Zero changes applied. Re-run with --apply to persist changes.');
}
