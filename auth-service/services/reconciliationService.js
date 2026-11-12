const db = require('../db');
const https = require('https');
const crypto = require('crypto');
const { getGoogleAccessToken, GOOGLE_SPREADSHEET_ID } = require('./googleAuthHelper');

const PROFILE_COLUMNS = [
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
  'file_name', 'company_id', 'uploaded_by'
];

/**
 * Fetch rows from Google Sheets (Trang tính1)
 */
async function fetchGoogleSheetRows() {
  if (!GOOGLE_SPREADSHEET_ID) {
    return { header: [], rows: [] };
  }
  try {
    const token = await getGoogleAccessToken();
    return await new Promise((resolve, reject) => {
      const req = https.get(
        `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SPREADSHEET_ID}/values/Trang%20t%C3%ADnh1!A1:BB100`,
        { headers: { 'Authorization': `Bearer ${token}` }, timeout: 15000 },
        (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(body || '{}');
              const values = json.values || [];
              const header = values[0] || [];
              const rows = values.slice(1);
              resolve({ header, rows, totalValues: values });
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Google Sheets timeout')); });
    });
  } catch (err) {
    console.warn('[ReconciliationService] Google Sheets Fetch Warning:', err.message);
    return { header: [], rows: [], error: err.message };
  }
}

/**
 * Append or Update a single employee row in Google Sheets
 */
async function upsertGoogleSheetRow(emp) {
  if (!GOOGLE_SPREADSHEET_ID) return { action: 'SKIPPED_NO_SHEET_ID' };
  const token = await getGoogleAccessToken();
  const sheetData = await fetchGoogleSheetRows();
  if (sheetData.error) throw new Error(sheetData.error);

  const empCode = String(emp.employee_code || emp.employee_id || '').trim().toUpperCase();
  const cccd = String(emp.citizen_id || '').trim().replace(/\D/g, '');

  let existingRowIndex = -1; // 1-indexed in Google Sheets API
  let firstEmptyRow = -1;
  sheetData.rows.forEach((r, idx) => {
    const isBlank = !r || r.length === 0 || r.every(cell => !cell || !String(cell).trim());
    if (isBlank) {
      if (firstEmptyRow === -1) firstEmptyRow = idx + 2;
    } else {
      const rCode = String(r[1] || '').trim().toUpperCase();
      const rCccd = String(r[9] || '').trim().replace(/\D/g, '');
      if ((empCode && rCode === empCode) || (cccd && rCccd === cccd)) {
        existingRowIndex = idx + 2; // +1 for 0-index, +1 for header
      }
    }
  });

  const targetRow = existingRowIndex > 0 ? existingRowIndex : (firstEmptyRow > 1 ? firstEmptyRow : (sheetData.rows.length + 2));

  const rowValues = [
    emp.job_grade || '',
    empCode,
    emp.full_name || emp.employee_name || '',
    emp.date_of_birth || '',
    emp.gender || '',
    emp.job_title || emp.position || '',
    emp.professional_title || '',
    emp.department_staffing_plan || emp.department || '',
    emp.section_staffing_plan || '',
    emp.citizen_id || '',
    emp.citizen_id_issue_date || '',
    emp.citizen_id_issue_place || '',
    emp.birth_registration_place || '',
    emp.place_of_origin || '',
    emp.permanent_address || '',
    emp.temporary_address || '',
    emp.current_address || '',
    emp.ethnicity || 'Kinh',
    emp.education_level || '',
    emp.education_code || '',
    emp.qualification || '',
    emp.professional_qualification || '',
    emp.specialization || '',
    emp.degree_qualification || '',
    emp.training_institution || '',
    emp.major || '',
    emp.training_mode || '',
    emp.training_period || '',
    emp.graduation_grade || '',
    emp.degree_valid_until || '',
    emp.other_professional_certificates || '',
    emp.social_insurance_salary || '',
    emp.total_income || '',
    emp.base_salary || '',
    emp.productivity_responsibility_pay || '',
    emp.attendance_bonus || '',
    emp.responsibility_allowance || '',
    emp.vessel_size_allowance || '',
    emp.professional_allowance_t1 || '',
    emp.meal_allowance || '',
    emp.other_allowances || '',
    emp.open_ended_contract || '',
    emp.fixed_term_contract || '',
    emp.seasonal_contract || '',
    emp.contract_start_date || '',
    emp.contract_end_date || '',
    emp.recruitment_decision_no || '',
    emp.employment_start_date || '',
    emp.official_labor_contract_sign_date || '',
    emp.phone_number || '',
    emp.email || '',
    new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    emp.file_name || '',
    emp.uploaded_by || ''
  ];

  await new Promise((resolve, reject) => {
    const body = JSON.stringify({ values: [rowValues] });
    const req = https.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SPREADSHEET_ID}/values/Trang%20t%C3%ADnh1!A${targetRow}:BB${targetRow}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 10000
      },
      res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(JSON.parse(raw)) : reject(new Error(`Sheets update failed HTTP ${res.statusCode}: ${raw}`)));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  return { action: existingRowIndex > 0 ? 'UPDATE' : 'INSERT', rowIndex: targetRow };
}

/**
 * Reconcile employee data across PostgreSQL SoR (employees), NocoDB (hr_employee_profiles), and Google Sheets
 */
async function reconcileEmployees({ autoFix = false, actor = 'system' } = {}) {
  const startTime = Date.now();

  // 1. Fetch official employees from PostgreSQL employees table
  const empRes = await db.query(`
    SELECT 
      e.id AS emp_uuid,
      e.employee_code,
      e.employee_name,
      e.company_id,
      e.department,
      e.position,
      e.email,
      e.citizen_id,
      e.status,
      e.person_id,
      e.employment_start_date,
      e.created_at,
      e.updated_at
    FROM employees e
    WHERE e.status != 'DELETED'
    ORDER BY e.company_id ASC, e.employee_code ASC
  `);
  const officialEmployees = empRes.rows || [];

  // 2. Fetch NocoDB records from hr_employee_profiles
  const nocoRes = await db.query(`
    SELECT *
    FROM hr_employee_profiles
    ORDER BY id ASC
  `);
  const nocodbProfiles = nocoRes.rows || [];

  // 3. Fetch Google Sheets records
  const sheetData = await fetchGoogleSheetRows();
  const sheetRows = (sheetData.rows || []).filter(r => r && r.length > 0 && r.some(c => c && String(c).trim()));

  // Maps for fast lookup
  const nocoByCode = new Map();
  const nocoByCccd = new Map();
  const nocoByUuid = new Map();

  nocodbProfiles.forEach(p => {
    if (p.employee_id) nocoByCode.set(String(p.employee_id).trim().toUpperCase(), p);
    if (p.citizen_id) {
      const clean = String(p.citizen_id).replace(/\D/g, '');
      if (clean) nocoByCccd.set(clean, p);
    }
    if (p.employment_id) nocoByUuid.set(String(p.employment_id).trim(), p);
  });

  const sheetsByCode = new Map();
  const sheetsByCccd = new Map();

  sheetRows.forEach((r, idx) => {
    const code = String(r[1] || '').trim().toUpperCase();
    const cccd = String(r[9] || '').replace(/\D/g, '');
    if (code) sheetsByCode.set(code, { row: r, index: idx + 2 });
    if (cccd) sheetsByCccd.set(cccd, { row: r, index: idx + 2 });
  });

  const missingInNoco = [];
  const missingInSheets = [];
  const statusMismatches = [];
  const fixedInNoco = [];
  const fixedInSheets = [];

  for (const emp of officialEmployees) {
    const code = String(emp.employee_code || '').trim().toUpperCase();
    const cleanCccd = String(emp.citizen_id || '').replace(/\D/g, '');
    const uuid = String(emp.emp_uuid || '').trim();

    // Check NocoDB
    let profile = nocoByCode.get(code) || (cleanCccd ? nocoByCccd.get(cleanCccd) : null) || (uuid ? nocoByUuid.get(uuid) : null);
    if (!profile) {
      missingInNoco.push({
        employee_code: emp.employee_code,
        employee_name: emp.employee_name,
        company_id: emp.company_id,
        citizen_id: emp.citizen_id,
        status: emp.status,
        emp_uuid: emp.emp_uuid
      });

      if (autoFix) {
        try {
          // Find staging data if available for rich 53-field profile
          const stagRes = await db.query(`
            SELECT s.*
            FROM hr_employee_staging s
            WHERE s.staging_status = 'approved'
              AND (
                (s.employee_code IS NOT NULL AND s.employee_code <> '' AND UPPER(s.employee_code) = $1) OR
                (s.citizen_id IS NOT NULL AND s.citizen_id <> '' AND s.citizen_id = $2)
              )
            ORDER BY s.id DESC
            LIMIT 1
          `, [code, emp.citizen_id || '']);

          const ext = (stagRes.rows[0] && stagRes.rows[0].extracted_data) || {};
          const sRow = stagRes.rows[0] || {};

          const profileData = {
            employment_id: emp.emp_uuid,
            job_grade: ext.job_grade || '',
            employee_id: emp.employee_code,
            full_name: emp.employee_name,
            date_of_birth: sRow.date_of_birth || ext.date_of_birth || '',
            gender: sRow.gender || ext.gender || '',
            job_title: emp.position || sRow.job_title || ext.job_title || '',
            professional_title: ext.professional_title || '',
            department_staffing_plan: emp.department || sRow.department || ext.department_staffing_plan || '',
            section_staffing_plan: ext.section_staffing_plan || '',
            citizen_id: emp.citizen_id || sRow.citizen_id || '',
            citizen_id_issue_date: ext.citizen_id_issue_date || '',
            citizen_id_issue_place: ext.citizen_id_issue_place || '',
            birth_registration_place: ext.birth_registration_place || '',
            place_of_origin: ext.place_of_origin || '',
            permanent_address: ext.permanent_address || '',
            temporary_address: ext.temporary_address || '',
            current_address: ext.current_address || '',
            ethnicity: ext.ethnicity || 'Kinh',
            education_level: ext.education_level || '',
            education_code: ext.education_code || '',
            qualification: ext.qualification || '',
            professional_qualification: ext.professional_qualification || '',
            specialization: ext.specialization || '',
            degree_qualification: ext.degree_qualification || '',
            training_institution: ext.training_institution || '',
            major: ext.major || '',
            training_mode: ext.training_mode || '',
            training_period: ext.training_period || '',
            graduation_grade: ext.graduation_grade || '',
            degree_valid_until: ext.degree_valid_until || '',
            other_professional_certificates: ext.other_professional_certificates || '',
            social_insurance_salary: ext.social_insurance_salary || '',
            total_income: ext.total_income || '',
            base_salary: sRow.base_salary || ext.base_salary || '',
            productivity_responsibility_pay: ext.productivity_responsibility_pay || '',
            attendance_bonus: ext.attendance_bonus || '',
            responsibility_allowance: ext.responsibility_allowance || '',
            vessel_size_allowance: ext.vessel_size_allowance || '',
            professional_allowance_t1: ext.professional_allowance_t1 || '',
            meal_allowance: ext.meal_allowance || '',
            other_allowances: ext.other_allowances || '',
            open_ended_contract: ext.open_ended_contract || '',
            fixed_term_contract: ext.fixed_term_contract || '',
            seasonal_contract: ext.seasonal_contract || '',
            contract_start_date: ext.contract_start_date || '',
            contract_end_date: ext.contract_end_date || '',
            recruitment_decision_no: sRow.recruitment_decision_no || ext.recruitment_decision_no || '',
            employment_start_date: emp.employment_start_date || sRow.employment_start_date || ext.employment_start_date || '',
            official_labor_contract_sign_date: ext.official_labor_contract_sign_date || '',
            phone_number: sRow.phone_number || ext.phone_number || '',
            email: emp.email || sRow.email || ext.email || '',
            file_name: sRow.file_name || ext.file_name || '',
            company_id: emp.company_id,
            status: emp.status
          };

          const cols = PROFILE_COLUMNS.slice();
          const vals = cols.map(c => profileData[c] !== undefined ? String(profileData[c]) : '');

          const colList = cols.join(', ') + ', status, employment_id, create_time, created_at, updated_at';
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ') + `, $${cols.length + 1}, $${cols.length + 2}, $${cols.length + 3}, NOW(), NOW()`;
          const createTime = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

          const insRes = await db.query(
            `INSERT INTO hr_employee_profiles (${colList}) VALUES (${placeholders}) RETURNING id`,
            [...vals, emp.status, emp.emp_uuid, createTime]
          );

          fixedInNoco.push({
            employee_code: emp.employee_code,
            profile_id: insRes.rows[0].id,
            action: 'INSERTED_TO_NOCODB'
          });
        } catch (repairErr) {
          console.error(`[ReconciliationService] Error repairing profile for ${emp.employee_code}:`, repairErr);
        }
      }
    } else {
      // Check status consistency
      if (profile.status !== emp.status) {
        statusMismatches.push({
          employee_code: emp.employee_code,
          emp_status: emp.status,
          profile_status: profile.status
        });
        if (autoFix) {
          await db.query('UPDATE hr_employee_profiles SET status = $1, updated_at = NOW() WHERE id = $2', [emp.status, profile.id]);
        }
      }
    }

    // Check Google Sheets
    const inSheets = sheetsByCode.get(code) || (cleanCccd ? sheetsByCccd.get(cleanCccd) : null);
    if (!inSheets && !sheetData.error) {
      missingInSheets.push({
        employee_code: emp.employee_code,
        employee_name: emp.employee_name,
        company_id: emp.company_id
      });

      if (autoFix) {
        try {
          // Prepare enriched data for Sheets
          const enriched = profile || emp;
          await upsertGoogleSheetRow(enriched);
          fixedInSheets.push({
            employee_code: emp.employee_code,
            action: 'APPENDED_TO_SHEETS'
          });
        } catch (sheetFixErr) {
          console.error(`[ReconciliationService] Error fixing Sheets for ${emp.employee_code}:`, sheetFixErr);
        }
      }
    }
  }

  // Check for orphan records in hr_employee_profiles (profiles without matching employee in employees master)
  const officialCodeSet = new Set(officialEmployees.map(e => String(e.employee_code || '').trim().toUpperCase()));
  const officialCccdSet = new Set(officialEmployees.map(e => String(e.citizen_id || '').replace(/\D/g, '')).filter(Boolean));
  const orphanedInNoco = [];

  nocodbProfiles.forEach(p => {
    const pCode = String(p.employee_id || '').trim().toUpperCase();
    const pCccd = String(p.citizen_id || '').replace(/\D/g, '');
    const isMatched = (pCode && officialCodeSet.has(pCode)) || (pCccd && officialCccdSet.has(pCccd));
    if (!isMatched && p.status !== 'DELETED') {
      orphanedInNoco.push({
        id: p.id,
        employee_id: p.employee_id,
        full_name: p.full_name,
        status: p.status
      });
    }
  });

  // Detect and clean stale rows in Google Sheets if autoFix is enabled
  const validMatchedSheetRows = sheetRows.filter(r => officialCodeSet.has(String(r[1] || '').trim().toUpperCase()));
  if (autoFix && GOOGLE_SPREADSHEET_ID && sheetRows.length > officialEmployees.length) {
    try {
      const clearStartRow = officialEmployees.length + 2;
      const token = await getGoogleAccessToken();
      await new Promise((resolve, reject) => {
        const req = https.request(
          `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SPREADSHEET_ID}/values/` + encodeURIComponent(`Trang tính1!A${clearStartRow}:BA100`) + ':clear',
          { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } },
          res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`Clear failed ${res.statusCode}: ${d}`)));
          }
        );
        req.on('error', reject);
        req.end();
      });
    } catch (clearErr) {
      console.warn('[ReconciliationService] Auto-clean stale Google Sheets rows warning:', clearErr.message);
    }
  }

  const isConsistent = missingInNoco.length === 0 && (GOOGLE_SPREADSHEET_ID ? missingInSheets.length === 0 : true) && statusMismatches.length === 0;

  const result = {
    is_consistent: isConsistent,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    actor,
    counts: {
      website_postgres: officialEmployees.length,
      nocodb: nocodbProfiles.length + fixedInNoco.length,
      google_sheets: GOOGLE_SPREADSHEET_ID ? (validMatchedSheetRows.length + fixedInSheets.length) : null
    },
    reconciled_count: officialEmployees.length - missingInNoco.length + fixedInNoco.length,
    missing_in_nocodb: missingInNoco,
    missing_in_sheets: missingInSheets,
    status_mismatches: statusMismatches,
    orphaned_in_nocodb: orphanedInNoco,
    fixed_in_nocodb: fixedInNoco,
    fixed_in_sheets: fixedInSheets
  };

  return result;
}

module.exports = {
  reconcileEmployees,
  fetchGoogleSheetRows,
  upsertGoogleSheetRow,
  PROFILE_COLUMNS
};
