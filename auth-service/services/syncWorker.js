const db = require('../db');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { reconcileEmployees } = require('./reconciliationService');
const { getGoogleAccessToken, GOOGLE_SA, GOOGLE_SPREADSHEET_ID } = require('./googleAuthHelper');

const COLUMNS = [
  'job_grade', 'employee_id', 'full_name', 'date_of_birth', 'gender',
  'job_title', 'professional_title', 'department_staffing_plan', 'section_staffing_plan',
  'citizen_id', 'citizen_id_issue_date', 'citizen_id_issue_place', 'birth_registration_place',
  'place_of_origin', 'permanent_address', 'temporary_address', 'current_address',
  'ethnicity', 'education_level', 'education_code', 'qualification',
  'professional_qualification', 'specialization', 'degree_qualification',
  'training_institution', 'major', 'training_mode', 'training_period',
  'graduation_grade', 'degree_valid_until', 'other_professional_certificates',
  'social_insurance_salary', 'total_income', 'base_salary',
  'productivity_responsibility_pay', 'attendance_bonus', 'responsibility_allowance',
  'vessel_size_allowance', 'professional_allowance_t1', 'meal_allowance', 'other_allowances',
  'open_ended_contract', 'fixed_term_contract', 'seasonal_contract',
  'contract_start_date', 'contract_end_date', 'recruitment_decision_no',
  'employment_start_date', 'official_labor_contract_sign_date', 'phone_number', 'email', 'Create_Time', 'file_name', 'uploaded_by'
];

/**
 * Service: Idempotent Background Sync Worker for NocoDB & Google Sheets
 */
async function processSyncTask(taskId) {
  let task = null;
  try {
    const taskRes = await db.query(
      `SELECT t.*, s.full_name AS staging_full_name, s.citizen_id AS staging_citizen_id, 
              s.employee_code AS staging_employee_code, s.company_id AS staging_company_id, 
              s.extracted_data, s.file_name AS staging_file_name, s.uploaded_by AS staging_uploaded_by
       FROM hr_sync_tasks t
       LEFT JOIN hr_employee_staging s ON t.staging_id = s.id
       WHERE t.id = $1 FOR UPDATE OF t`,
      [taskId]
    );

    if (taskRes.rows.length === 0) return;
    task = taskRes.rows[0];
    if (task.status === 'success' || task.status === 'completed') return; // Idempotent check

    await db.query(
      `UPDATE hr_sync_tasks SET status = 'processing', updated_at = NOW() WHERE id = $1`,
      [taskId]
    );

    const pData = task.payload || {};
    let empCode = task.staging_employee_code || pData.employee_code || pData.employee_id;
    let citizenId = task.staging_citizen_id || pData.citizen_id;
    let compId = task.staging_company_id || pData.company_id;
    let fullName = task.staging_full_name || pData.employee_name || pData.full_name;

    // Nếu tác vụ được đẩy trực tiếp từ employee_id, đọc thêm từ bảng employees
    if (task.employee_id) {
      try {
        const empRes = await db.query('SELECT * FROM employees WHERE id = $1', [task.employee_id]);
        if (empRes.rows.length > 0) {
          const emp = empRes.rows[0];
          empCode = empCode || emp.employee_code;
          citizenId = citizenId || emp.citizen_id;
          compId = compId || emp.company_id;
          fullName = fullName || emp.employee_name;
        }
      } catch (e) {}
    }

    // Fetch latest official profile if exists to ensure complete and accurate fields
    let officialProfile = {};
    try {
      const profRes = await db.query(
        `SELECT * FROM hr_employee_profiles 
         WHERE (citizen_id IS NOT NULL AND citizen_id <> '' AND citizen_id = $1)
            OR (employee_id IS NOT NULL AND employee_id <> '' AND employee_id = $2)
         ORDER BY id DESC LIMIT 1`,
        [citizenId || '', empCode || '']
      );
      if (profRes.rows.length > 0) {
        officialProfile = profRes.rows[0];
      }
    } catch (e) {}

    const payload = {
      ...(task.extracted_data || {}),
      ...officialProfile,
      ...pData,
      action_type: task.action_type || 'UPSERT',
      full_name: fullName || officialProfile.full_name,
      citizen_id: citizenId || officialProfile.citizen_id,
      employee_id: empCode || officialProfile.employee_id || officialProfile.employee_code,
      company_id: compId || officialProfile.company_id,
      job_title: pData.job_title || pData.position || officialProfile.position || officialProfile.job_title || '',
      department_staffing_plan: pData.department_staffing_plan || pData.department || officialProfile.department || officialProfile.department_staffing_plan || '',
      email: pData.email || officialProfile.email || '',
      file_name: task.staging_file_name || pData.file_name || officialProfile.file_name,
      uploaded_by: officialProfile.uploaded_by || task.staging_uploaded_by || pData.uploaded_by || ''
    };

    if (task.target_system === 'nocodb') {
      // NocoDB connects directly to PostgreSQL as the System of Record
      await syncToNocoDB(payload);
      await db.query(
        `UPDATE hr_sync_tasks SET status = 'completed', nocodb_succeeded_at = NOW(), completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [taskId]
      );
    } else if (task.target_system === 'google_sheets') {
      // Sync to Google Sheets via Google Sheets API v4 (sequential queue with lock)
      await syncToGoogleSheetsWithLock(payload);
      await db.query(
        `UPDATE hr_sync_tasks SET status = 'completed', sheets_succeeded_at = NOW(), completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [taskId]
      );
    } else if (task.target_system === 'sequential_noco_sheets') {
      // 1. Sync to NocoDB
      await db.query(`UPDATE hr_sync_tasks SET status = 'processing_nocodb', nocodb_started_at = NOW(), updated_at = NOW() WHERE id = $1`, [taskId]);
      await syncToNocoDB(payload);
      await db.query(`UPDATE hr_sync_tasks SET status = 'pending_sheets', nocodb_succeeded_at = NOW(), updated_at = NOW() WHERE id = $1`, [taskId]);

      // 2. Sync to Google Sheets
      await db.query(`UPDATE hr_sync_tasks SET status = 'processing_sheets', sheets_started_at = NOW(), updated_at = NOW() WHERE id = $1`, [taskId]);
      await syncToGoogleSheetsWithLock(payload);
      await db.query(`UPDATE hr_sync_tasks SET status = 'completed', sheets_succeeded_at = NOW(), completed_at = NOW(), updated_at = NOW() WHERE id = $1`, [taskId]);
    }
  } catch (err) {
    let errorCode = 'SYNC_ERROR';
    if (err.code && typeof err.code === 'string') {
      if (err.code.startsWith('23')) errorCode = 'CONSTRAINT_ERROR';
      else if (err.code.startsWith('42') || err.code.startsWith('08')) errorCode = 'SQL_ERROR';
      else errorCode = err.code;
    } else if (err.message) {
      if (err.message.includes('ECONNREFUSED') || err.message.includes('ETIMEDOUT') || err.message.includes('ENOTFOUND') || err.message.includes('503')) {
        errorCode = 'CONNECTION_ERROR';
      } else if (err.message.includes('Mapping error') || err.message.includes('MAPPING')) {
        errorCode = 'MAPPING_ERROR';
      } else if (err.message.includes('Sheets')) {
        errorCode = 'SHEETS_API_ERROR';
      } else if (err.message.includes('NocoDB') || err.message.includes('VERIFICATION')) {
        errorCode = 'NOCODB_SYNC_ERROR';
      }
    }

    console.error(`[SYNC WORKER ERROR] Task ${taskId} (${task?.target_system || 'unknown'}) [${errorCode}]:`, err.message);
    await db.query(
      `UPDATE hr_sync_tasks 
       SET status = CASE WHEN retry_count + 1 >= max_retries THEN 'failed' ELSE 'pending' END,
           retry_count = retry_count + 1,
           last_retry_at = NOW(),
           error_code = $2,
           last_error = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [taskId, errorCode, err.message]
    );
  }
}

/**
 * Sync to NocoDB:
 * NocoDB connects directly to PostgreSQL hr_employee_profiles (System of Record).
 * This function performs strict UPSERT / SOFT_DELETE / RESIGNED / RESTORE operations,
 * validates against PostgreSQL constraints, and verifies post-write persistence.
 */
async function syncToNocoDB(payload) {
  if (process.env.SIMULATE_NOCODB_UNAVAILABLE === 'true' || payload._simulate_nocodb_error === true || payload._simulate_nocodb_error === 'true') {
    const err = new Error('NocoDB connection refused: Service unavailable (simulated 503)');
    err.code = 'CONNECTION_ERROR';
    throw err;
  }

  const empCode = payload.employee_id || payload.employee_code;
  const citizenId = payload.citizen_id;

  if (!empCode && !citizenId) {
    const err = new Error('Mapping error: Neither employee_id nor citizen_id provided for NocoDB sync');
    err.code = 'MAPPING_ERROR';
    throw err;
  }

  const action = (payload.action_type || 'UPSERT').toUpperCase();

  if (action === 'RESTORE') {
    const res = await db.query(
      `UPDATE hr_employee_profiles
       SET status = 'ACTIVE',
           job_grade = '',
           full_name = REPLACE(REPLACE(full_name, ' [ĐÃ XÓA]', ''), ' [NGHỈ VIỆC]', ''),
           updated_at = NOW()
       WHERE (employee_id IS NOT NULL AND employee_id <> '' AND employee_id = $1)
          OR (citizen_id IS NOT NULL AND citizen_id <> '' AND citizen_id = $2)
       RETURNING id`,
      [empCode || '', citizenId || '']
    );
    if (res.rowCount === 0) {
      throw new Error(`[POST-WRITE VERIFICATION FAILED] Profile not found to RESTORE for ${empCode || citizenId}`);
    }
  } else if (action === 'SOFT_DELETE') {
    const res = await db.query(
      `UPDATE hr_employee_profiles
       SET status = 'DELETED',
           job_grade = '[ĐÃ XÓA]',
           updated_at = NOW()
       WHERE (employee_id IS NOT NULL AND employee_id <> '' AND employee_id = $1)
          OR (citizen_id IS NOT NULL AND citizen_id <> '' AND citizen_id = $2)
       RETURNING id`,
      [empCode || '', citizenId || '']
    );
    if (res.rowCount === 0) {
      throw new Error(`[POST-WRITE VERIFICATION FAILED] Profile not found to SOFT_DELETE for ${empCode || citizenId}`);
    }
  } else if (action === 'RESIGNED') {
    const res = await db.query(
      `UPDATE hr_employee_profiles
       SET status = 'RESIGNED',
           job_grade = '[NGHỈ VIỆC]',
           resignation_date = COALESCE($3, resignation_date),
           resignation_reason = COALESCE($4, resignation_reason),
           contract_end_date = COALESCE($3, contract_end_date),
           updated_at = NOW()
       WHERE (employee_id IS NOT NULL AND employee_id <> '' AND employee_id = $1)
          OR (citizen_id IS NOT NULL AND citizen_id <> '' AND citizen_id = $2)
       RETURNING id`,
      [empCode || '', citizenId || '', payload.resignation_date || null, payload.resignation_reason || null]
    );
    if (res.rowCount === 0) {
      throw new Error(`[POST-WRITE VERIFICATION FAILED] Profile not found to mark RESIGNED for ${empCode || citizenId}`);
    }
  } else {
    // UPSERT / CREATE / UPDATE
    const checkRes = await db.query(
      `SELECT id, updated_at FROM hr_employee_profiles 
       WHERE (employee_id IS NOT NULL AND employee_id <> '' AND employee_id = $1)
          OR (citizen_id IS NOT NULL AND citizen_id <> '' AND citizen_id = $2)
       ORDER BY id DESC LIMIT 1`,
      [empCode || '', citizenId || '']
    );

    if (checkRes.rows.length > 0) {
      const existingId = checkRes.rows[0].id;
      const updateFields = [];
      const updateValues = [];
      let idx = 1;

      for (const rawCol of COLUMNS) {
        if (rawCol === 'Create_Time' || rawCol === 'create_time') continue;
        if (rawCol === 'uploaded_by') continue; // DO NOT OVERWRITE ORIGINAL UPLOADER UPON UPDATE
        const col = (rawCol === 'fileName' || rawCol === 'file_name') ? 'file_name' : rawCol;
        const val = payload[col] !== undefined ? payload[col] : (payload[rawCol] !== undefined ? payload[rawCol] : (payload[rawCol.toLowerCase()] !== undefined ? payload[rawCol.toLowerCase()] : undefined));
        if (val !== undefined) {
          updateFields.push(`${col} = $${idx++}`);
          updateValues.push(String(val));
        }
      }

      if (payload.status) {
        updateFields.push(`status = $${idx++}`);
        updateValues.push(String(payload.status));
      }
      if (payload.company_id) {
        updateFields.push(`company_id = $${idx++}`);
        updateValues.push(String(payload.company_id));
      }
      if (payload.employment_id || payload.emp_uuid) {
        updateFields.push(`employment_id = $${idx++}`);
        updateValues.push(payload.employment_id || payload.emp_uuid);
      }

      updateFields.push(`updated_at = NOW()`);
      updateValues.push(existingId);

      const updateSql = `UPDATE hr_employee_profiles SET ${updateFields.join(', ')} WHERE id = $${idx} RETURNING id`;
      const updateRes = await db.query(updateSql, updateValues);
      if (updateRes.rowCount === 0) {
        throw new Error(`[POST-WRITE VERIFICATION FAILED] Failed to update profile ID ${existingId}`);
      }
    } else {
      // Insert new profile into hr_employee_profiles
      const insertCols = [];
      const insertPlaceholders = [];
      const insertValues = [];
      let idx = 1;

      for (const rawCol of COLUMNS) {
        if (rawCol === 'Create_Time' || rawCol === 'create_time') continue;
        const col = (rawCol === 'fileName' || rawCol === 'file_name') ? 'file_name' : rawCol;
        const val = payload[col] !== undefined ? payload[col] : (payload[rawCol] !== undefined ? payload[rawCol] : (payload[rawCol.toLowerCase()] !== undefined ? payload[rawCol.toLowerCase()] : ''));
        insertCols.push(col);
        insertPlaceholders.push(`$${idx++}`);
        insertValues.push(String(val || ''));
      }

      insertCols.push('status');
      insertPlaceholders.push(`$${idx++}`);
      insertValues.push(payload.status || 'ACTIVE');

      insertCols.push('company_id');
      insertPlaceholders.push(`$${idx++}`);
      insertValues.push(payload.company_id || '');

      if (payload.employment_id || payload.emp_uuid) {
        insertCols.push('employment_id');
        insertPlaceholders.push(`$${idx++}`);
        insertValues.push(payload.employment_id || payload.emp_uuid);
      }

      insertCols.push('create_time');
      insertPlaceholders.push(`$${idx++}`);
      insertValues.push(new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }));

      insertCols.push('created_at');
      insertPlaceholders.push('NOW()');
      insertCols.push('updated_at');
      insertPlaceholders.push('NOW()');

      const insertSql = `INSERT INTO hr_employee_profiles (${insertCols.join(', ')}) VALUES (${insertPlaceholders.join(', ')}) RETURNING id`;
      const insertRes = await db.query(insertSql, insertValues);

      if (insertRes.rowCount === 0 || !insertRes.rows[0].id) {
        throw new Error(`[POST-WRITE VERIFICATION FAILED] Failed to insert profile for ${empCode || citizenId}`);
      }
    }

    // Strict Post-Write Verification
    const verifyRes = await db.query(
      `SELECT id, employee_id, citizen_id, status FROM hr_employee_profiles
       WHERE (employee_id IS NOT NULL AND employee_id <> '' AND employee_id = $1)
          OR (citizen_id IS NOT NULL AND citizen_id <> '' AND citizen_id = $2)
       LIMIT 1`,
      [empCode || '', citizenId || '']
    );
    if (verifyRes.rows.length === 0) {
      throw new Error(`[POST-WRITE VERIFICATION FAILED] Employee ${empCode || citizenId} not found in hr_employee_profiles after write.`);
    }
  }

  return {
    success: true,
    message: 'NocoDB (hr_employee_profiles) updated and verified successfully.'
  };
}

async function syncToGoogleSheets(payload) {
  const token = await getGoogleAccessToken();
  const docId = GOOGLE_SPREADSHEET_ID;

  // Build row values matching exactly the 54 header columns
  const rowValues = COLUMNS.map(c => {
    if (c === 'Create_Time' || c === 'create_time') return new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    if (c === 'fileName' || c === 'file_name') return payload.file_name || payload.fileName || '';
    if (c === 'uploaded_by') return payload.uploaded_by || '';
    if (c === 'job_grade' && payload.action_type === 'SOFT_DELETE') return '[ĐÃ XÓA]';
    if (c === 'job_grade' && payload.action_type === 'RESIGNED') return '[NGHỈ VIỆC]';
    if (c === 'job_grade' && payload.action_type === 'RESTORE') return '';
    if (c === 'full_name' && payload.action_type === 'SOFT_DELETE') {
      const fn = payload.full_name || '';
      return fn.includes('[ĐÃ XÓA]') ? fn : `${fn} [ĐÃ XÓA]`;
    }
    if (c === 'full_name' && (payload.action_type === 'RESTORE' || payload.action_type === 'UPDATE')) {
      const fn = payload.full_name || '';
      return fn.replace(/\s*\[ĐÃ XÓA\]/g, '').replace(/\s*\[NGHỈ VIỆC\]/g, '').trim();
    }
    if (c === 'full_name' && payload.action_type === 'RESIGNED') {
      const fn = (payload.full_name || '').replace(/\s*\[ĐÃ XÓA\]/g, '').replace(/\s*\[NGHỈ VIỆC\]/g, '').trim();
      return `${fn} [NGHỈ VIỆC]`;
    }
    let v = payload[c];
    if (v === undefined || v === null) v = '';
    if ((c === 'employee_id' || c === 'citizen_id' || c === 'phone_number') && /^0\d+$/.test(String(v))) {
      return "'" + String(v);
    }
    return String(v);
  });

  const cccd = String(payload.citizen_id || '').replace(/\D/g, '');
  const empId = String(payload.employee_id || '').trim();
  let existingRow = -1;
  let firstEmptyRow = -1;

  try {
    const getRes = await new Promise((resolve, reject) => {
      https.get(`https://sheets.googleapis.com/v4/spreadsheets/${docId}/values/Trang%20t%C3%ADnh1!A:J`, {
        headers: { 'Authorization': `Bearer ${token}` }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { resolve({}); }
        });
      }).on('error', reject);
    });
    const rows = getRes.values || [];
    for (let j = 0; j < rows.length; j++) {
      if (j === 0) continue; // Skip header row 1
      const r = rows[j];
      const isBlank = !r || r.length === 0 || r.every(cell => !cell || !String(cell).trim());
      if (isBlank) {
        if (firstEmptyRow === -1) firstEmptyRow = j + 1;
      } else {
        const rowEmpId = String(r[1] || '').trim();
        const rowCccd = String(r[9] || '').trim().replace(/\D/g, '');
        const normEmpId = empId.replace(/\D/g, '');
        const normRowEmpId = rowEmpId.replace(/\D/g, '');
        const isEmpIdMatch = empId && (
          rowEmpId === empId ||
          (normEmpId.length >= 11 && normRowEmpId.length >= 11 && normEmpId.padStart(12, '0') === normRowEmpId.padStart(12, '0'))
        );
        const normCccd = cccd.replace(/\D/g, '');
        const normRowCccd = rowCccd.replace(/\D/g, '');
        const isCccdMatch = cccd && (
          rowCccd === cccd ||
          (normCccd.length >= 11 && normRowCccd.length >= 11 && normCccd.padStart(12, '0') === normRowCccd.padStart(12, '0'))
        );
        // Prioritize matching by employee_id, then citizen_id
        if (isEmpIdMatch || isCccdMatch) {
          existingRow = j + 1;
          break;
        }
      }
    }
  } catch (e) {
    console.warn('[SHEETS] Lỗi kiểm tra dòng trên Google Sheets:', e.message);
  }

  const targetRow = existingRow > 0 ? existingRow : (firstEmptyRow > 1 ? firstEmptyRow : null);

  if (targetRow) {
    // Update existing row or fill first empty row
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ values: [rowValues] });
      const req = https.request(`https://sheets.googleapis.com/v4/spreadsheets/${docId}/values/Trang%20t%C3%ADnh1!A${targetRow}:BB${targetRow}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 15000
      }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(d);
          else reject(new Error(`Sheets PUT HTTP ${res.statusCode}: ${d}`));
        });
      });
      req.on('error', reject);
      req.write(body); req.end();
    });
  } else {
    // Append new row across full table bounding columns A:BA
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ values: [rowValues] });
      const req = https.request(`https://sheets.googleapis.com/v4/spreadsheets/${docId}/values/Trang%20t%C3%ADnh1!A:BB:append?valueInputOption=USER_ENTERED`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 15000
      }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(d);
          else reject(new Error(`Sheets Append HTTP ${res.statusCode}: ${d}`));
        });
      });
      req.on('error', reject);
      req.write(body); req.end();
    });
  }
}

// Sequential Mutex for Google Sheets to prevent concurrency collisions on batch approvals
let googleSheetsLock = Promise.resolve();

async function syncToGoogleSheetsWithLock(payload) {
  const currentLock = googleSheetsLock;
  let release;
  googleSheetsLock = new Promise(resolve => { release = resolve; });
  await currentLock;
  try {
    return await syncToGoogleSheets(payload);
  } finally {
    release();
  }
}

/**
 * Queue sync tasks for an approved staging profile (both NocoDB & Google Sheets)
 * Ghi tác vụ bền vững vào CSDL, không dùng setImmediate()
 * @param {string} stagingId - UUID of approved hr_employee_staging record
 * @param {object} [client] - Optional transactional db client
 */
async function queueSyncTasks(stagingId, client = null) {
  const dbClient = client || db;
  try {
    const idempotencyKey = `hr:sync:dossier:${stagingId}`;
    await dbClient.query(
      `INSERT INTO hr_sync_tasks (staging_id, target_system, status, idempotency_key, payload)
       VALUES ($1, 'sequential_noco_sheets', 'pending', $2, '{}'::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [stagingId, idempotencyKey]
    );
  } catch (e) {
    console.error('Lỗi xếp hàng sync task:', e.message);
  }
}

/**
 * Queue sync task directly for an employee record (soft delete, status change, resignation, transfer)
 * @param {string} employeeId - UUID of employees record
 * @param {string} actionType - 'UPDATE' | 'SOFT_DELETE' | 'RESIGNED' | 'TRANSFER'
 * @param {object} employeeData - Employee details
 * @param {object} [client] - Optional transactional db client
 */
async function queueEmployeeSync(employeeId, actionType = 'UPDATE', employeeData = {}, client = null) {
  const dbClient = client || db;
  try {
    const idempotencyKey = employeeData.idempotency_key || `hr:sync:emp:${actionType}:${employeeId}`;
    await dbClient.query(
      `INSERT INTO hr_sync_tasks (staging_id, employee_id, action_type, target_system, status, idempotency_key, payload)
       VALUES (NULL, $1, $2, 'sequential_noco_sheets', 'pending', $3, $4::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [employeeId, actionType, idempotencyKey, JSON.stringify(employeeData)]
    );
  } catch (e) {
    console.error('Lỗi xếp hàng employee sync task:', e.message);
  }
}

let isPollerRunning = false;
async function pollPendingSyncTasks() {
  if (isPollerRunning) return;
  isPollerRunning = true;
  let client = null;
  try {
    client = await db.getClient();
    const res = await client.query(
      `SELECT id FROM hr_sync_tasks 
       WHERE status IN ('pending', 'pending_nocodb', 'pending_sheets') 
         AND retry_count < max_retries 
         AND (last_retry_at IS NULL OR last_retry_at < NOW() - (POWER(2, retry_count) * INTERVAL '5 second'))
       ORDER BY created_at ASC LIMIT 10
       FOR UPDATE SKIP LOCKED`
    );
    for (const row of res.rows) {
      await processSyncTask(row.id);
    }
  } catch (e) {
    console.error('[SYNC WORKER] Lỗi quét tác vụ nền:', e.message);
  } finally {
    if (client) client.release();
    isPollerRunning = false;
  }
}

// Chạy định kỳ mỗi 10 giây để đảm bảo không bao giờ bỏ sót bất kỳ tác vụ nào
setInterval(pollPendingSyncTasks, 10000);
setTimeout(pollPendingSyncTasks, 2000);

// Chạy tự động đối soát định kỳ mỗi 60 giây để đảm bảo tính nhất quán dữ liệu SoR, NocoDB & Google Sheets
let isReconciliationRunning = false;
async function triggerAutoReconciliation() {
  if (isReconciliationRunning) return;
  isReconciliationRunning = true;
  try {
    await reconcileEmployees({ autoFix: true, actor: 'sync_worker_reconciler' });
  } catch (err) {
    console.error('[SYNC WORKER] Lỗi đối soát dữ liệu tự động:', err.message);
  } finally {
    isReconciliationRunning = false;
  }
}
setInterval(triggerAutoReconciliation, 60000);
setTimeout(triggerAutoReconciliation, 5000);

module.exports = {
  queueSyncTasks,
  queueEmployeeSync,
  processSyncTask,
  syncToNocoDB,
  syncToGoogleSheets,
  getGoogleAccessToken,
  pollPendingSyncTasks,
  triggerAutoReconciliation
};
