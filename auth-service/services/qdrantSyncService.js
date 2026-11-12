const db = require('../db');
const http = require('http');
const { evaluateApprovalSafetyGate } = require('./approvalSafetyGate');

const QDRANT_HOST = process.env.QDRANT_HOST || (process.platform === 'win32' ? 'localhost' : 'qdrant');
const QDRANT_PORT = parseInt(process.env.QDRANT_PORT || '6333', 10);
const COLLECTION_NAME = process.env.QDRANT_COLLECTION || 'hr_docs';

function qdrantRequest(path, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: QDRANT_HOST,
        port: QDRANT_PORT,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        },
        timeout: 10000
      },
      res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(`Qdrant error ${res.statusCode}: ${raw}`));
            }
          } catch (e) {
            reject(new Error(`Qdrant parse error: ${e.message} (raw: ${raw})`));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Qdrant request timed out (10s)'));
    });

    req.on('error', reject);

    if (data) req.write(data);
    req.end();
  });
}

/**
 * Đồng bộ toàn bộ metadata của một phiên bản tài liệu từ PostgreSQL sang Qdrant Vector DB
 * @param {string} docVersionId UUID của phiên bản tài liệu
 */
async function syncDocumentToQdrant(docVersionId) {
  if (!docVersionId || !/^[0-9a-f-]{36}$/i.test(docVersionId)) {
    throw new Error(`doc_version_id không hợp lệ: ${docVersionId}`);
  }

  const query = `
    SELECT d.doc_version_id::text, d.document_id, d.version, d.title, d.doc_number, d.doc_type,
           d.document_family_id, d.doc_code, d.category, d.department_scope, d.business_unit_scope,
           d.location_scope, d.employee_group_scope,
           d.status::text, d.role_access, d.branch_scope, d.topics,
           COALESCE(to_char(d.effective_date, 'YYYYMMDD')::int, 20200101) AS effective_int,
           COALESCE(to_char(d.expiry_date, 'YYYYMMDD')::int, 99991231) AS expiry_int,
           rc.retrieval_mode, rc.is_restricted_general, rc.disclaimer_text, rc.is_active AS control_active
    FROM documents d
    LEFT JOIN document_retrieval_controls rc ON rc.doc_version_id = d.doc_version_id AND rc.is_active = TRUE
    WHERE d.doc_version_id = $1::uuid
  `;

  const res = await db.query(query, [docVersionId]);
  if (res.rows.length === 0) {
    console.warn(`[QDRANT SYNC] Không tìm thấy tài liệu ${docVersionId} trong PostgreSQL, bỏ qua đồng bộ.`);
    return { success: false, reason: 'not_found' };
  }

  const doc = res.rows[0];

  const payload = {
    title: doc.title,
    version: doc.version,
    doc_number: doc.doc_code || doc.doc_number || 's/n',
    doc_code: doc.doc_code || doc.doc_number || 's/n',
    document_family_id: doc.document_family_id || ('DOC-FAM-' + doc.document_id),
    category: doc.category || 'CHINH_SACH',
    status: doc.status,
    effective_int: doc.effective_int,
    expiry_int: doc.expiry_int,
    role_access: Array.isArray(doc.role_access) && doc.role_access.length > 0 ? doc.role_access : ['all'],
    branch_scope: Array.isArray(doc.branch_scope) && doc.branch_scope.length > 0 ? doc.branch_scope : ['all'],
    department_scope: Array.isArray(doc.department_scope) && doc.department_scope.length > 0 ? doc.department_scope : ['all'],
    business_unit_scope: Array.isArray(doc.business_unit_scope) && doc.business_unit_scope.length > 0 ? doc.business_unit_scope : ['all'],
    location_scope: Array.isArray(doc.location_scope) && doc.location_scope.length > 0 ? doc.location_scope : ['all'],
    employee_group_scope: Array.isArray(doc.employee_group_scope) && doc.employee_group_scope.length > 0 ? doc.employee_group_scope : ['all'],
    doc_type: doc.doc_type || 'Quy chế',
    topics: Array.isArray(doc.topics) ? doc.topics : [],
    retrieval_mode: (doc.control_active && doc.retrieval_mode) ? doc.retrieval_mode : 'standard',
    is_restricted_general: !!(doc.control_active && doc.is_restricted_general),
    disclaimer_text: (doc.control_active && doc.disclaimer_text) ? doc.disclaimer_text : ''
  };

  const body = {
    payload,
    filter: {
      must: [
        { key: 'doc_version_id', match: { value: docVersionId } }
      ]
    }
  };

  try {
    const result = await qdrantRequest(`/collections/${COLLECTION_NAME}/points/payload?wait=true`, 'POST', body);
    console.log(`[QDRANT SYNC] Đã đồng bộ tài liệu ${doc.document_id} v${doc.version} (${docVersionId}) -> status: ${doc.status}, family: ${payload.document_family_id}`);
    return { success: true, result };
  } catch (err) {
    console.error(`[QDRANT SYNC ERROR] Thất bại khi đồng bộ tài liệu ${docVersionId}:`, err.message);
    throw err;
  }
}

/**
 * Đếm số lượng điểm vector của một tài liệu trong Qdrant
 */
async function countQdrantPoints(docVersionId) {
  if (!docVersionId || !/^[0-9a-f-]{36}$/i.test(docVersionId)) return 0;
  try {
    const res = await qdrantRequest(`/collections/${COLLECTION_NAME}/points/scroll`, 'POST', {
      limit: 1000,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [
          { key: 'doc_version_id', match: { value: docVersionId } }
        ]
      }
    });
    return res?.result?.points?.length || 0;
  } catch (err) {
    console.error(`[QDRANT COUNT ERROR] Không thể đếm điểm cho ${docVersionId}:`, err.message);
    return 0;
  }
}

/**
 * Xóa vĩnh viễn các vector chunk của tài liệu khỏi Qdrant khi tài liệu bị hard-delete
 */
async function deleteDocumentFromQdrant(docVersionId) {
  if (!docVersionId || !/^[0-9a-f-]{36}$/i.test(docVersionId)) return;

  const body = {
    filter: {
      must: [
        { key: 'doc_version_id', match: { value: docVersionId } }
      ]
    }
  };

  try {
    const result = await qdrantRequest(`/collections/${COLLECTION_NAME}/points/delete?wait=true`, 'POST', body);
    console.log(`[QDRANT SYNC] Đã xóa toàn bộ điểm vector của tài liệu ${docVersionId} khỏi Qdrant.`);
    return { success: true, result };
  } catch (err) {
    console.error(`[QDRANT SYNC ERROR] Thất bại khi xóa điểm vector ${docVersionId}:`, err.message);
  }
}

/**
 * Reconciler phát hiện và xử lý generation bị treo, thiếu/dư vectors và chunks chưa publish
 */
async function reconcileGenerationsAndVectors() {
  const report = {
    timestamp: new Date().toISOString(),
    hung_leases_reclaimed: 0,
    unpublished_chunks_cleaned: 0,
    orphan_vectors_purged: 0,
    documents_audited: 0,
    inconsistencies_detected: []
  };

  try {
    // 1. Kiểm tra bảng document_retry_leases tồn tại
    const tableCheck = await db.query(`
      SELECT 1 FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'document_retry_leases'
    `);
    if (tableCheck.rows.length === 0) {
      return report;
    }

    // 2. Thu hồi các Lease bị treo (status = 'PROCESSING' và đã quá expires_at)
    const hungLeases = await db.query(`
      SELECT doc_version_id, generation_id, fencing_token, acquired_by, expires_at
      FROM document_retry_leases
      WHERE status = 'PROCESSING' AND expires_at < NOW()
    `);

    for (const lease of hungLeases.rows) {
      console.log(`[RECONCILER] Phát hiện Lease bị treo của doc ${lease.doc_version_id} (gen: ${lease.generation_id}). Tiến hành thu hồi...`);
      await db.query(`
        UPDATE document_retry_leases
        SET status = 'EXPIRED',
            retry_reason = 'Lease expired without publication - reclaimed by background reconciler',
            updated_at = NOW()
        WHERE doc_version_id = $1 AND fencing_token = $2
      `, [lease.doc_version_id, lease.fencing_token]);

      // Xóa các chunk chưa được publish gắn với generation bị treo
      const cleanChunks = await db.query(`
        DELETE FROM chunks
        WHERE doc_version_id = $1 AND is_published = FALSE
      `, [lease.doc_version_id]);

      report.hung_leases_reclaimed++;
      report.unpublished_chunks_cleaned += cleanChunks.rowCount || 0;
    }

    // 3. Dọn dẹp các chunk chưa publish gắn với lease failed hoặc expired
    const staleUnpublished = await db.query(`
      DELETE FROM chunks
      WHERE is_published = FALSE
        AND doc_version_id IN (
          SELECT doc_version_id FROM document_retry_leases WHERE status IN ('FAILED', 'EXPIRED')
        )
    `);
    report.unpublished_chunks_cleaned += staleUnpublished.rowCount || 0;

    // 4. Đối soát số lượng Vector trong Qdrant với Chunks trong PostgreSQL cho tất cả tài liệu Active
    const activeDocs = await db.query(`
      SELECT d.doc_version_id, d.doc_code, d.active_generation_id,
             COUNT(c.chunk_id)::int AS chunk_count,
             ARRAY_AGG(c.chunk_id::text) AS chunk_ids
      FROM documents d
      LEFT JOIN chunks c ON c.doc_version_id = d.doc_version_id AND c.is_published = TRUE
      WHERE d.status = 'active'
      GROUP BY d.doc_version_id, d.doc_code, d.active_generation_id
    `);

    report.documents_audited = activeDocs.rows.length;

    for (const doc of activeDocs.rows) {
      const qdrantCount = await countQdrantPoints(doc.doc_version_id);
      const pgCount = doc.chunk_count || 0;

      if (qdrantCount !== pgCount) {
        console.warn(`[RECONCILER] Phát hiện lệch vector cho doc ${doc.doc_code}: PG chunks = ${pgCount}, Qdrant points = ${qdrantCount}`);
        report.inconsistencies_detected.push({
          doc_code: doc.doc_code,
          doc_version_id: doc.doc_version_id,
          pg_chunks: pgCount,
          qdrant_points: qdrantCount
        });

        // Nếu Qdrant có vector thừa không thuộc chunk_ids hiện hành của generation đang active
        if (qdrantCount > pgCount && doc.chunk_ids && doc.chunk_ids.length > 0) {
          try {
            const scrollRes = await qdrantRequest(`/collections/${COLLECTION_NAME}/points/scroll`, 'POST', {
              limit: 500,
              with_payload: true,
              with_vector: false,
              filter: {
                must: [{ key: 'doc_version_id', match: { value: doc.doc_version_id } }]
              }
            });
            const validSet = new Set(doc.chunk_ids.filter(Boolean));
            const orphanPointIds = (scrollRes?.result?.points || [])
              .map(p => p.id)
              .filter(id => !validSet.has(id));

            if (orphanPointIds.length > 0) {
              await qdrantRequest(`/collections/${COLLECTION_NAME}/points/delete?wait=true`, 'POST', {
                points: orphanPointIds
              });
              report.orphan_vectors_purged += orphanPointIds.length;
              console.log(`[RECONCILER] Đã dọn dẹp ${orphanPointIds.length} vector dư thừa của ${doc.doc_code} khỏi Qdrant.`);
            }
          } catch (cleanErr) {
            console.error(`[RECONCILER] Lỗi dọn vector dư thừa cho ${doc.doc_code}:`, cleanErr.message);
          }
        }
      }
    }

    console.log(`[RECONCILER] Hoàn tất đối soát: ${report.hung_leases_reclaimed} lease treo, ${report.unpublished_chunks_cleaned} chunks rác, ${report.orphan_vectors_purged} vector dư.`);
    return report;
  } catch (err) {
    console.error('[RECONCILER FATAL ERROR]:', err.message);
    report.error = err.message;
    return report;
  }
}

/**
 * PHASE 4.1A: Tự động kích hoạt các văn bản ở trạng thái 'scheduled' đã đến ngày hiệu lực (effective_date <= CURRENT_DATE)
 * Tuân thủ nghiêm ngặt Approval Safety Gate (Fail-Closed, Zero-Bypass):
 * - LOW: Kích hoạt tự động, supersede bản cũ, sync Qdrant, ghi Audit Log
 * - MEDIUM: Không kích hoạt tự động, giữ scheduled, ghi Audit Log cảnh báo chờ ADMIN thẩm định
 * - HIGH: Chặn kích hoạt, giữ scheduled, ghi Audit Log chi tiết xung đột quy chuẩn
 * - Fail-Closed: Giao dịch rollback an toàn nếu lỗi Gate/Conflict Engine
 */
async function autoActivateDueDocuments() {
  try {
    const dueRes = await db.query(`
      SELECT doc_version_id, document_id, document_family_id, effective_date, version, title
      FROM documents
      WHERE status = 'scheduled' AND effective_date <= CURRENT_DATE
    `);

    if (dueRes.rows.length === 0) return { activated: 0, blocked_medium: 0, blocked_high: 0 };

    console.log(`[AUTO ACTIVATE] Phát hiện ${dueRes.rows.length} văn bản đến hạn hiệu lực. Kiểm tra Safety Gate...`);

    let activatedCount = 0;
    let blockedMediumCount = 0;
    let blockedHighCount = 0;

    for (const d of dueRes.rows) {
      const client = await db.getClient();
      try {
        await client.query('BEGIN');

        // Khóa bi quan hàng văn bản để tránh race condition
        const freshDocRes = await client.query(
          'SELECT * FROM documents WHERE doc_version_id = $1 FOR UPDATE',
          [d.doc_version_id]
        );

        if (freshDocRes.rows.length === 0 || freshDocRes.rows[0].status !== 'scheduled') {
          await client.query('ROLLBACK');
          continue;
        }

        const freshDoc = freshDocRes.rows[0];

        // Khóa Advisory Lock theo domain/mã văn bản
        const domainsToLock = [freshDoc.document_id, freshDoc.document_family_id, freshDoc.doc_code].filter(Boolean);
        const sortedDomains = Array.from(new Set(domainsToLock)).sort();
        for (const dom of sortedDomains) {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`conflict_domain:${dom}`]);
        }

        // Tải quan hệ văn bản đã được phê duyệt
        const relRes = await client.query(`
          SELECT r.*, 
                 sd.doc_code as source_code, td.doc_code as target_code
          FROM document_relationships r
          JOIN documents sd ON r.source_doc_version_id = sd.doc_version_id
          JOIN documents td ON r.target_doc_version_id = td.doc_version_id
          WHERE (r.source_doc_version_id = $1 OR r.target_doc_version_id = $1)
            AND r.approval_status = 'approved'
        `, [freshDoc.doc_version_id]);
        const confirmedRelationships = relRes.rows || [];

        // Thẩm định bằng Safety Gate trung tâm (Fail-Closed)
        const gateResult = await evaluateApprovalSafetyGate(freshDoc, {}, client, confirmedRelationships);

        if (!gateResult.passed) {
          await client.query('ROLLBACK');

          const isHigh = gateResult.risk_level === 'HIGH';
          const auditAction = isHigh ? 'SCHEDULED_ACTIVATION_BLOCKED_HIGH_CONFLICT' : 'SCHEDULED_ACTIVATION_BLOCKED_WARNING';
          const auditReason = isHigh
            ? `Chặn kích hoạt tự động do phát hiện mâu thuẫn chính sách nghiêm trọng (HIGH): ${gateResult.error || 'Xung đột quy chuẩn'}`
            : `Tạm dừng kích hoạt tự động: Phát hiện ${gateResult.warnings?.length || 0} cảnh báo MEDIUM cần ADMIN thẩm tra và xác nhận thủ công.`;

          // Ghi nhận Audit Log (kiểm tra chống trùng lặp trong 1 giờ)
          const recentLog = await db.query(
            `SELECT id FROM document_audit_logs WHERE doc_version_id = $1 AND action = $2 AND created_at > now() - interval '1 hour'`,
            [freshDoc.doc_version_id, auditAction]
          );

          if (recentLog.rows.length === 0) {
            await db.query(`
              INSERT INTO document_audit_logs (doc_version_id, document_id, action, actor_user_id, actor_username, actor_role, actor_company, status_before, status_after, reason, detail)
              VALUES ($1, $2, $3, NULL, 'system_scheduler', 'SYSTEM', $4, 'scheduled', 'scheduled', $5, $6)
            `, [
              freshDoc.doc_version_id, freshDoc.document_id, auditAction,
              freshDoc.company_id || 'SYSTEM', auditReason,
              JSON.stringify({
                risk_level: gateResult.risk_level,
                code: gateResult.code,
                conflict_type: gateResult.conflict_type,
                blocking_conflicts: gateResult.blocking_conflicts || [],
                warnings: gateResult.warnings || [],
                scan_timestamp: new Date().toISOString()
              })
            ]);
          }

          if (isHigh) {
            blockedHighCount++;
            console.error(`[AUTO ACTIVATE BLOCKED - HIGH] Chặn kích hoạt văn bản "${freshDoc.title}" (${freshDoc.doc_code || freshDoc.document_id}): ${gateResult.error}`);
          } else {
            blockedMediumCount++;
            console.warn(`[AUTO ACTIVATE BLOCKED - MEDIUM] Tạm dừng kích hoạt văn bản "${freshDoc.title}" (${freshDoc.doc_code || freshDoc.document_id}) chờ xác nhận.`);
          }
          continue;
        }

        // RISK LOW: Đủ điều kiện kích hoạt tự động an toàn
        const familyId = freshDoc.document_family_id || ('DOC-FAM-' + freshDoc.document_id);

        // Supersede các phiên bản cũ
        await client.query(`
          UPDATE documents
          SET status = 'superseded', expiry_date = $1::date - 1
          WHERE document_family_id = $2 AND status = 'active' AND doc_version_id <> $3
        `, [freshDoc.effective_date, familyId, freshDoc.doc_version_id]);

        await client.query(`
          UPDATE documents
          SET status = 'superseded', expiry_date = $1::date - 1
          WHERE doc_version_id IN (
            SELECT target_doc_version_id FROM document_relationships
            WHERE source_doc_version_id = $2 AND relation_type = 'supersedes' AND approval_status = 'approved'
          ) AND status = 'active'
        `, [freshDoc.effective_date, freshDoc.doc_version_id]);

        await client.query(`
          UPDATE documents
          SET status = 'active'
          WHERE doc_version_id = $1
        `, [freshDoc.doc_version_id]);

        // Ghi Audit Log kích hoạt thành công
        await client.query(`
          INSERT INTO document_audit_logs (doc_version_id, document_id, action, actor_user_id, actor_username, actor_role, actor_company, status_before, status_after, reason, detail)
          VALUES ($1, $2, 'SCHEDULED_AUTO_ACTIVATE', NULL, 'system_scheduler', 'SYSTEM', $3, 'scheduled', 'active', 'Tự động kích hoạt văn bản đến hạn hiệu lực (Safety Gate: LOW)', $4)
        `, [
          freshDoc.doc_version_id, freshDoc.document_id, freshDoc.company_id || 'SYSTEM',
          JSON.stringify({
            risk_level: 'LOW',
            effective_date: freshDoc.effective_date,
            scan_timestamp: new Date().toISOString()
          })
        ]);

        await client.query('COMMIT');

        // Đồng bộ vector Qdrant
        await syncDocumentToQdrant(freshDoc.doc_version_id).catch(() => {});

        // Đồng bộ văn bản cùng nhóm bị superseded sang Qdrant nếu có
        db.query(
          `SELECT doc_version_id FROM documents WHERE (document_id = $1 OR document_family_id = $2) AND status = 'superseded' AND doc_version_id <> $3`,
          [freshDoc.document_id, familyId, freshDoc.doc_version_id]
        ).then(supRes => {
          for (const sRow of supRes.rows) {
            syncDocumentToQdrant(sRow.doc_version_id).catch(() => {});
          }
        }).catch(() => {});

        console.log(`[AUTO ACTIVATE] Đã tự động kích hoạt văn bản "${freshDoc.title}" (v${freshDoc.version}) sang 'active'.`);
        activatedCount++;
      } catch (docErr) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[AUTO ACTIVATE ERROR] Lỗi khi xử lý văn bản ${d.doc_version_id}:`, docErr.message);
      } finally {
        client.release();
      }
    }

    return {
      activated: activatedCount,
      blocked_medium: blockedMediumCount,
      blocked_high: blockedHighCount
    };
  } catch (err) {
    console.error('[AUTO ACTIVATE ERROR]', err.message);
    return { activated: 0, error: err.message };
  }
}

/**
 * Đồng bộ đối soát toàn diện tất cả các tài liệu từ PostgreSQL sang Qdrant
 */
async function syncAllDocumentsToQdrant() {
  try {
    // 1. Tự động kích hoạt các văn bản chờ hiệu lực đã đến ngày
    await autoActivateDueDocuments();
    const query = `
      SELECT doc_version_id::text, document_id, version, title, doc_number, doc_type,
             document_family_id, doc_code, category, department_scope, business_unit_scope,
             location_scope, employee_group_scope,
             status::text, role_access, branch_scope, topics,
             COALESCE(to_char(effective_date, 'YYYYMMDD')::int, 20200101) AS effective_int,
             COALESCE(to_char(expiry_date, 'YYYYMMDD')::int, 99991231) AS expiry_int
      FROM documents
      ORDER BY created_at ASC
    `;
    const res = await db.query(query);
    console.log(`[QDRANT RECONCILE] Bắt đầu đối soát và đồng bộ ${res.rows.length} tài liệu...`);

    let updatedCount = 0;
    for (const doc of res.rows) {
      try {
        const payload = {
          title: doc.title,
          doc_number: doc.doc_code || doc.doc_number || 's/n',
          doc_code: doc.doc_code || doc.doc_number || 's/n',
          document_family_id: doc.document_family_id || ('DOC-FAM-' + doc.document_id),
          category: doc.category || 'CHINH_SACH',
          status: doc.status,
          effective_int: doc.effective_int,
          expiry_int: doc.expiry_int,
          role_access: Array.isArray(doc.role_access) && doc.role_access.length > 0 ? doc.role_access : ['all'],
          branch_scope: Array.isArray(doc.branch_scope) && doc.branch_scope.length > 0 ? doc.branch_scope : ['all'],
          department_scope: Array.isArray(doc.department_scope) && doc.department_scope.length > 0 ? doc.department_scope : ['all'],
          business_unit_scope: Array.isArray(doc.business_unit_scope) && doc.business_unit_scope.length > 0 ? doc.business_unit_scope : ['all'],
          location_scope: Array.isArray(doc.location_scope) && doc.location_scope.length > 0 ? doc.location_scope : ['all'],
          employee_group_scope: Array.isArray(doc.employee_group_scope) && doc.employee_group_scope.length > 0 ? doc.employee_group_scope : ['all'],
          doc_type: doc.doc_type || 'Quy chế',
          topics: Array.isArray(doc.topics) ? doc.topics : []
        };

        const body = {
          payload,
          filter: {
            must: [
              { key: 'doc_version_id', match: { value: doc.doc_version_id } }
            ]
          }
        };

        await qdrantRequest(`/collections/${COLLECTION_NAME}/points/payload?wait=true`, 'POST', body);
        updatedCount++;
      } catch (err) {
        console.error(`[QDRANT RECONCILE ERROR] Lỗi tài liệu ${doc.document_id} (${doc.doc_version_id}):`, err.message);
      }
    }

    console.log(`[QDRANT RECONCILE] Hoạt tất đối soát: ${updatedCount}/${res.rows.length} tài liệu đã đồng bộ chuẩn xác.`);

    // 2. Chạy đối soát tính nhất quán Generation và Vector (Reconcile Hung Leases & Consistency)
    const genReport = await reconcileGenerationsAndVectors().catch(e => {
      console.error('[QDRANT RECONCILE GEN ERROR]:', e.message);
      return null;
    });

    return { success: true, total: res.rows.length, updated: updatedCount, generation_reconcile: genReport };
  } catch (err) {
    console.error('[QDRANT RECONCILE FATAL]', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Khởi động tiến trình tự động đối soát định kỳ (mặc định mỗi 60 phút) và khi khởi động service
 */
function startPeriodicReconciliation(intervalMinutes = 60) {
  // Chạy lần đầu sau 5 giây khi server khởi động
  setTimeout(() => {
    syncAllDocumentsToQdrant().catch(e => console.error('[QDRANT AUTO INIT]', e.message));
  }, 5000);

  // Lặp lại định kỳ
  const ms = Math.max(5, intervalMinutes) * 60 * 1000;
  setInterval(() => {
    syncAllDocumentsToQdrant().catch(e => console.error('[QDRANT AUTO CRON]', e.message));
  }, ms);

  // Quét và kích hoạt tự động văn bản scheduled đến hạn mỗi 60 giây
  setInterval(() => {
    autoActivateDueDocuments().catch(e => console.error('[AUTO ACTIVATE CRON]', e.message));
  }, 60000);

  console.log(`⏱️ Qdrant Sync Service: Đã kích hoạt tiến trình tự động đối soát mỗi ${intervalMinutes} phút và tự động kích hoạt văn bản mỗi 60 giây.`);
}

module.exports = {
  syncDocumentToQdrant,
  deleteDocumentFromQdrant,
  countQdrantPoints,
  reconcileGenerationsAndVectors,
  syncAllDocumentsToQdrant,
  autoActivateDueDocuments,
  startPeriodicReconciliation
};
