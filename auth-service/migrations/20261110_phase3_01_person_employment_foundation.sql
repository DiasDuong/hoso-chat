-- ==============================================================================
-- SOTRANS HUB — PHASE 3.1: MIGRATION 01
-- FOUNDATION: hr_persons, hr_person_identity_documents, hr_employment_history,
-- hr_employment_documents, hr_employment_compensation, View hr_employments, Sequences
-- ==============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "unaccent";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. BẢNG THỰC THỂ CÁ NHÂN (hr_persons)
CREATE TABLE IF NOT EXISTS hr_persons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name VARCHAR(255) NOT NULL,
    normalized_name VARCHAR(255) NOT NULL,
    date_of_birth DATE,
    gender VARCHAR(20) DEFAULT 'KHAC',
    birth_registration_place VARCHAR(255) DEFAULT '',
    place_of_origin VARCHAR(255) DEFAULT '',
    permanent_address TEXT DEFAULT '',
    temporary_address TEXT DEFAULT '',
    current_address TEXT DEFAULT '',
    ethnicity VARCHAR(50) DEFAULT '',
    education_level VARCHAR(100) DEFAULT '',
    education_code VARCHAR(50) DEFAULT '',
    qualification VARCHAR(255) DEFAULT '',
    major VARCHAR(255) DEFAULT '',
    specialization VARCHAR(255) DEFAULT '',
    degree_qualification VARCHAR(255) DEFAULT '',
    training_institution VARCHAR(255) DEFAULT '',
    training_mode VARCHAR(100) DEFAULT '',
    training_period VARCHAR(100) DEFAULT '',
    graduation_grade VARCHAR(100) DEFAULT '',
    degree_valid_until VARCHAR(100) DEFAULT '',
    other_professional_certificates TEXT DEFAULT '',
    phone_number VARCHAR(50) DEFAULT '',
    personal_email VARCHAR(255) DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_hr_persons_gender CHECK (gender IN ('NAM', 'NU', 'KHAC', 'Nam', 'Nữ', 'Khác'))
);

-- Trigger tự động chuẩn hóa normalized_name
CREATE OR REPLACE FUNCTION trg_hr_persons_normalize()
RETURNS TRIGGER AS $$
BEGIN
    NEW.normalized_name := UPPER(unaccent(TRIM(NEW.full_name)));
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_hr_persons_before_upsert ON hr_persons;
CREATE TRIGGER trg_hr_persons_before_upsert
BEFORE INSERT OR UPDATE OF full_name ON hr_persons
FOR EACH ROW EXECUTE FUNCTION trg_hr_persons_normalize();

-- 2. BẢNG QUẢN LÝ GIẤY TỜ ĐỊNH DANH (hr_person_identity_documents)
-- KHÔNG DÙNG ON DELETE CASCADE. DÙNG RESTRICT ĐỂ BẢO VỆ DỮ LIỆU KIỂM TOÁN.
CREATE TABLE IF NOT EXISTS hr_person_identity_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES hr_persons(id) ON DELETE RESTRICT,
    doc_type VARCHAR(20) NOT NULL DEFAULT 'CCCD',
    country_code VARCHAR(3) NOT NULL DEFAULT 'VNM',
    doc_number_encrypted BYTEA NOT NULL,
    iv BYTEA NOT NULL,
    auth_tag BYTEA NOT NULL,
    encryption_key_id VARCHAR(50) NOT NULL DEFAULT 'kms-key-v1',
    doc_number_hmac VARCHAR(64) NOT NULL,
    hmac_key_version INT NOT NULL DEFAULT 1,
    masked_number VARCHAR(30) NOT NULL,
    issue_date DATE,
    issue_place VARCHAR(255) DEFAULT '',
    expiry_date DATE,
    is_primary BOOLEAN NOT NULL DEFAULT true,
    lifecycle_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    verification_status VARCHAR(30) NOT NULL DEFAULT 'LEGACY_UNVERIFIED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_identity_doc_type CHECK (doc_type IN ('CCCD', 'CMND', 'PASSPORT', 'OTHER')),
    CONSTRAINT chk_identity_lifecycle CHECK (lifecycle_status IN ('ACTIVE', 'EXPIRED', 'SUPERSEDED', 'REVOKED')),
    CONSTRAINT chk_identity_verification CHECK (verification_status IN ('LEGACY_UNVERIFIED', 'OCR_EXTRACTED', 'MANUALLY_VERIFIED', 'LEGAL_VERIFIED'))
);

-- 3. NÂNG CẤP BẢNG employees (QUAN HỆ LAO ĐỘNG HIỆN HỮU)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS person_id UUID REFERENCES hr_persons(id) ON DELETE RESTRICT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_start_date DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS effective_end_date DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS transfer_date DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS transfer_reason TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS transfer_target_company VARCHAR(50);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS transfer_source_company VARCHAR(50);

-- Cập nhật check constraint trạng thái nhân sự
ALTER TABLE employees DROP CONSTRAINT IF EXISTS chk_employees_status;
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_status_check;
ALTER TABLE employees ADD CONSTRAINT chk_employees_status CHECK (
    status IN ('PRE_ONBOARDING', 'ACTIVE', 'INACTIVE', 'TRANSFERRED', 'RESIGNED', 'TERMINATED')
);

-- 4. NÂNG CẤP BẢNG hr_employee_profiles
ALTER TABLE hr_employee_profiles ADD COLUMN IF NOT EXISTS employment_id UUID REFERENCES employees(id) ON DELETE RESTRICT;
ALTER TABLE hr_employee_profiles DROP CONSTRAINT IF EXISTS uq_hr_profiles_employment;
ALTER TABLE hr_employee_profiles ADD CONSTRAINT uq_hr_profiles_employment UNIQUE (employment_id);
ALTER TABLE hr_employee_profiles DROP CONSTRAINT IF EXISTS uq_hr_employee_citizen_id;

-- Cập nhật ràng buộc và Unique Index cho hr_sync_tasks (Transactional Outbox)
ALTER TABLE hr_sync_tasks DROP CONSTRAINT IF EXISTS hr_sync_tasks_status_check;
ALTER TABLE hr_sync_tasks ADD CONSTRAINT hr_sync_tasks_status_check CHECK (
    status IN ('pending', 'processing', 'pending_nocodb', 'processing_nocodb', 'nocodb_failed', 'nocodb_synced', 'pending_sheets', 'processing_sheets', 'sheets_failed', 'completed', 'success', 'failed', 'cancelled')
);
DROP INDEX IF EXISTS idx_hr_sync_tasks_idempotency;
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_sync_tasks_idempotency ON hr_sync_tasks(idempotency_key);

-- 5. BẢNG GHI NHẬN LỊCH SỬ BIẾN ĐỘNG QUAN HỆ LAO ĐỘNG (hr_employment_history)
CREATE TABLE IF NOT EXISTS hr_employment_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employment_id UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    person_id UUID NOT NULL REFERENCES hr_persons(id) ON DELETE RESTRICT,
    event_type VARCHAR(50) NOT NULL,
    from_company_id VARCHAR(50),
    to_company_id VARCHAR(50),
    from_department VARCHAR(255),
    to_department VARCHAR(255),
    from_position VARCHAR(255),
    to_position VARCHAR(255),
    from_status VARCHAR(50),
    to_status VARCHAR(50),
    event_date DATE NOT NULL DEFAULT CURRENT_DATE,
    decision_no VARCHAR(100),
    notes TEXT,
    actor_username VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_history_event_type CHECK (
        event_type IN ('ONBOARDING', 'TRANSFER_OUT', 'TRANSFER_IN', 'PROMOTION', 'DEPARTMENT_CHANGE', 'STATUS_CHANGE', 'RESIGNATION', 'TERMINATION', 'REHIRE')
    )
);

-- 6. BẢNG TÀI LIỆU VÀ CHỨNG TỪ NHÂN SỰ ĐÍNH KÈM (hr_employment_documents)
CREATE TABLE IF NOT EXISTS hr_employment_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employment_id UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    person_id UUID NOT NULL REFERENCES hr_persons(id) ON DELETE RESTRICT,
    document_type VARCHAR(50) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_storage_path TEXT NOT NULL,
    file_size BIGINT,
    mime_type VARCHAR(100),
    file_sha256 VARCHAR(64),
    ocr_extracted_data JSONB DEFAULT '{}'::jsonb,
    uploaded_by VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_employment_doc_type CHECK (
        document_type IN ('LABOR_CONTRACT', 'ID_CARD', 'DEGREE', 'HEALTH_CERT', 'DECISION', 'OTHER')
    )
);

-- 7. BẢNG LỊCH SỬ ĐÃI NGỘ & LƯƠNG (hr_employment_compensation)
CREATE TABLE IF NOT EXISTS hr_employment_compensation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employment_id UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    effective_from DATE NOT NULL,
    effective_to DATE,
    base_salary NUMERIC(15,2) NOT NULL DEFAULT 0,
    total_income NUMERIC(15,2) NOT NULL DEFAULT 0,
    social_insurance_salary NUMERIC(15,2) DEFAULT 0,
    productivity_pay NUMERIC(15,2) DEFAULT 0,
    responsibility_allowance NUMERIC(15,2) DEFAULT 0,
    other_allowances NUMERIC(15,2) DEFAULT 0,
    decision_no VARCHAR(100),
    decision_date DATE,
    is_current BOOLEAN NOT NULL DEFAULT true,
    notes TEXT,
    created_by VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. SEQUENCES CẤP MÃ NHÂN VIÊN CHUẨN THEO PHÁP NHÂN
CREATE SEQUENCE IF NOT EXISTS seq_employee_code_stl START WITH 15 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS seq_employee_code_vtx START WITH 100 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS seq_employee_code_swc START WITH 33 INCREMENT BY 1 NO CYCLE;

-- ĐỘNG HÓA HIỆU CHUẨN SEQUENCE (Tự động nâng sequence nếu đã có mã lớn hơn trong hệ thống)
DO $$
DECLARE
  v_max_stl INT;
  v_max_vtx INT;
  v_max_swc INT;
BEGIN
  SELECT COALESCE(MAX(NULLIF(regexp_replace(employee_code, '^[A-Za-z]+', ''), '')::integer), 0)
  INTO v_max_stl
  FROM (
    SELECT employee_code FROM employees WHERE employee_code ~ '^STL[0-9]+$'
    UNION ALL
    SELECT employee_code FROM hr_employee_staging WHERE employee_code ~ '^STL[0-9]+$'
  ) s;

  SELECT COALESCE(MAX(NULLIF(regexp_replace(employee_code, '^[A-Za-z]+', ''), '')::integer), 0)
  INTO v_max_vtx
  FROM (
    SELECT employee_code FROM employees WHERE employee_code ~ '^VTX[0-9]+$'
    UNION ALL
    SELECT employee_code FROM hr_employee_staging WHERE employee_code ~ '^VTX[0-9]+$'
  ) s;

  SELECT COALESCE(MAX(NULLIF(regexp_replace(employee_code, '^[A-Za-z]+', ''), '')::integer), 0)
  INTO v_max_swc
  FROM (
    SELECT employee_code FROM employees WHERE employee_code ~ '^SWC[0-9]+$'
    UNION ALL
    SELECT employee_code FROM hr_employee_staging WHERE employee_code ~ '^SWC[0-9]+$'
  ) s;

  PERFORM setval('seq_employee_code_stl', GREATEST(v_max_stl, (SELECT last_value FROM seq_employee_code_stl), 14), true);
  PERFORM setval('seq_employee_code_vtx', GREATEST(v_max_vtx, (SELECT last_value FROM seq_employee_code_vtx), 99), true);
  PERFORM setval('seq_employee_code_swc', GREATEST(v_max_swc, (SELECT last_value FROM seq_employee_code_swc), 32), true);
END $$;

-- 9. VIEW TƯƠNG THÍCH hr_employments
CREATE OR REPLACE VIEW hr_employments AS
SELECT 
    e.id AS employment_id,
    e.person_id,
    p.full_name AS person_full_name,
    p.normalized_name,
    e.employee_code,
    e.company_id,
    e.department,
    e.position,
    e.email AS corporate_email,
    p.personal_email,
    p.phone_number,
    e.status AS employment_status,
    e.employment_start_date,
    e.transfer_date,
    e.transfer_reason,
    e.transfer_target_company,
    e.transfer_source_company,
    e.citizen_id AS legacy_citizen_id,
    e.created_at,
    e.updated_at
FROM employees e
LEFT JOIN hr_persons p ON e.person_id = p.id;

COMMIT;
