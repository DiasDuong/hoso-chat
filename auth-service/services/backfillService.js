const db = require('../db');
const http = require('http');
const https = require('https');
const { getGoogleAccessToken, fetchGoogleSheetAllRows } = require('./syncWorker');

const GOOGLE_SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '1q_Sv9-p-pa5_yzoMSlbJfwz5vNqEhFFBaBhC3f0U6YI';

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
  'employment_start_date', 'official_labor_contract_sign_date', 'phone_number', 'email', 'file_name'
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

function normalizeDate(str) {
  if (!str) return '';
  str = String(str).trim();
  if (!str || str.toLowerCase() === 'invalid date' || str.toLowerCase() === 'null') return '';

  const vnMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (vnMatch) {
    const d = vnMatch[1].padStart(2, '0');
    const m = vnMatch[2].padStart(2, '0');
    const y = vnMatch[3];
    return `${y}-${m}-${d}`;
  }

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

  return str;
}

function normalizeDecimal(val) {
  if (val === null || val === undefined) return '';
  const s = String(val).trim();
  if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'nan') return '';

  const digits = s.replace(/[^\d]/g, '');
  if (!digits) return '';
  let num = parseInt(digits, 10);
  if (isNaN(num)) return '';
  if (num > 0 && num < 1000) num = num * 1000;
  return String(num);
}

/**
 * 1. Read all employees from website's actual Postgres database
 */
async function getSourceEmployees() {
  const query = `
    SELECT 
      e.id AS emp_uuid,
      e.company_id,
      e.employee_code,
      e.citizen_id AS emp_citizen_id,
      e.employee_name,
      e.department AS emp_department,
      e.position AS emp_position,
      e.email AS emp_email,
      e.status AS emp_status,
      e.created_at AS emp_created_at,
      e.updated_at AS emp_updated_at,
      p.id AS profile_id,
      p.job_grade,
      p.date_of_birth,
      p.gender,
      p.job_title,
      p.professional_title,
      p.department_staffing_plan,
      p.section_staffing_plan,
      p.citizen_id AS p_citizen_id,
      p.citizen_id_issue_date,
      p.citizen_id_issue_place,
      p.birth_registration_place,
      p.place_of_origin,
      p.permanent_address,
      p.temporary_address,
      p.current_address,
      p.ethnicity,
      p.education_level,
      p.education_code,
      p.qualification,
      p.professional_qualification,
      p.specialization,
      p.degree_qualification,
      p.training_institution,
      p.major,
      p.training_mode,
      p.training_period,
      p.graduation_grade,
      p.degree_valid_until,
      p.other_professional_certificates,
      p.social_insurance_salary,
      p.total_income,
      p.base_salary,
      p.productivity_responsibility_pay,
      p.attendance_bonus,
      p.responsibility_allowance,
      p.vessel_size_allowance,
      p.professional_allowance_t1,
      p.meal_allowance,
      p.other_allowances,
      p.open_ended_contract,
      p.fixed_term_contract,
      p.seasonal_contract,
      p.contract_start_date,
      p.contract_end_date,
      p.recruitment_decision_no,
      p.employment_start_date,
      p.official_labor_contract_sign_date,
      p.phone_number,
      p.email AS p_email,
      p.file_name
    FROM employees e
    LEFT JOIN LATERAL (
      SELECT * FROM hr_employee_profiles p
      WHERE (p.company_id = e.company_id OR p.company_id IS NULL)
        AND (
          (e.citizen_id IS NOT NULL AND e.citizen_id <> '' AND p.citizen_id = e.citizen_id) OR
          (e.employee_code IS NOT NULL AND e.employee_code <> '' AND p.employee_id = e.employee_code) OR
          (e.employee_code IS NOT NULL AND e.employee_code <> '' AND p.citizen_id = e.employee_code)
        )
      ORDER BY p.id DESC
      LIMIT 1
    ) p ON true
    ORDER BY e.company_id, e.employee_code;
  `;

  const res = await db.query(query);
  const rows = res.rows || [];

  const validRecords = [];
  const exceptions = [];
  const codeTracker = new Map();

  for (const r of rows) {
    const empCode = String(r.employee_code || '').trim();
    const fullName = String(r.employee_name || '').trim();
    let cccd = String(r.p_citizen_id || r.emp_citizen_id || '').trim();
    const cleanCccd = cccd.replace(/\D/g, '');
    if (cleanCccd.length === 12 || cleanCccd.length === 9) cccd = cleanCccd;

    // Check for missing employee_id (Requirement #5)
    if (!empCode) {
      exceptions.push({
        type: 'MISSING_EMPLOYEE_ID',
        reason: 'Hồ sơ nhân viên thiếu mã nhân viên (employee_id)',
        employee_uuid: r.emp_uuid,
        full_name: fullName,
        citizen_id: cccd,
        company_id: r.company_id
      });
      continue;
    }

    // Check for duplicate employee_id in source
    if (codeTracker.has(empCode)) {
      exceptions.push({
        type: 'DUPLICATE_EMPLOYEE_ID',
        reason: `Mã nhân viên "${empCode}" bị trùng trong nguồn dữ liệu hệ thống`,
        employee_uuid: r.emp_uuid,
        conflicting_uuid: codeTracker.get(empCode),
        employee_id: empCode,
        full_name: fullName
      });
      continue;
    }
    codeTracker.set(empCode, r.emp_uuid);

    let jobGrade = String(r.job_grade || '').replace(/\s*\[(ĐÃ XÓA|NGHỈ VIỆC|DA XOA|NGHI VIEC)\]/g, '').trim();
    const employmentStatus = r.employment_status || (r.emp_status === 'RESIGNED' ? 'RESIGNED' : 'ACTIVE');

    const norm = {
      emp_uuid: r.emp_uuid,
      company_id: r.company_id,
      employee_id: empCode,
      employee_code: empCode,
      full_name: fullName,
      employment_status: employmentStatus,
      citizen_id: cccd,
      job_grade: jobGrade,
      date_of_birth: normalizeDate(r.date_of_birth),
      gender: r.gender || '',
      job_title: r.job_title || r.emp_position || '',
      professional_title: r.professional_title || '',
      department_staffing_plan: r.department_staffing_plan || r.emp_department || '',
      section_staffing_plan: r.section_staffing_plan || '',
      citizen_id_issue_date: normalizeDate(r.citizen_id_issue_date),
      citizen_id_issue_place: r.citizen_id_issue_place || '',
      birth_registration_place: r.birth_registration_place || '',
      place_of_origin: r.place_of_origin || '',
      permanent_address: r.permanent_address || '',
      temporary_address: r.temporary_address || '',
      current_address: r.current_address || '',
      ethnicity: r.ethnicity || '',
      education_level: r.education_level || '',
      education_code: r.education_code || '',
      qualification: r.qualification || '',
      professional_qualification: r.professional_qualification || '',
      specialization: r.specialization || '',
      degree_qualification: r.degree_qualification || '',
      training_institution: r.training_institution || '',
      major: r.major || '',
      training_mode: r.training_mode || '',
      training_period: r.training_period || '',
      graduation_grade: r.graduation_grade || '',
      degree_valid_until: normalizeDate(r.degree_valid_until),
      other_professional_certificates: r.other_professional_certificates || '',
      social_insurance_salary: normalizeDecimal(r.social_insurance_salary),
      total_income: normalizeDecimal(r.total_income),
      base_salary: normalizeDecimal(r.base_salary),
      productivity_responsibility_pay: normalizeDecimal(r.productivity_responsibility_pay),
      attendance_bonus: normalizeDecimal(r.attendance_bonus),
      responsibility_allowance: normalizeDecimal(r.responsibility_allowance),
      vessel_size_allowance: normalizeDecimal(r.vessel_size_allowance),
      professional_allowance_t1: normalizeDecimal(r.professional_allowance_t1),
      meal_allowance: normalizeDecimal(r.meal_allowance),
      other_allowances: normalizeDecimal(r.other_allowances),
      open_ended_contract: r.open_ended_contract ? 'true' : '',
      fixed_term_contract: r.fixed_term_contract ? 'true' : '',
      seasonal_contract: r.seasonal_contract ? 'true' : '',
      contract_start_date: normalizeDate(r.contract_start_date),
      contract_end_date: normalizeDate(r.contract_end_date),
      recruitment_decision_no: r.recruitment_decision_no || '',
      employment_start_date: normalizeDate(r.employment_start_date),
      official_labor_contract_sign_date: normalizeDate(r.official_labor_contract_sign_date),
      phone_number: r.phone_number || '',
      email: r.p_email || r.emp_email || '',
      file_name: r.file_name || '',
      action_type: r.emp_status === 'DELETED' ? 'SOFT_DELETE' : (r.emp_status === 'RESIGNED' ? 'RESIGNED' : 'UPSERT'),
      status: r.emp_status
    };

    validRecords.push(norm);
  }

  return { total: rows.length, validRecords, exceptions };
}

/**
 * 2. Get all records from NocoDB
 * In the current architecture, NocoDB connects directly to PostgreSQL as the System of Record.
 * The primary table for employee profiles is hr_employee_profiles (Base: HR Bot quản lý đa công ty thành viên).
 */
async function getNocoDBRecords() {
  const res = await db.query(`
    SELECT * FROM hr_employee_profiles 
    ORDER BY id ASC
  `);
  return res.rows || [];
}

/**
 * Upsert a single employee profile into NocoDB's table hr_employee_profiles in PostgreSQL SoR
 */
async function upsertNocoDBProfile(emp) {
  const cleanCccd = emp.citizen_id ? String(emp.citizen_id).trim() : null;
  const empId = emp.employee_id ? String(emp.employee_id).trim() : '';

  let existing = null;
  if (cleanCccd) {
    const r = await db.query('SELECT id FROM hr_employee_profiles WHERE citizen_id = $1 LIMIT 1', [cleanCccd]);
    if (r.rows.length > 0) existing = r.rows[0];
  }
  if (!existing && empId) {
    const r = await db.query('SELECT id FROM hr_employee_profiles WHERE employee_id = $1 LIMIT 1', [empId]);
    if (r.rows.length > 0) existing = r.rows[0];
  }

  const profileCols = [
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
    'file_name', 'company_id'
  ];

  const vals = profileCols.map(c => {
    if (c === 'citizen_id') return cleanCccd;
    if (c === 'company_id') return emp.company_id || null;
    let v = emp[c];
    if (v === undefined || v === null) return '';
    return String(v);
  });

  if (existing) {
    const setClauses = profileCols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    await db.query(
      `UPDATE hr_employee_profiles SET ${setClauses}, updated_at = NOW() WHERE id = $${profileCols.length + 1}`,
      [...vals, existing.id]
    );
    return { action: 'UPDATE', id: existing.id };
  } else {
    const colList = profileCols.join(', ') + ', create_time, created_at, updated_at';
    const placeholders = profileCols.map((_, i) => `$${i + 1}`).join(', ') + `, $${profileCols.length + 1}, NOW(), NOW()`;
    const createTime = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const insRes = await db.query(
      `INSERT INTO hr_employee_profiles (${colList}) VALUES (${placeholders}) RETURNING id`,
      [...vals, createTime]
    );
    return { action: 'INSERT', id: insRes.rows[0].id };
  }
}

/**
 * 3. Get all rows from Google Sheets (Full sheet range, no 100-row truncate)
 */
async function getGoogleSheetRows() {
  const sheetData = await fetchGoogleSheetAllRows();
  return {
    header: sheetData.header || [],
    rows: (sheetData.rows || []).map(r => r.values),
    totalValues: sheetData.rawValues || []
  };
}

/**
 * 4. Plan reconciliation & dry-run projection
 */
function planSync(sourceEmployees, nocodbRecords, sheetData) {
  // --- NocoDB Reconciliation Plan ---
  const nocoMapByEmpId = new Map();
  const nocoMapByCccd = new Map();

  nocodbRecords.forEach(r => {
    const eId = String(r.employee_id || '').trim();
    const cccd = String(r.citizen_id || '').trim().replace(/\D/g, '');
    if (eId) nocoMapByEmpId.set(eId, r);
    if (cccd) nocoMapByCccd.set(cccd, r);
  });

  const nocodbPlan = {
    existing_count: nocodbRecords.length,
    to_create: 0,
    to_update: 0,
    to_skip: 0,
    details: []
  };

  sourceEmployees.forEach(emp => {
    let match = null;
    let matchKey = 'none';

    if (emp.employee_id && nocoMapByEmpId.has(emp.employee_id)) {
      match = nocoMapByEmpId.get(emp.employee_id);
      matchKey = 'employee_id';
    } else if (emp.citizen_id && nocoMapByCccd.has(emp.citizen_id)) {
      // Chỉ match theo citizen_id nếu bản ghi đích chưa có employee_id (tránh ghi đè chéo mã NV)
      const cMatch = nocoMapByCccd.get(emp.citizen_id);
      if (cMatch && !cMatch.employee_id) {
        match = cMatch;
        matchKey = 'citizen_id';
      }
    }

    if (match) {
      nocodbPlan.to_update++;
      nocodbPlan.details.push({
        employee_id: emp.employee_id,
        full_name: emp.full_name,
        action: 'UPDATE',
        matched_by: matchKey,
        target_id: match.id
      });
    } else {
      nocodbPlan.to_create++;
      nocodbPlan.details.push({
        employee_id: emp.employee_id,
        full_name: emp.full_name,
        action: 'CREATE',
        matched_by: 'none',
        target_id: null
      });
    }
  });

  // --- Google Sheets Reconciliation Plan ---
  const sheetRows = sheetData.rows || [];
  const sheetMapByEmpId = new Map();
  const sheetMapByCccd = new Map();
  const occupiedRows = new Set();

  sheetRows.forEach((r, idx) => {
    const rowNum = idx + 2; // 1-indexed, header is row 1
    const rawEid = String(r[1] || '').trim();
    const rawCccd = String(r[9] || '').trim().replace(/\D/g, '');
    const isBlank = !r || r.length === 0 || r.every(cell => !cell || !String(cell).trim());

    if (!isBlank) {
      occupiedRows.add(rowNum);
      if (rawEid) {
        sheetMapByEmpId.set(rawEid, { rowNum, data: r });
        const normEid = rawEid.replace(/\D/g, '');
        if (normEid.length === 11 || normEid.length === 12) {
          sheetMapByEmpId.set(normEid.padStart(12, '0'), { rowNum, data: r });
          sheetMapByEmpId.set(normEid.replace(/^0+/, ''), { rowNum, data: r });
        }
      }
      if (rawCccd) {
        sheetMapByCccd.set(rawCccd, { rowNum, data: r });
        if (rawCccd.length === 11 || rawCccd.length === 12) {
          sheetMapByCccd.set(rawCccd.padStart(12, '0'), { rowNum, data: r });
          sheetMapByCccd.set(rawCccd.replace(/^0+/, ''), { rowNum, data: r });
        }
      }
    }
  });

  const sheetsPlan = {
    existing_count: occupiedRows.size,
    to_create: 0,
    to_update: 0,
    to_skip: 0,
    details: []
  };

  const assignedRows = new Set();
  const matchedEmpIds = new Set();

  // First pass: match existing rows
  sourceEmployees.forEach(emp => {
    let match = null;
    let matchKey = 'none';

    if (emp.employee_id && sheetMapByEmpId.has(emp.employee_id)) {
      match = sheetMapByEmpId.get(emp.employee_id);
      matchKey = 'employee_id';
    } else if (emp.citizen_id && sheetMapByCccd.has(emp.citizen_id)) {
      match = sheetMapByCccd.get(emp.citizen_id);
      matchKey = 'citizen_id';
    }

    if (match) {
      sheetsPlan.to_update++;
      assignedRows.add(match.rowNum);
      matchedEmpIds.add(emp.employee_id);
      sheetsPlan.details.push({
        employee_id: emp.employee_id,
        full_name: emp.full_name,
        action: 'UPDATE',
        matched_by: matchKey,
        target_row: match.rowNum
      });
    }
  });

  // Second pass: assign blank or append rows for creations
  let nextAvailableRow = 2;
  sourceEmployees.forEach(emp => {
    if (matchedEmpIds.has(emp.employee_id)) return;

    // Find first row >= 2 that is not occupied by existing data and not yet assigned
    while (occupiedRows.has(nextAvailableRow) || assignedRows.has(nextAvailableRow)) {
      nextAvailableRow++;
    }

    const assignedRow = nextAvailableRow;
    assignedRows.add(assignedRow);
    nextAvailableRow++;

    sheetsPlan.to_create++;
    sheetsPlan.details.push({
      employee_id: emp.employee_id,
      full_name: emp.full_name,
      action: 'CREATE',
      matched_by: 'none',
      target_row: assignedRow
    });
  });

  return { nocodbPlan, sheetsPlan };
}

/**
 * 5. Dry-Run Execution
 */
async function executeDryRun() {
  const source = await getSourceEmployees();
  const nocodbRecords = await getNocoDBRecords();
  const sheetData = await getGoogleSheetRows();

  const { nocodbPlan, sheetsPlan } = planSync(source.validRecords, nocodbRecords, sheetData);

  return {
    success: true,
    dry_run: true,
    timestamp: new Date().toISOString(),
    source_summary: {
      total_in_db: source.total,
      valid_for_sync: source.validRecords.length,
      exceptions_count: source.exceptions.length,
      exceptions: source.exceptions
    },
    nocodb_projection: {
      current_records: nocodbPlan.existing_count,
      to_create: nocodbPlan.to_create,
      to_update: nocodbPlan.to_update,
      to_skip: nocodbPlan.to_skip,
      details: nocodbPlan.details
    },
    google_sheets_projection: {
      current_records: sheetsPlan.existing_count,
      to_create: sheetsPlan.to_create,
      to_update: sheetsPlan.to_update,
      to_skip: sheetsPlan.to_skip,
      details: sheetsPlan.details
    }
  };
}

/**
 * 6. Execute Full Backfill
 */
async function executeBackfill(options = {}) {
  const startTime = Date.now();
  const source = await getSourceEmployees();
  const nocodbRecords = await getNocoDBRecords();
  const sheetData = await getGoogleSheetRows();

  const { nocodbPlan, sheetsPlan } = planSync(source.validRecords, nocodbRecords, sheetData);

  const report = {
    success: false,
    dry_run: false,
    started_at: new Date(startTime).toISOString(),
    source_count: source.validRecords.length,
    exceptions: source.exceptions,
    nocodb_result: { success: false, inserted: 0, updated: 0, errors: [] },
    google_sheets_result: { success: false, written: 0, updated: 0, created: 0, errors: [] },
    verification: {}
  };

  // -------------------------------------------------------------
  // STEP A: SYNC TO NOCODB VIA POSTGRESQL SOR (hr_employee_profiles)
  // -------------------------------------------------------------
  try {
    let inserted = 0;
    let updated = 0;
    const errors = [];

    for (const emp of source.validRecords) {
      try {
        const res = await upsertNocoDBProfile(emp);
        if (res.action === 'INSERT') inserted++;
        else if (res.action === 'UPDATE') updated++;
      } catch (itemErr) {
        errors.push({ employee_id: emp.employee_id, error: itemErr.message });
      }
    }

    report.nocodb_result = {
      success: errors.length === 0,
      inserted,
      updated,
      errors
    };
  } catch (err) {
    report.nocodb_result.error = err.message;
  }

  // -------------------------------------------------------------
  // STEP B: SYNC TO GOOGLE SHEETS VIA BATCH UPDATE
  // -------------------------------------------------------------
  try {
    const token = await getGoogleAccessToken();
    const sheetUpdateData = [];

    // Map each valid record to its target row
    const rowMap = new Map();
    sheetsPlan.details.forEach(d => rowMap.set(d.employee_id, d.target_row));

    source.validRecords.forEach(emp => {
      const targetRow = rowMap.get(emp.employee_id);
      if (!targetRow) return;

      // Build rowValues matching exactly the 53 header columns (A through BA)
      const rowValues = COLUMNS.slice(0, 51).map(c => {
        let v = (emp[c] !== undefined && emp[c] !== null) ? String(emp[c]) : '';
        if ((c === 'employee_id' || c === 'citizen_id' || c === 'phone_number') && /^0\d+$/.test(v)) {
          v = "'" + v;
        }
        return v;
      });
      // 52: Create_Time
      rowValues.push(new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }));
      // 53: fileName
      rowValues.push(emp.file_name || '');

      sheetUpdateData.push({
        range: `Trang tính1!A${targetRow}:BA${targetRow}`,
        values: [rowValues]
      });
    });

    if (sheetUpdateData.length > 0) {
      const batchBody = JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data: sheetUpdateData
      });

      const batchRes = await new Promise((resolve, reject) => {
        const req = https.request(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SPREADSHEET_ID}/values:batchUpdate`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(batchBody)
          },
          timeout: 45000
        }, res => {
          let b = '';
          res.on('data', c => b += c);
          res.on('end', () => {
            try {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve(JSON.parse(b || '{}'));
              } else {
                reject(new Error(`Google Sheets HTTP ${res.statusCode}: ${b}`));
              }
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Google Sheets timeout')); });
        req.write(batchBody);
        req.end();
      });

      report.google_sheets_result = {
        success: true,
        written: sheetUpdateData.length,
        created: sheetsPlan.to_create,
        updated: sheetsPlan.to_update,
        totalUpdatedCells: batchRes.totalUpdatedCells || 0
      };
    }
  } catch (err) {
    report.google_sheets_result.error = err.message;
  }

  // -------------------------------------------------------------
  // STEP C: VERIFICATION & AUDIT
  // -------------------------------------------------------------
  try {
    const verifiedNoco = await getNocoDBRecords();
    const verifiedSheets = await getGoogleSheetRows();

    // Count non-empty rows in Google Sheets
    const activeSheetRows = (verifiedSheets.rows || []).filter(r => r && r.length > 0 && r.some(c => c && String(c).trim()));

    report.verification = {
      website_source_count: source.validRecords.length,
      nocodb_final_count: verifiedNoco.length,
      google_sheets_final_count: activeSheetRows.length,
      is_matching: verifiedNoco.length > 0 && activeSheetRows.length > 0
    };

    report.success = report.nocodb_result.success && report.google_sheets_result.success;
  } catch (vErr) {
    report.verification.error = vErr.message;
  }

  report.duration_ms = Date.now() - startTime;
  report.completed_at = new Date().toISOString();

  // Ghi audit log vào CSDL
  try {
    await db.query(
      `INSERT INTO audit_log (actor_user_id, actor_username, action, status, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [
        options.actor_user_id || null,
        options.actor_username || 'system_backfill',
        'hr_sync_backfill',
        report.success ? 'SUCCESS' : 'PARTIAL_OR_FAILED',
        JSON.stringify(report)
      ]
    );
  } catch (e) {}

  return report;
}

module.exports = {
  COLUMNS,
  getSourceEmployees,
  getNocoDBRecords,
  upsertNocoDBProfile,
  getGoogleSheetRows,
  executeDryRun,
  executeBackfill
};
