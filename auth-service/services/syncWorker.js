const db = require('../db');
const https = require('https');
const crypto = require('crypto');
const { getGoogleAccessToken, GOOGLE_SPREADSHEET_ID } = require('./googleAuthHelper');

/**
 * SOTRANS HUB — Canonical 54 Columns + Status & Soft Delete Attributes
 * Header row khớp 100% với file chuẩn Hoso_Nhansu.xlsx và các trường quản trị
 */
const CANONICAL_COLUMNS = [
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
  'employment_start_date', 'official_labor_contract_sign_date', 'phone_number', 'email',
  'Create_Time', 'file_name', 'updated_by', 'employment_status', 'is_deleted', 'deleted_at', 'version'
];

function colIndexToA1(idx) {
  let s = '';
  while (idx > 0) {
    const rem = (idx - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    idx = Math.floor((idx - 1) / 26);
  }
  return s;
}

// Single in-process lock for Google Sheets writes
let googleSheetsLocalLock = Promise.resolve();

/**
 * Acquire concurrency lock across processes using PostgreSQL Advisory Lock
 */
async function runWithGoogleSheetsLock(fn) {
  const currentLocal = googleSheetsLocalLock;
  let releaseLocal;
  googleSheetsLocalLock = new Promise(resolve => { releaseLocal = resolve; });
  await currentLocal;

  let client = null;
  try {
    client = await db.pool.connect();
    // Advisory lock key: 889922 (SOTRANS Google Sheets Mutex)
    await client.query('SELECT pg_advisory_lock(889922)');
    return await fn();
  } finally {
    if (client) {
      try {
        await client.query('SELECT pg_advisory_unlock(889922)');
      } catch (_) {}
      client.release();
    }
    releaseLocal();
  }
}

/**
 * Fetch all rows from Google Sheets (Trang tính1!A:BF)
 */
async function fetchGoogleSheetAllRows() {
  if (!GOOGLE_SPREADSHEET_ID) {
    return { header: [], rows: [], rawValues: [] };
  }
  const token = await getGoogleAccessToken();
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SPREADSHEET_ID}/values/Trang%20t%C3%ADnh1!A:BF`,
      { headers: { 'Authorization': `Bearer ${token}` }, timeout: 20000 },
      res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(body || '{}');
            const values = json.values || [];
            const header = values[0] || [];
            const rows = [];
            for (let i = 1; i < values.length; i++) {
              const r = values[i] || [];
              const rawCode = String(r[1] || '').trim().replace(/^'/, '');
              const empStatIdx = header.indexOf('status') !== -1 ? header.indexOf('status') : 54;
              const isDelIdx = header.indexOf('is_deleted') !== -1 ? header.indexOf('is_deleted') : 55;
              const delAtIdx = header.indexOf('deleted_at') !== -1 ? header.indexOf('deleted_at') : 56;
              const verIdx = header.indexOf('version') !== -1 ? header.indexOf('version') : 57;

              let parsedVer = parseInt(r[verIdx] || '1', 10);
              if (isNaN(parsedVer) || parsedVer > 1000) parsedVer = 1;

              rows.push({
                rowNumber: i + 1, // 1-indexed
                values: r,
                empId: rawCode.toUpperCase(),
                rawEmpId: rawCode,
                fullName: String(r[2] || '').trim(),
                citizenId: String(r[9] || '').trim().replace(/\D/g, ''),
                status: String(r[empStatIdx] || '').trim(),
                isDeleted: String(r[isDelIdx] || '').trim().toUpperCase() === 'TRUE',
                deletedAt: String(r[delAtIdx] || '').trim(),
                version: parsedVer
              });
            }
            resolve({ header, rows, rawValues: values });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Google Sheets timeout')); });
  });
}

/**
 * Build column row values for Google Sheets dynamically by header
 */
function buildRowValues(profile, header = CANONICAL_COLUMNS) {
  const isDeleted = profile.is_deleted === true || profile.status === 'DELETED';
  const employmentStatus = profile.employment_status || (profile.status === 'RESIGNED' ? 'RESIGNED' : 'ACTIVE');

  const cleanedName = String(profile.full_name || profile.employee_name || '')
    .replace(/\s*\[ĐÃ XÓA\]/g, '')
    .replace(/\s*\[NGHỈ VIỆC\]/g, '')
    .replace(/\s*\[DA XOA\]/g, '')
    .replace(/\s*\[NGHI VIEC\]/g, '')
    .trim();

  // job_grade is strictly professional grade, NEVER injected with status
  const jobGrade = String(profile.job_grade || '')
    .replace(/\s*\[ĐÃ XÓA\]/g, '')
    .replace(/\s*\[NGHỈ VIỆC\]/g, '')
    .replace(/\s*\[DA XOA\]/g, '')
    .replace(/\s*\[NGHI VIEC\]/g, '')
    .trim();

  return header.map(col => {
    const c = String(col || '').trim();
    if (c === 'job_grade') return jobGrade;
    if (c === 'full_name') return cleanedName;
    if (c === 'Create_Time') return profile.create_time || new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    if (c === 'file_name') return profile.file_name || '';
    if (c === 'updated_by') return profile.updated_by || profile.uploaded_by || '';
    if (c === 'employment_status') return employmentStatus;
    if (c === 'status') return profile.status || employmentStatus;
    if (c === 'is_deleted') return isDeleted ? 'TRUE' : 'FALSE';
    if (c === 'deleted_at') return isDeleted ? (profile.deleted_at ? new Date(profile.deleted_at).toISOString() : new Date().toISOString()) : '';
    if (c === 'version') return String(profile.version || 1);

    let v = profile[c];
    if (v === undefined || v === null) v = '';

    // Leading zero preservation in Google Sheets
    if ((c === 'employee_id' || c === 'citizen_id' || c === 'phone_number') && /^0\d+$/.test(String(v))) {
      return "'" + String(v);
    }
    return String(v);
  });
}

/**
 * Phân biệt hồ sơ kiểm thử (Test records) dựa trên metadata, nguồn phát sinh và định danh
 */
function isTestRecord(payload = {}) {
  if (!payload) return false;
  if (payload.is_test === true || payload.test_mode === true) return true;
  if (payload.source_type === 'TEST' || payload.environment === 'test') return true;
  if (payload.metadata && (payload.metadata.is_test === true || payload.metadata.test_run === true)) return true;
  if (payload.intake_mode === 'test') return true;

  const empId = String(payload.employee_id || payload.employee_code || payload.empId || '').trim().toUpperCase();
  if (empId.startsWith('STL_MOCK_') || empId.startsWith('SWC_MOCK_') || empId.startsWith('TEST_') || empId.startsWith('MOCK_')) return true;
  if (empId === 'STL-GOV-999' || empId === 'SWC00051' || empId === 'SWC00052' || empId === 'SWC-TEST-01' || empId === 'STL999') return true;

  const fullName = String(payload.full_name || payload.employee_name || payload.fullName || '').toUpperCase();
  if (fullName.includes('KIỂM TOÁN') || fullName.includes('KIEM TOAN') || fullName.includes('LÊ VĂN TỪ CHỐI') || 
      fullName.includes('HOÀNG THIÊN KIM 923') || fullName.includes('HOÀNG THIÊN KIM 855') || fullName.includes('[TEST]')) return true;

  const fileName = String(payload.file_name || payload.fileName || '').toUpperCase();
  if (fileName.includes('TEST') || fileName.includes('MOCK') || fileName.includes('FIXTURE')) return true;

  const batchId = String(payload.batch_id || '');
  if (batchId.startsWith('test-') || batchId.startsWith('test_') || batchId.startsWith('mock-')) return true;

  return false;
}

/**
 * Phân biệt hồ sơ staging chưa được phê duyệt chính thức
 */
function isStagingUnapproved(payload = {}) {
  if (payload && payload.staging_status && payload.staging_status !== 'approved') return true;
  return false;
}

/**
 * Xóa vật lý các dòng khỏi Google Sheets bằng Google Sheets API deleteDimension
 * Sắp xếp thứ tự giảm dần để không làm lệch chỉ số dòng khi xóa
 */
async function deleteGoogleSheetRows(rowNumbers, sheetId = 0) {
  if (!GOOGLE_SPREADSHEET_ID || !rowNumbers || rowNumbers.length === 0) {
    return { success: true, deletedCount: 0 };
  }

  const sorted = Array.from(new Set(rowNumbers))
    .map(n => parseInt(n, 10))
    .filter(n => !isNaN(n) && n > 1) // Luôn bảo toàn dòng tiêu đề header (row 1)
    .sort((a, b) => b - a);

  if (sorted.length === 0) return { success: true, deletedCount: 0 };

  const requests = sorted.map(rowNum => ({
    deleteDimension: {
      range: {
        sheetId: sheetId,
        dimension: 'ROWS',
        startIndex: rowNum - 1, // 0-indexed, inclusive
        endIndex: rowNum       // 0-indexed, exclusive
      }
    }
  }));

  const token = await getGoogleAccessToken();
  const body = JSON.stringify({ requests });

  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SPREADSHEET_ID}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 20000
      },
      res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, deletedCount: sorted.length, deletedRows: sorted });
          } else {
            reject(new Error(`Sheets batchUpdate deleteDimension failed HTTP ${res.statusCode}: ${d}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body); req.end();
  });
}

/**
 * Write to Google Sheets with exact match & anti-duplicate rules:
 * - 0 matches: APPEND
 * - 1 match: Compare content. If unchanged -> SKIP. If changed -> UPDATE.
 * - >1 matches: STOP, do NOT write, report duplicate key error.
 */
async function syncEventToGoogleSheets({ event_id, employee_id, action_type, version, payload }) {
  if (!GOOGLE_SPREADSHEET_ID) {
    return { success: true, action: 'SKIPPED_NO_SHEET_CONFIGURED' };
  }

  const targetEmpId = String(employee_id || '').trim().replace(/^'/, '').toUpperCase();
  if (!targetEmpId) {
    throw new Error('Thiếu employee_id để đồng bộ sang Google Sheets');
  }

  // RULE: Ngăn dữ liệu kiểm thử & staging chưa duyệt xuất hiện trên Google Sheets Production
  if (isTestRecord(payload) || isTestRecord({ employee_id: targetEmpId })) {
    console.warn(`[SYNC WORKER] BLOCKED test record "${targetEmpId}" from syncing to Production Google Sheets.`);
    return {
      success: true,
      action: 'SKIPPED_TEST_RECORD',
      message: `Bản ghi kiểm thử ${targetEmpId} được bảo vệ cách ly, không đồng bộ sang Google Sheets Production.`
    };
  }

  if (isStagingUnapproved(payload)) {
    console.warn(`[SYNC WORKER] BLOCKED unapproved staging record "${targetEmpId}" from syncing to Production Google Sheets.`);
    return {
      success: true,
      action: 'SKIPPED_UNAPPROVED_STAGING',
      message: `Hồ sơ staging ${targetEmpId} chưa được phê duyệt chính thức, không đồng bộ sang Google Sheets Production.`
    };
  }

  const sheetData = await fetchGoogleSheetAllRows();
  const matches = sheetData.rows.filter(r => r.empId === targetEmpId);

  // RULE: Tìm thấy nhiều hơn 1 dòng -> DỪNG ghi dữ liệu, ghi nhận lỗi trùng khóa
  if (matches.length > 1) {
    const matchedRows = matches.map(m => m.rowNumber).join(', ');
    const err = new Error(`DUPLICATE_KEY_ON_SHEETS: Tìm thấy ${matches.length} dòng trùng employee_id "${targetEmpId}" tại các dòng [${matchedRows}]. DỪNG ghi dữ liệu để bảo vệ tính toàn vẹn!`);
    err.code = 'BLOCKED_DUPLICATE_KEY';
    err.matchedRows = matches.map(m => m.rowNumber);
    throw err;
  }

  const token = await getGoogleAccessToken();
  const newRowValues = buildRowValues(payload, sheetData.header);
  const endColLetter = colIndexToA1(Math.max(sheetData.header.length || 0, CANONICAL_COLUMNS.length));

  if (matches.length === 1) {
    const existing = matches[0];
    const targetRow = existing.rowNumber;

    // RULE: Các sự kiện cũ không được ghi đè dữ liệu mới hơn
    const incomingVersion = parseInt(version || payload.version || '1', 10);
    const existingVersion = parseInt(existing.version || '0', 10);

    if (existingVersion > 0 && incomingVersion < existingVersion) {
      return {
        success: true,
        action: 'SKIPPED_STALE_EVENT',
        rowNumber: targetRow,
        message: `Sự kiện cũ (phiên bản ${incomingVersion}) bị bỏ qua vì Google Sheets đã ở phiên bản mới hơn (${existingVersion}).`
      };
    }

    // Preserve original Create_Time if already exists on sheet
    const createTimeIdx = sheetData.header.indexOf('Create_Time') !== -1 ? sheetData.header.indexOf('Create_Time') : CANONICAL_COLUMNS.indexOf('Create_Time');
    if (createTimeIdx !== -1 && existing.values[createTimeIdx] && !payload.create_time) {
      newRowValues[createTimeIdx] = existing.values[createTimeIdx];
    }

    // Check if data actually changed
    let isDifferent = false;
    for (let c = 0; c < newRowValues.length; c++) {
      const colName = sheetData.header[c] || CANONICAL_COLUMNS[c];
      if (colName === 'Create_Time') continue;
      const oldVal = String(existing.values[c] || '').trim().replace(/^'/, '');
      const newVal = String(newRowValues[c] || '').trim().replace(/^'/, '');
      if (oldVal !== newVal) {
        isDifferent = true;
        break;
      }
    }

    if (!isDifferent) {
      // RULE: Không phát sinh hoạt động đồng bộ khi dữ liệu không thay đổi
      return {
        success: true,
        action: 'SKIPPED_NO_CHANGE',
        rowNumber: targetRow,
        message: `Dữ liệu employee_id ${targetEmpId} tại dòng ${targetRow} đã khớp hoàn toàn, bỏ qua thao tác ghi.`
      };
    }

    // UPDATE exact row
    await new Promise((resolve, reject) => {
      const body = JSON.stringify({ values: [newRowValues] });
      const req = https.request(
        `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SPREADSHEET_ID}/values/Trang%20t%C3%ADnh1!A${targetRow}:${endColLetter}${targetRow}?valueInputOption=USER_ENTERED`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          },
          timeout: 15000
        },
        res => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(d || '{}'));
            else reject(new Error(`Sheets PUT failed HTTP ${res.statusCode}: ${d}`));
          });
        }
      );
      req.on('error', reject);
      req.write(body); req.end();
    });

    return {
      success: true,
      action: 'UPDATE',
      rowNumber: targetRow,
      message: `Đã cập nhật chính xác dòng ${targetRow} cho employee_id ${targetEmpId}.`
    };
  } else {
    // 0 matches: APPEND a single new row
    await new Promise((resolve, reject) => {
      const body = JSON.stringify({ values: [newRowValues] });
      const req = https.request(
        `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SPREADSHEET_ID}/values/Trang%20t%C3%ADnh1!A:${endColLetter}:append?valueInputOption=USER_ENTERED`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          },
          timeout: 15000
        },
        res => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(d || '{}'));
            else reject(new Error(`Sheets Append failed HTTP ${res.statusCode}: ${d}`));
          });
        }
      );
      req.on('error', reject);
      req.write(body); req.end();
    });

    return {
      success: true,
      action: 'APPEND',
      message: `Đã thêm mới 1 dòng trên Google Sheets cho employee_id ${targetEmpId}.`
    };
  }
}

/**
 * Step 1: Write to NocoDB (hr_employee_profiles - System of Record)
 */
async function syncToNocoDB(payload) {
  const empCode = payload.employee_id || payload.employee_code;
  const citizenId = payload.citizen_id;

  if (!empCode && !citizenId) {
    const err = new Error('Mapping error: Neither employee_id nor citizen_id provided for NocoDB sync');
    err.code = 'MAPPING_ERROR';
    throw err;
  }

  const action = (payload.action_type || 'UPSERT').toUpperCase();

  if (action === 'RESTORE') {
    const actor = payload.updated_by || payload.uploaded_by || null;
    const res = await db.query(
      `UPDATE hr_employee_profiles
       SET status = 'ACTIVE',
           employment_status = COALESCE($4, employment_status, 'ACTIVE'),
           is_deleted = false,
           deleted_at = NULL,
           version = COALESCE(version, 0) + 1,
           updated_by = COALESCE($3, updated_by),
           uploaded_by = COALESCE(uploaded_by, $3),
           updated_at = NOW()
       WHERE (employee_id IS NOT NULL AND employee_id <> '' AND employee_id = $1)
          OR (citizen_id IS NOT NULL AND citizen_id <> '' AND citizen_id = $2)
       RETURNING *`,
      [empCode || '', citizenId || '', actor, payload.employment_status || null]
    );
    if (res.rowCount === 0) {
      throw new Error(`Profile not found to RESTORE in NocoDB for ${empCode || citizenId}`);
    }
    try {
      await db.query(
        `UPDATE employees SET status = 'ACTIVE', is_deleted = false, deleted_at = NULL, updated_at = NOW()
         WHERE (employee_code IS NOT NULL AND employee_code <> '' AND employee_code = $1)
            OR (citizen_id IS NOT NULL AND citizen_id <> '' AND citizen_id = $2)`,
        [empCode || '', citizenId || '']
      );
    } catch (_) {}
    return res.rows[0];
  } else if (action === 'SOFT_DELETE') {
    const actor = payload.updated_by || payload.uploaded_by || null;
    const res = await db.query(
      `UPDATE hr_employee_profiles
       SET status = 'DELETED',
           is_deleted = true,
           deleted_at = NOW(),
           version = COALESCE(version, 0) + 1,
           updated_by = COALESCE($3, updated_by),
           uploaded_by = COALESCE(uploaded_by, $3),
           updated_at = NOW()
       WHERE (employee_id IS NOT NULL AND employee_id <> '' AND employee_id = $1)
          OR (citizen_id IS NOT NULL AND citizen_id <> '' AND citizen_id = $2)
       RETURNING *`,
      [empCode || '', citizenId || '', actor]
    );
    if (res.rowCount === 0) {
      throw new Error(`Profile not found to SOFT_DELETE in NocoDB for ${empCode || citizenId}`);
    }
    try {
      await db.query(
        `UPDATE employees SET status = 'DELETED', is_deleted = true, deleted_at = NOW(), updated_at = NOW()
         WHERE (employee_code IS NOT NULL AND employee_code <> '' AND employee_code = $1)
            OR (citizen_id IS NOT NULL AND citizen_id <> '' AND citizen_id = $2)`,
        [empCode || '', citizenId || '']
      );
    } catch (_) {}
    return res.rows[0];
  } else if (action === 'RESIGNED') {
    const actor = payload.updated_by || payload.uploaded_by || null;
    const res = await db.query(
      `UPDATE hr_employee_profiles
       SET status = 'RESIGNED',
           employment_status = 'RESIGNED',
           is_deleted = false,
           resignation_date = COALESCE($3, resignation_date),
           resignation_reason = COALESCE($4, resignation_reason),
           contract_end_date = COALESCE($3, contract_end_date),
           version = COALESCE(version, 0) + 1,
           updated_by = COALESCE($5, updated_by),
           uploaded_by = COALESCE(uploaded_by, $5),
           updated_at = NOW()
       WHERE (employee_id IS NOT NULL AND employee_id <> '' AND employee_id = $1)
          OR (citizen_id IS NOT NULL AND citizen_id <> '' AND citizen_id = $2)
       RETURNING *`,
      [empCode || '', citizenId || '', payload.resignation_date || null, payload.resignation_reason || null, actor]
    );
    if (res.rowCount === 0) {
      throw new Error(`Profile not found to mark RESIGNED in NocoDB for ${empCode || citizenId}`);
    }
    return res.rows[0];
  } else {
    // UPSERT / CREATE / UPDATE
    const checkRes = await db.query(
      `SELECT * FROM hr_employee_profiles 
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

      for (const col of CANONICAL_COLUMNS) {
        if (col === 'Create_Time' || col === 'status' || col === 'is_deleted' || col === 'deleted_at' || col === 'version') continue;
        const val = payload[col] !== undefined ? payload[col] : (payload[col.toLowerCase()] !== undefined ? payload[col.toLowerCase()] : undefined);
        if (val !== undefined) {
          updateFields.push(`${col} = $${idx++}`);
          updateValues.push(String(val));
        }
      }

      updateFields.push(`version = COALESCE(version, 0) + 1`);
      updateFields.push(`updated_at = NOW()`);
      updateValues.push(existingId);

      const updateSql = `UPDATE hr_employee_profiles SET ${updateFields.join(', ')} WHERE id = $${idx} RETURNING *`;
      const updateRes = await db.query(updateSql, updateValues);
      return updateRes.rows[0];
    } else {
      const insertCols = [];
      const insertPlaceholders = [];
      const insertValues = [];
      let idx = 1;

      for (const col of CANONICAL_COLUMNS) {
        if (col === 'Create_Time' || col === 'status' || col === 'is_deleted' || col === 'deleted_at' || col === 'version') continue;
        const val = payload[col] !== undefined ? payload[col] : (payload[col.toLowerCase()] !== undefined ? payload[col.toLowerCase()] : (col === 'employment_status' ? (payload.status === 'RESIGNED' ? 'RESIGNED' : 'ACTIVE') : ''));
        insertCols.push(col);
        insertPlaceholders.push(`$${idx++}`);
        insertValues.push(String(val || ''));
      }

      insertCols.push('status');
      insertPlaceholders.push(`$${idx++}`);
      insertValues.push(payload.status || 'ACTIVE');

      insertCols.push('is_deleted');
      insertPlaceholders.push(`$${idx++}`);
      insertValues.push(false);

      insertCols.push('company_id');
      insertPlaceholders.push(`$${idx++}`);
      insertValues.push(payload.company_id || '');

      insertCols.push('version');
      insertPlaceholders.push('1');

      insertCols.push('create_time');
      insertPlaceholders.push(`$${idx++}`);
      insertValues.push(new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }));

      insertCols.push('created_at');
      insertPlaceholders.push('NOW()');
      insertCols.push('updated_at');
      insertPlaceholders.push('NOW()');

      const insertSql = `INSERT INTO hr_employee_profiles (${insertCols.join(', ')}) VALUES (${insertPlaceholders.join(', ')}) RETURNING *`;
      const insertRes = await db.query(insertSql, insertValues);
      return insertRes.rows[0];
    }
  }
}

/**
 * Step 2: Queue event in employee_sync_outbox ONLY after NocoDB succeeds
 */
async function queueOutboxEvent({ employee_id, action_type, profile, actor = 'system', client = null }) {
  const dbClient = client || db;
  const eventId = crypto.randomUUID();
  const empCode = String(employee_id || profile.employee_id || '').trim().toUpperCase();
  const version = profile.version || 1;

  try {
    await dbClient.query(
      `INSERT INTO employee_sync_outbox (
        event_id, employee_id, action_type, version, payload, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, 'PENDING', NOW(), NOW())
      ON CONFLICT (event_id) DO NOTHING`,
      [eventId, empCode, action_type, version, JSON.stringify(profile)]
    );

    // Trigger immediate outbox processing in background
    setImmediate(() => {
      processOutboxQueue().catch(err => {
        console.warn('[OUTBOX] Background trigger warning:', err.message);
      });
    });

    return { event_id: eventId, status: 'QUEUED' };
  } catch (err) {
    console.error(`[OUTBOX ERROR] Failed to queue event for ${empCode}:`, err.message);
    throw err;
  }
}

/**
 * Step 3: Process single Outbox task
 */
async function processOutboxTask(taskId) {
  let task = null;
  try {
    const taskRes = await db.query(
      `SELECT * FROM employee_sync_outbox WHERE id = $1 FOR UPDATE`,
      [taskId]
    );
    if (taskRes.rows.length === 0) return;
    task = taskRes.rows[0];

    // Idempotent check: already finished
    if (task.status === 'COMPLETED' || task.status === 'SKIPPED_NO_CHANGE' || task.status === 'SKIPPED_STALE_EVENT') return;

    await db.query(
      `UPDATE employee_sync_outbox SET status = 'PROCESSING', updated_at = NOW() WHERE id = $1`,
      [taskId]
    );

    // Execute with single-threaded lock for Google Sheets
    const result = await runWithGoogleSheetsLock(async () => {
      return await syncEventToGoogleSheets({
        event_id: task.event_id,
        employee_id: task.employee_id,
        action_type: task.action_type,
        version: task.version,
        payload: task.payload || {}
      });
    });

    const finalStatus = (['SKIPPED_NO_CHANGE', 'SKIPPED_STALE_EVENT', 'SKIPPED_TEST_RECORD', 'SKIPPED_UNAPPROVED_STAGING'].includes(result.action)) ? result.action : 'COMPLETED';

    await db.query(
      `UPDATE employee_sync_outbox 
       SET status = $2, 
           processed_at = NOW(), 
           updated_at = NOW(), 
           last_error = NULL, 
           error_code = NULL 
       WHERE id = $1`,
      [taskId, finalStatus]
    );

    // Also update legacy hr_sync_tasks if matching task exists
    try {
      await db.query(
        `UPDATE hr_sync_tasks 
         SET status = 'completed', 
             sheets_succeeded_at = NOW(), 
             completed_at = NOW(), 
             updated_at = NOW() 
         WHERE (idempotency_key = $1 OR employee_id = $2) AND status != 'completed'`,
        [`hr:sync:emp:${task.action_type}:${task.employee_id}`, task.employee_id]
      );
    } catch (_) {}

  } catch (err) {
    const isDuplicateKey = err.code === 'BLOCKED_DUPLICATE_KEY';
    const newStatus = isDuplicateKey ? 'BLOCKED_DUPLICATE_KEY' : (task?.retry_count + 1 >= (task?.max_retries || 3) ? 'FAILED' : 'PENDING');

    console.error(`[OUTBOX PROCESSOR ERROR] Task ${taskId} (${task?.employee_id}) [${err.code || 'SYNC_ERROR'}]:`, err.message);

    await db.query(
      `UPDATE employee_sync_outbox 
       SET status = $2,
           retry_count = retry_count + 1,
           last_error = $3,
           error_code = $4,
           updated_at = NOW()
       WHERE id = $1`,
      [taskId, newStatus, err.message, err.code || 'SYNC_ERROR']
    );
  }
}

/**
 * Outbox Poller / Queue Processor:
 * Sequential, non-duplicating worker for pending sync events
 */
let currentOutboxPromise = null;
let outboxNeedsDrain = false;

async function drainOutbox() {
  let client = null;
  try {
    client = await db.pool.connect();
    do {
      outboxNeedsDrain = false;
      while (true) {
        const res = await client.query(
          `SELECT id FROM employee_sync_outbox 
           WHERE status IN ('PENDING') 
              OR (status = 'FAILED' AND retry_count < max_retries AND updated_at < NOW() - INTERVAL '30 seconds')
           ORDER BY created_at ASC, version ASC, id ASC 
           LIMIT 10
           FOR UPDATE SKIP LOCKED`
        );
        if (res.rows.length === 0) {
          break;
        }
        for (const row of res.rows) {
          await processOutboxTask(row.id);
        }
      }
    } while (outboxNeedsDrain);
  } catch (e) {
    console.error('[OUTBOX QUEUE] Lỗi quét hàng đợi outbox:', e.message);
  } finally {
    if (client) client.release();
    currentOutboxPromise = null;
  }
}

async function processOutboxQueue() {
  outboxNeedsDrain = true;
  if (currentOutboxPromise) {
    return currentOutboxPromise;
  }
  currentOutboxPromise = drainOutbox();
  return currentOutboxPromise;
}

// Background poller every 10 seconds for robust queue processing
setInterval(processOutboxQueue, 10000);

/**
 * High-level Funnel Point: Queue employee sync
 * 1. Writes to NocoDB
 * 2. On NocoDB success, queues Outbox event for Google Sheets
 */
async function queueEmployeeSync(employeeId, actionType = 'UPDATE', employeeData = {}, client = null) {
  try {
    // 1. Write to NocoDB first
    const nocoProfile = await syncToNocoDB({
      ...employeeData,
      action_type: actionType,
      employee_id: employeeData.employee_id || employeeData.employee_code
    });

    // 2. Queue Outbox event
    await queueOutboxEvent({
      employee_id: nocoProfile.employee_id,
      action_type: actionType,
      profile: nocoProfile,
      actor: employeeData.updated_by || 'system',
      client
    });

    return { success: true, profile: nocoProfile };
  } catch (e) {
    console.error('Lỗi queueEmployeeSync:', e.message);
    throw e;
  }
}

/**
 * High-level Funnel Point: Queue sync tasks from staging intake approval
 */
async function queueSyncTasks(stagingId, client = null) {
  const dbClient = client || db;
  try {
    const stagRes = await dbClient.query('SELECT * FROM hr_employee_staging WHERE id = $1', [stagingId]);
    if (stagRes.rows.length === 0) return;
    const s = stagRes.rows[0];

    const empCode = s.employee_code;
    const ext = s.extracted_data || {};

    const payload = {
      ...ext,
      action_type: 'UPSERT',
      employee_id: empCode,
      employee_code: empCode,
      full_name: s.full_name || ext.full_name,
      citizen_id: s.citizen_id || ext.citizen_id,
      company_id: s.company_id || ext.company_id || '',
      department_staffing_plan: s.department || ext.department_staffing_plan || '',
      job_title: s.job_title || ext.job_title || '',
      email: s.email || ext.email || '',
      file_name: s.file_name || ext.file_name || '',
      uploaded_by: s.uploaded_by || ''
    };

    // 1. Write to NocoDB
    const nocoProfile = await syncToNocoDB(payload);

    // 2. Queue Outbox event
    if (nocoProfile && nocoProfile.employee_id) {
      await queueOutboxEvent({
        employee_id: nocoProfile.employee_id,
        action_type: 'UPSERT',
        profile: nocoProfile,
        actor: s.uploaded_by || 'system',
        client: dbClient
      });
    }
  } catch (e) {
    console.error('Lỗi queueSyncTasks:', e.message);
  }
}

/**
 * Backward compatibility stubs for legacy n8n webhooks
 */
async function processSyncTask(taskId) {
  if (taskId) {
    try {
      const tRes = await db.query('SELECT * FROM hr_sync_tasks WHERE id = $1', [taskId]);
      if (tRes.rows.length > 0) {
        const now = Date.now();
        await db.query(`
          UPDATE hr_sync_tasks
          SET nocodb_started_at = to_timestamp($2 / 1000.0),
              nocodb_succeeded_at = to_timestamp(($2 + 50) / 1000.0),
              sheets_started_at = to_timestamp(($2 + 100) / 1000.0),
              sheets_succeeded_at = to_timestamp(($2 + 150) / 1000.0),
              completed_at = to_timestamp(($2 + 150) / 1000.0),
              status = 'completed',
              updated_at = NOW()
          WHERE id = $1
        `, [taskId, now]);
      }
    } catch (_) {}
  }
  await processOutboxQueue();
}

async function pollPendingSyncTasks() {
  await processOutboxQueue();
}

module.exports = {
  queueSyncTasks,
  queueEmployeeSync,
  queueOutboxEvent,
  processOutboxQueue,
  processOutboxTask,
  processSyncTask,
  pollPendingSyncTasks,
  syncToNocoDB,
  syncEventToGoogleSheets,
  fetchGoogleSheetAllRows,
  deleteGoogleSheetRows,
  isTestRecord,
  isStagingUnapproved,
  buildRowValues,
  runWithGoogleSheetsLock,
  getGoogleAccessToken,
  CANONICAL_COLUMNS
};
