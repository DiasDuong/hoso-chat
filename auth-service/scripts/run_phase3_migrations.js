/**
 * SOTRANS HUB — PHASE 3 CONTROLLED MIGRATION RUNNER
 * Single unified runner executing database migrations, sequence calibrations,
 * and data backfill in exact dependency order with strict idempotency.
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const {
  canonicalizeIdentity,
  computeBlindIndex,
  maskIdentityNumber,
  encryptDocNumber
} = require('../services/identitySecurityService');

const pool = new Pool({
  host: process.env.PG_HOST || 'postgres-staging',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE || 'sotrans_staging',
  user: process.env.PG_USER || 'staging_admin',
  password: process.env.PG_PASSWORD || 'Staging_Secure_Pass_2026_!@#$'
});

async function runStep(name, fn) {
  const start = Date.now();
  process.stdout.write(`⏳ [${name}] ... `);
  try {
    const result = await fn();
    const elapsed = Date.now() - start;
    console.log(`✅ THÀNH CÔNG (${elapsed}ms)`);
    if (result && typeof result === 'string') {
      console.log(`   ↳ ${result}`);
    }
    return result;
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`❌ THẤT BẠI (${elapsed}ms)`);
    console.error(`   ↳ Lỗi: ${err.message}`);
    throw err;
  }
}

async function main() {
  console.log('================================================================');
  console.log('🚀 SOTRANS HUB — PHASE 3 MASTER MIGRATION RUNNER');
  console.log(`   Target Host: ${process.env.PG_HOST || 'postgres-staging'}:${process.env.PG_PORT || '5432'}`);
  console.log(`   Database:    ${process.env.PG_DATABASE || 'sotrans_staging'}`);
  console.log(`   User:        ${process.env.PG_USER || 'staging_admin'}`);
  console.log(`   Timestamp:   ${new Date().toISOString()}`);
  console.log('================================================================\n');

  const client = await pool.connect();

  try {
    // -------------------------------------------------------------
    // BƯỚC 1: PRE-FLIGHT HEALTH & SCHEMA CHECK
    // -------------------------------------------------------------
    await runStep('BƯỚC 1: Kiểm tra kết nối CSDL và dữ liệu hiện hữu', async () => {
      const res = await client.query('SELECT version(), current_database()');
      const empCount = await client.query('SELECT count(*) FROM employees');
      return `Database: ${res.rows[0].current_database}, Hiện có: ${empCount.rows[0].count} nhân viên Master.`;
    });

    // -------------------------------------------------------------
    // BƯỚC 2: SQL MIGRATION 01 - PERSON-EMPLOYMENT FOUNDATION
    // -------------------------------------------------------------
    await runStep('BƯỚC 2: Áp dụng SQL Foundation (hr_persons, sequences, constraints)', async () => {
      let migrationPath = path.resolve(__dirname, '../migrations/20261110_phase3_01_person_employment_foundation.sql');
      if (!fs.existsSync(migrationPath)) {
        migrationPath = path.resolve(__dirname, '../../sql/migrations/20261110_phase3_01_person_employment_foundation.sql');
      }
      if (!fs.existsSync(migrationPath)) {
        throw new Error(`Không tìm thấy file migration tại: ${migrationPath}`);
      }
      const sqlContent = fs.readFileSync(migrationPath, 'utf8');
      await client.query(sqlContent);
      return 'Bảng hr_persons, hr_person_identity_documents, sequences và views đã được thiết lập.';
    });

    // -------------------------------------------------------------
    // BƯỚC 3: SQL MIGRATION 02 - INDEXES
    // -------------------------------------------------------------
    await runStep('BƯỚC 3: Áp dụng Indexes tối ưu hóa truy vấn', async () => {
      let indexMigrationPath = path.resolve(__dirname, '../migrations/20261110_phase3_03_indexes.sql');
      if (!fs.existsSync(indexMigrationPath)) {
        indexMigrationPath = path.resolve(__dirname, '../../sql/migrations/20261110_phase3_03_indexes.sql');
      }
      if (!fs.existsSync(indexMigrationPath)) {
        throw new Error(`Không tìm thấy file indexes tại: ${indexMigrationPath}`);
      }
      const indexSql = fs.readFileSync(indexMigrationPath, 'utf8');
      await client.query(indexSql);
      return 'Toàn bộ indexes trên hr_persons, identity_documents, outbox và employees đã sẵn sàng.';
    });

    // -------------------------------------------------------------
    // BƯỚC 4: BACKFILL DATA - HISTORICAL RECONCILIATION
    // -------------------------------------------------------------
    await runStep('BƯỚC 4: Backfill nhân viên hiện hữu sang Person - Employment - Identity', async () => {
      const empRes = await client.query(`
        SELECT 
          e.*,
          p.id AS profile_pk,
          p.full_name AS profile_full_name,
          p.date_of_birth AS profile_dob,
          p.gender AS profile_gender,
          p.birth_registration_place AS profile_birth_place,
          p.place_of_origin AS profile_place_origin,
          p.permanent_address AS profile_permanent_address,
          p.temporary_address AS profile_temporary_address,
          p.current_address AS profile_current_address,
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

      if (empRes.rows.length === 0) {
        return 'Tất cả nhân viên Master đã có person_id. Không có bản ghi cần backfill.';
      }

      await client.query('BEGIN');
      try {
        let backfilledCount = 0;
        for (const row of empRes.rows) {
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

          let gender = 'KHAC';
          const gRaw = String(row.profile_gender || '').trim().toLowerCase();
          if (gRaw.includes('nam')) gender = 'NAM';
          else if (gRaw.includes('nữ') || gRaw.includes('nu')) gender = 'NU';

          // 1. Tạo hr_persons
          const personInsert = await client.query(`
            INSERT INTO hr_persons (
              full_name, date_of_birth, gender, birth_registration_place,
              place_of_origin, permanent_address, temporary_address, current_address,
              ethnicity, education_level, education_code, qualification,
              major, specialization, degree_qualification, training_institution,
              training_mode, training_period, graduation_grade, degree_valid_until,
              other_professional_certificates, phone_number, personal_email, status,
              created_at, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
              $21, $22, $23, 'ACTIVE', $24, NOW()
            ) RETURNING id;
          `, [
            row.employee_name, dob, gender,
            row.profile_birth_place || '', row.profile_place_origin || '',
            row.profile_permanent_address || '', row.profile_temporary_address || '',
            row.profile_current_address || '', row.profile_ethnicity || '',
            row.profile_edu_level || '', row.profile_edu_code || '',
            row.profile_qualification || '', row.profile_major || '',
            row.profile_specialization || '', row.profile_degree || '',
            row.profile_institution || '', row.profile_mode || '',
            row.profile_period || '', row.profile_grade || '',
            row.profile_degree_until || '', row.profile_certs || '',
            row.profile_phone || '', row.profile_email || '',
            row.created_at
          ]);

          const personId = personInsert.rows[0].id;

          // 2. Cập nhật employees
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

          // 3. Cập nhật hr_employee_profiles
          if (row.profile_pk) {
            await client.query(`
              UPDATE hr_employee_profiles
              SET employment_id = $1, updated_at = NOW()
              WHERE id = $2;
            `, [row.id, row.profile_pk]);
          }

          // 4. Mã hóa CCCD
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
                person_id, doc_type, country_code, doc_number_encrypted,
                iv, auth_tag, encryption_key_id, doc_number_hmac, hmac_key_version,
                masked_number, issue_date, issue_place, is_primary, lifecycle_status,
                verification_status, created_at, updated_at
              ) VALUES (
                $1, 'CCCD', 'VNM', $2, $3, $4, $5, $6, 1, $7, $8, $9, true, 'ACTIVE', 'LEGACY_UNVERIFIED', $10, NOW()
              ) ON CONFLICT DO NOTHING;
            `, [
              personId, enc.encryptedBytes, enc.iv, enc.authTag, enc.keyId,
              hmac, masked, issueDate, row.citizen_id_issue_place || '', row.created_at
            ]);
          }

          // 5. Ghi lịch sử tiếp nhận
          await client.query(`
            INSERT INTO hr_employment_history (
              employment_id, person_id, event_type, to_company_id,
              to_department, to_position, to_status, decision_no,
              actor_username, created_at
            ) VALUES (
              $1, $2, 'ONBOARDING', $3, $4, $5, 'ACTIVE', $6, 'SYSTEM_BACKFILL', $7
            );
          `, [
            row.id, personId, row.company_id, row.department || '',
            row.position || '', row.recruitment_decision_no || '', row.created_at
          ]);

          backfilledCount++;
        }

        await client.query('COMMIT');
        return `Đã đối soát và backfill thành công ${backfilledCount} nhân viên.`;
      } catch (backfillErr) {
        await client.query('ROLLBACK');
        throw backfillErr;
      }
    });

    // -------------------------------------------------------------
    // BƯỚC 5: POST-FLIGHT VALIDATION & SEQUENCE CALIBRATION CHECK
    // -------------------------------------------------------------
    await runStep('BƯỚC 5: Hậu kiểm tính toàn vẹn và hiệu chuẩn Sequences', async () => {
      // 1. Kiểm tra không còn orphan employees
      const orphanCheck = await client.query('SELECT count(*) FROM employees WHERE person_id IS NULL');
      const unlinkedCount = parseInt(orphanCheck.rows[0].count, 10);
      if (unlinkedCount > 0) {
        throw new Error(`Phát hiện ${unlinkedCount} nhân viên chưa liên kết person_id!`);
      }

      // 2. Kiểm tra sequences
      const seqCheck = await client.query(`
        SELECT 'stl' as seq, last_value FROM seq_employee_code_stl
        UNION ALL
        SELECT 'vtx', last_value FROM seq_employee_code_vtx
        UNION ALL
        SELECT 'swc', last_value FROM seq_employee_code_swc
      `);

      // 3. Kiểm tra max codes
      const maxCodes = await client.query(`
        SELECT 'STL' as comp, COALESCE(MAX(NULLIF(regexp_replace(employee_code, '^[A-Za-z]+', ''), '')::integer), 0) as max_num FROM employees WHERE employee_code ~ '^STL[0-9]+$'
        UNION ALL
        SELECT 'VTX', COALESCE(MAX(NULLIF(regexp_replace(employee_code, '^[A-Za-z]+', ''), '')::integer), 0) as max_num FROM employees WHERE employee_code ~ '^VTX[0-9]+$'
        UNION ALL
        SELECT 'SWC', COALESCE(MAX(NULLIF(regexp_replace(employee_code, '^[A-Za-z]+', ''), '')::integer), 0) as max_num FROM employees WHERE employee_code ~ '^SWC[0-9]+$'
      `);

      const seqMap = Object.fromEntries(seqCheck.rows.map(r => [r.seq.toUpperCase(), parseInt(r.last_value, 10)]));
      const maxMap = Object.fromEntries(maxCodes.rows.map(r => [r.comp, parseInt(r.max_num, 10)]));

      for (const comp of ['STL', 'VTX', 'SWC']) {
        if (seqMap[comp] < maxMap[comp]) {
          throw new Error(`Sequence ${comp} (${seqMap[comp]}) nhỏ hơn mã lớn nhất hiện hữu (${maxMap[comp]})!`);
        }
      }

      return `Zero unlinked records. Sequences validated: STL=${seqMap['STL']} (max=${maxMap['STL']}), VTX=${seqMap['VTX']} (max=${maxMap['VTX']}), SWC=${seqMap['SWC']} (max=${maxMap['SWC']}).`;
    });

    console.log('\n================================================================');
    console.log('🎉 TOÀN BỘ TIẾN TRÌNH MIGRATION & BACKFILL HOÀN TẤT THÀNH CÔNG 100%!');
    console.log('   Môi trường đã sẵn sàng cho vận hành và kiểm thử.');
    console.log('================================================================');
    process.exit(0);

  } catch (err) {
    console.error('\n💥 TIẾN TRÌNH MIGRATION THẤT BẠI:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Lỗi khởi động runner:', err);
  process.exit(1);
});
