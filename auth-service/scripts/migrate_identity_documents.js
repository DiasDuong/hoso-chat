/**
 * SOTRANS HUB — PHASE 3.2: BACKFILL SCRIPT
 * Di chuyển 6 nhân sự Master hiện hữu sang mô hình Person - Employment - Identity
 */

const { Pool } = require('pg');
const {
  canonicalizeIdentity,
  computeBlindIndex,
  maskIdentityNumber,
  encryptDocNumber
} = require('../services/identitySecurityService');

// Trong container, host là postgres-staging hoặc PG_HOST từ biến môi trường
const pool = new Pool({
  host: process.env.PG_HOST || 'postgres-staging',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE || 'sotrans_staging',
  user: process.env.PG_USER || 'staging_admin',
  password: process.env.PG_PASSWORD || 'Staging_Secure_Pass_2026_!@#$'
});

async function runBackfill() {
  const client = await pool.connect();
  console.log('>>> BẮT ĐẦU BACKFILL DỮ LIỆU HISTORICAL RECONCILIATION...');

  try {
    await client.query('BEGIN');

    // 1. Lấy danh sách employees chưa có liên kết person_id
    const empRes = await client.query(`
      SELECT 
        e.*,
        p.id AS profile_pk,
        p.full_name AS profile_full_name,
        p.date_of_birth AS profile_dob,
        p.gender AS profile_gender,
        p.permanent_address AS profile_permanent_address,
        p.temporary_address AS profile_temporary_address,
        p.current_address AS profile_current_address,
        p.birth_registration_place AS profile_birth_place,
        p.place_of_origin AS profile_place_origin,
        p.ethnicity AS profile_ethnicity,
        p.education_level AS profile_edu_level,
        p.education_code AS profile_edu_code,
        p.qualification AS profile_qualification,
        p.major AS profile_major,
        p.specialization AS profile_specialization,
        p.degree_qualification AS profile_degree,
        p.training_institution AS profile_institution,
        p.training_mode AS profile_mode,
        p.training_period AS profile_period,
        p.graduation_grade AS profile_grade,
        p.degree_valid_until AS profile_degree_until,
        p.other_professional_certificates AS profile_certs,
        p.phone_number AS profile_phone,
        p.email AS profile_email,
        p.citizen_id_issue_date,
        p.citizen_id_issue_place,
        p.base_salary,
        p.total_income,
        p.social_insurance_salary,
        p.recruitment_decision_no,
        p.employment_start_date AS profile_start_date
      FROM employees e
      LEFT JOIN hr_employee_profiles p ON p.employee_id = e.employee_code
      WHERE e.person_id IS NULL
      ORDER BY e.employee_code ASC;
    `);

    console.log(`Tìm thấy ${empRes.rows.length} bản ghi employees chưa có person_id cần backfill.`);
    if (empRes.rows.length === 0) {
      console.log('✅ Tất cả nhân sự Master đã có person_id liên kết hợp lệ. Không cần backfill thêm.');
      await client.query('COMMIT');
      return;
    }

    const mapping = [];

    for (const row of empRes.rows) {
      console.log(`\nĐang xử lý: ${row.employee_code} - ${row.employee_name} (${row.company_id})...`);

      // Chuẩn hóa ngày sinh
      let dob = null;
      if (row.profile_dob && row.profile_dob.trim()) {
        const dStr = row.profile_dob.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(dStr)) {
          dob = dStr;
        } else if (/^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(dStr)) {
          const parts = dStr.split(/[/-]/);
          dob = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
        }
      }

      // Chuẩn hóa giới tính
      let gender = 'KHAC';
      const gRaw = String(row.profile_gender || '').trim().toLowerCase();
      if (gRaw.includes('nam')) gender = 'NAM';
      else if (gRaw.includes('nữ') || gRaw.includes('nu')) gender = 'NU';

      // 1. Tạo hr_persons
      const personInsert = await client.query(`
        INSERT INTO hr_persons (
          full_name,
          date_of_birth,
          gender,
          birth_registration_place,
          place_of_origin,
          permanent_address,
          temporary_address,
          current_address,
          ethnicity,
          education_level,
          education_code,
          qualification,
          major,
          specialization,
          degree_qualification,
          training_institution,
          training_mode,
          training_period,
          graduation_grade,
          degree_valid_until,
          other_professional_certificates,
          phone_number,
          personal_email,
          status,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, 'ACTIVE', $24, NOW()
        ) RETURNING id;
      `, [
        row.employee_name,
        dob,
        gender,
        row.profile_birth_place || '',
        row.profile_place_origin || '',
        row.profile_permanent_address || '',
        row.profile_temporary_address || '',
        row.profile_current_address || '',
        row.profile_ethnicity || '',
        row.profile_edu_level || '',
        row.profile_edu_code || '',
        row.profile_qualification || '',
        row.profile_major || '',
        row.profile_specialization || '',
        row.profile_degree || '',
        row.profile_institution || '',
        row.profile_mode || '',
        row.profile_period || '',
        row.profile_grade || '',
        row.profile_degree_until || '',
        row.profile_certs || '',
        row.profile_phone || '',
        row.profile_email || '',
        row.created_at
      ]);

      const personId = personInsert.rows[0].id;
      console.log(`  -> Tạo hr_persons: ${personId}`);

      // 2. Cập nhật employees.person_id và employment_start_date
      let startDate = null;
      if (row.profile_start_date && /^\d{4}-\d{2}-\d{2}$/.test(row.profile_start_date.trim())) {
        startDate = row.profile_start_date.trim();
      }
      await client.query(`
        UPDATE employees 
        SET person_id = $1,
            employment_start_date = COALESCE($2, employment_start_date),
            updated_at = NOW()
        WHERE id = $3;
      `, [personId, startDate, row.id]);
      console.log(`  -> Cập nhật employees: person_id = ${personId}`);

      // 3. Cập nhật hr_employee_profiles.employment_id
      if (row.profile_pk) {
        await client.query(`
          UPDATE hr_employee_profiles
          SET employment_id = $1,
              updated_at = NOW()
          WHERE id = $2;
        `, [row.id, row.profile_pk]);
        console.log(`  -> Cập nhật hr_employee_profiles (id=${row.profile_pk}): employment_id = ${row.id}`);
      }

      // 4. Mã hóa và lưu giấy tờ định danh (hr_person_identity_documents)
      const cccd = String(row.citizen_id || '').trim();
      if (cccd) {
        const canonical = canonicalizeIdentity('CCCD', 'VNM', cccd);
        const hmac = computeBlindIndex(canonical, 1);
        const masked = maskIdentityNumber(cccd);
        const enc = encryptDocNumber(cccd, 'kms-key-v1');

        let issueDate = null;
        if (row.citizen_id_issue_date && /^\d{4}-\d{2}-\d{2}$/.test(row.citizen_id_issue_date.trim())) {
          issueDate = row.citizen_id_issue_date.trim();
        }

        await client.query(`
          INSERT INTO hr_person_identity_documents (
            person_id,
            doc_type,
            country_code,
            doc_number_encrypted,
            iv,
            auth_tag,
            encryption_key_id,
            doc_number_hmac,
            hmac_key_version,
            masked_number,
            issue_date,
            issue_place,
            is_primary,
            lifecycle_status,
            verification_status,
            created_at,
            updated_at
          ) VALUES (
            $1, 'CCCD', 'VNM', $2, $3, $4, $5, $6, 1, $7, $8, $9, true, 'ACTIVE', 'LEGACY_UNVERIFIED', $10, NOW()
          );
        `, [
          personId,
          enc.encryptedBytes,
          enc.iv,
          enc.authTag,
          enc.keyId,
          hmac,
          masked,
          issueDate,
          row.citizen_id_issue_place || '',
          row.created_at
        ]);
        console.log(`  -> Tạo hr_person_identity_documents: masked = ${masked}, hmac = ${hmac.substring(0, 16)}...`);
      }

      // 5. Ghi lịch sử tiếp nhận ban đầu (hr_employment_history)
      await client.query(`
        INSERT INTO hr_employment_history (
          employment_id,
          person_id,
          event_type,
          to_company_id,
          to_department,
          to_position,
          to_status,
          decision_no,
          actor_username,
          created_at
        ) VALUES (
          $1, $2, 'ONBOARDING', $3, $4, $5, 'ACTIVE', $6, 'SYSTEM_BACKFILL', $7
        );
      `, [
        row.id,
        personId,
        row.company_id,
        row.department || '',
        row.position || '',
        row.recruitment_decision_no || '',
        row.created_at
      ]);

      // 6. Ghi thông tin lương (hr_employment_compensation) nếu có
      const baseSalaryNum = parseFloat(String(row.base_salary || '0').replace(/[^\d.]/g, '')) || 0;
      const totalIncomeNum = parseFloat(String(row.total_income || '0').replace(/[^\d.]/g, '')) || 0;
      const socialSalaryNum = parseFloat(String(row.social_insurance_salary || '0').replace(/[^\d.]/g, '')) || 0;

      if (baseSalaryNum > 0 || totalIncomeNum > 0) {
        await client.query(`
          INSERT INTO hr_employment_compensation (
            employment_id,
            effective_from,
            base_salary,
            total_income,
            social_insurance_salary,
            decision_no,
            is_current,
            created_by,
            created_at
          ) VALUES (
            $1, COALESCE($2, CURRENT_DATE), $3, $4, $5, $6, true, 'SYSTEM_BACKFILL', $7
          );
        `, [
          row.id,
          startDate,
          baseSalaryNum,
          totalIncomeNum,
          socialSalaryNum,
          row.recruitment_decision_no || '',
          row.created_at
        ]);
      }

      mapping.push({
        employee_code: row.employee_code,
        employee_id: row.id,
        person_id: personId,
        citizen_id: cccd,
        masked: maskIdentityNumber(cccd)
      });
    }

    // Commit Transaction
    await client.query('COMMIT');
    console.log('\n>>> BACKFILL THÀNH CÔNG VÀ ĐÃ COMMIT VÀO CSDL!');
    console.table(mapping);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('>>> LỖI BACKFILL, ĐÃ ROLLBACK:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runBackfill()
  .then(() => {
    console.log('Hoàn thành xuất sắc tiến trình Backfill Phase 3.2.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Thất bại tiến trình Backfill:', err);
    process.exit(1);
  });
