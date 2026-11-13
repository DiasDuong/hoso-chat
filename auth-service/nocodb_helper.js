const http = require('node:http');

let db = null;
try {
  const sqlite3 = require('sqlite3');
  db = new sqlite3.Database('/usr/app/data/noco.db');
} catch (e) {
  // Not inside nocodb container or sqlite3 not installed
}

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
  'employment_start_date', 'official_labor_contract_sign_date', 'phone_number', 'email', 'file_name', 'uploaded_by', 'employment_status'
];

const DATE_COLUMNS = new Set([
  'date_of_birth', 'citizen_id_issue_date', 'contract_start_date',
  'contract_end_date', 'employment_start_date', 'official_labor_contract_sign_date',
  'degree_valid_until'
]);

const DECIMAL_COLUMNS = new Set([
  'social_insurance_salary', 'total_income', 'base_salary',
  'productivity_responsibility_pay', 'attendance_bonus', 'responsibility_allowance',
  'vessel_size_allowance', 'professional_allowance_t1', 'meal_allowance', 'other_allowances'
]);

const BOOLEAN_COLUMNS = new Set([
  'open_ended_contract', 'fixed_term_contract', 'seasonal_contract'
]);

function normalizeDate(str) {
  if (!str) return null;
  str = String(str).trim();
  if (!str || str.toLowerCase() === 'invalid date' || str.toLowerCase() === 'null') return null;

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const vnMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (vnMatch) {
    const d = vnMatch[1].padStart(2, '0');
    const m = vnMatch[2].padStart(2, '0');
    const y = vnMatch[3];
    return `${y}-${m}-${d}`;
  }

  // YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
  const isoMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (isoMatch) {
    const y = isoMatch[1];
    const m = isoMatch[2].padStart(2, '0');
    const d = isoMatch[3].padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const dt = new Date(str);
  if (!isNaN(dt.getTime())) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  return null;
}

function normalizeDecimal(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'nan') return null;

  const digits = s.replace(/[^\d]/g, '');
  if (!digits) return null;
  let num = parseInt(digits, 10);
  if (isNaN(num)) return null;
  if (num > 0 && num < 1000) num = num * 1000;
  return num;
}

function normalizeBoolean(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'boolean') return val ? 1 : 0;
  const s = String(val).trim().toLowerCase();
  if (!s || s === 'null') return null;
  if (s === 'true' || s === '1' || s === 'có' || s === 'co' || s === 'yes') return 1;
  if (s === 'false' || s === '0' || s === 'không' || s === 'khong' || s === 'no') return 0;
  return null;
}

function prepareValue(col, rawVal, data) {
  if (col === 'file_name') {
    return rawVal || data.fileName || '';
  }
  if (DATE_COLUMNS.has(col)) {
    return normalizeDate(rawVal);
  }
  if (DECIMAL_COLUMNS.has(col)) {
    return normalizeDecimal(rawVal);
  }
  if (BOOLEAN_COLUMNS.has(col)) {
    return normalizeBoolean(rawVal);
  }
  if (rawVal === undefined || rawVal === null) return '';
  return String(rawVal).trim();
}

/**
 * Upsert a single profile into nc_08u4___Hoso_Nhansu
 * Matches primarily by employee_id, then fallback to citizen_id
 */
function upsertProfile(data) {
  const empId = String(data.employee_id || data.employee_code || '').trim();
  let citizenId = String(data.citizen_id || '').trim();
  const rawCccd = citizenId.replace(/\D/g, '');
  if (rawCccd.length === 12 || rawCccd.length === 9) {
    citizenId = rawCccd;
  }
  const fullName = String(data.full_name || data.employee_name || '').trim();

  if (!empId && !citizenId && !fullName) {
    throw new Error('employee_id or citizen_id or full_name is required');
  }

  // 1. Đối soát theo employee_id trước (Khóa chính định danh duy nhất theo yêu cầu #5)
  let existing = null;
  if (empId) {
    existing = db.prepare('SELECT id, employee_id, citizen_id, full_name FROM nc_08u4___Hoso_Nhansu WHERE employee_id = ?').get(empId);
  }

  // 2. Chỉ đối soát theo citizen_id NẾU bản ghi trong CSDL đích CHƯA CÓ employee_id (hoặc employee_id rỗng)
  if (!existing && citizenId) {
    existing = db.prepare("SELECT id, employee_id, citizen_id, full_name FROM nc_08u4___Hoso_Nhansu WHERE citizen_id = ? AND (employee_id IS NULL OR employee_id = '')").get(citizenId);
    if (!existing) {
      const rows = db.prepare("SELECT id, employee_id, citizen_id, full_name FROM nc_08u4___Hoso_Nhansu WHERE citizen_id IS NOT NULL AND citizen_id != '' AND (employee_id IS NULL OR employee_id = '')").all();
      for (const r of rows) {
        if (String(r.citizen_id).replace(/\D/g, '') === citizenId) {
          existing = r;
          break;
        }
      }
    }
  }

  let action = 'inserted';
  let recordId = null;

  // Chuẩn bị các giá trị theo 52 cột
  const values = COLUMNS.map(c => {
    if (c === 'citizen_id') return citizenId || prepareValue(c, data[c], data);
    if (c === 'employee_id') return empId || prepareValue(c, data[c], data);
    if (c === 'full_name') return fullName || prepareValue(c, data[c], data);
    if (c === 'job_grade') return prepareValue(c, data.job_grade, data);
    if (c === 'employment_status') return data.employment_status || (data.status === 'RESIGNED' ? 'RESIGNED' : 'ACTIVE');
    return prepareValue(c, data[c], data);
  });

  const isSoftDelete = data.action_type === 'SOFT_DELETE' || data.status === 'DELETED';

  if (existing) {
    // CẬP NHẬT bản ghi đã có để dữ liệu luôn đồng bộ chính xác
    action = 'updated';
    recordId = existing.id;
    const setClause = COLUMNS.map(c => `${c} = ?`).join(', ');
    const updateVals = [...values, 0, recordId];
    db.prepare(`UPDATE nc_08u4___Hoso_Nhansu SET ${setClause}, __nc_deleted = ?, updated_at = datetime('now') WHERE id = ?`).run(...updateVals);
  } else {
    // TẠO MỚI bản ghi
    action = 'inserted';
    const colList = COLUMNS.join(', ');
    const placeholders = COLUMNS.map(() => '?').join(', ');
    const insertVals = [...values, 0];
    const stmt = db.prepare(`INSERT INTO nc_08u4___Hoso_Nhansu (${colList}, __nc_deleted, created_at, updated_at) VALUES (${placeholders}, ?, datetime('now'), datetime('now'))`);
    const info = stmt.run(...insertVals);
    recordId = info.lastInsertRowid;
  }

  const savedRecord = db.prepare('SELECT * FROM nc_08u4___Hoso_Nhansu WHERE id = ?').get(recordId);
  return { action, id: recordId, employee_id: empId, record: savedRecord };
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'POST' && (req.url === '/api/insert-profile' || req.url === '/api/upsert-profile')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const result = upsertProfile(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, ...result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  } else if (req.method === 'POST' && req.url === '/api/batch-upsert') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const records = Array.isArray(payload.records) ? payload.records : (Array.isArray(payload) ? payload : []);
        
        let inserted = 0;
        let updated = 0;
        const errors = [];
        const results = [];

        db.exec('BEGIN TRANSACTION');
        try {
          for (let i = 0; i < records.length; i++) {
            const item = records[i];
            try {
              const resObj = upsertProfile(item);
              if (resObj.action === 'inserted') inserted++;
              else if (resObj.action === 'updated') updated++;
              results.push({ employee_id: resObj.employee_id, action: resObj.action, id: resObj.id });
            } catch (itemErr) {
              errors.push({ index: i, employee_id: item.employee_id || item.employee_code, error: itemErr.message });
            }
          }
          db.exec('COMMIT');
        } catch (txErr) {
          db.exec('ROLLBACK');
          throw txErr;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          total: records.length,
          inserted,
          updated,
          errors_count: errors.length,
          errors,
          results
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/api/all-profiles') {
    try {
      const rows = db.prepare('SELECT * FROM nc_08u4___Hoso_Nhansu WHERE __nc_deleted IS NOT 1 ORDER BY id').all();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count: rows.length, records: rows }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  } else if (req.method === 'DELETE' && req.url.startsWith('/api/profile')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const empId = payload.employee_id;
        if (!empId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'employee_id is required' }));
          return;
        }
        const delRes = db.prepare('DELETE FROM nc_08u4___Hoso_Nhansu WHERE employee_id = ?').run(empId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, deleted: delRes.changes }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'nocodb-helper', version: '2.0.0' }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }
});

const PORT = 8084;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NocoDB Profile Sync Helper v2.0 running on port ${PORT}`);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});
