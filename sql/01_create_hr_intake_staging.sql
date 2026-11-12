-- ==============================================================================
-- MIGRATION: HR EMPLOYEE INTAKE STAGING & AUDIT SYSTEM
-- ==============================================================================

-- 1. Create Staging Table for Conversational HR Onboarding
CREATE TABLE IF NOT EXISTS public.hr_employee_staging (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL,
    conversation_id UUID REFERENCES public.ai_conversations(id) ON DELETE SET NULL,
    file_name VARCHAR(255) NOT NULL,
    file_storage_path TEXT,
    file_size BIGINT,
    mime_type VARCHAR(100),
    
    -- Extracted Core Identity
    full_name VARCHAR(255) NOT NULL,
    citizen_id VARCHAR(50),
    employee_code VARCHAR(50),
    date_of_birth VARCHAR(50),
    gender VARCHAR(20),
    
    -- Professional & Department Info
    job_title VARCHAR(255),
    department VARCHAR(255),
    email VARCHAR(255),
    phone_number VARCHAR(50),
    recruitment_decision_no VARCHAR(100),
    employment_start_date VARCHAR(50),
    base_salary VARCHAR(100),
    
    -- Company Identification Status
    company_id VARCHAR(20) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    company_status VARCHAR(20) NOT NULL DEFAULT 'unknown' 
        CHECK (company_status IN ('confirmed', 'suggested', 'unknown', 'conflict')),
    company_evidence TEXT,
    
    -- Staging Lifecycle & Approval Status
    staging_status VARCHAR(30) NOT NULL DEFAULT 'pending_review'
        CHECK (staging_status IN ('pending_review', 'pending_approval', 'approved', 'rejected')),
    
    -- Validation, Duplication & Clarification Flags
    missing_fields TEXT[] DEFAULT ARRAY[]::TEXT[],
    uncertain_fields TEXT[] DEFAULT ARRAY[]::TEXT[],
    suspected_duplicate BOOLEAN DEFAULT FALSE,
    duplicate_reason TEXT,
    
    -- Complete Extracted JSON (53 fields)
    extracted_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    
    -- Audit & Traceability
    uploaded_by VARCHAR(100) NOT NULL,
    uploaded_by_user_id UUID,
    reviewer_username VARCHAR(100),
    reviewed_at TIMESTAMPTZ,
    approver_username VARCHAR(100),
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_staging_batch ON public.hr_employee_staging(batch_id);
CREATE INDEX IF NOT EXISTS idx_hr_staging_status ON public.hr_employee_staging(staging_status);
CREATE INDEX IF NOT EXISTS idx_hr_staging_company ON public.hr_employee_staging(company_id);
CREATE INDEX IF NOT EXISTS idx_hr_staging_citizen_id ON public.hr_employee_staging(citizen_id);
CREATE INDEX IF NOT EXISTS idx_hr_staging_user ON public.hr_employee_staging(uploaded_by);

-- 2. Create Background Sync Queue for Idempotent NocoDB / Google Sheets Sync
CREATE TABLE IF NOT EXISTS public.hr_sync_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staging_id UUID NOT NULL REFERENCES public.hr_employee_staging(id) ON DELETE CASCADE,
    target_system VARCHAR(50) NOT NULL CHECK (target_system IN ('nocodb', 'google_sheets')),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'success', 'failed')),
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 3,
    last_error TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_sync_status ON public.hr_sync_tasks(status);

-- 3. Register Granular Permissions in role_permissions
INSERT INTO public.role_permissions (role, permission, description)
VALUES 
    -- SUPER_ADMIN: Toàn quyền trên mọi công ty
    ('SUPER_ADMIN', 'hr.intake.upload', 'Tải lên hồ sơ nhân sự qua chatbot toàn hệ thống'),
    ('SUPER_ADMIN', 'hr.intake.confirm_company', 'Xác nhận công ty cho hồ sơ nhân sự toàn hệ thống'),
    ('SUPER_ADMIN', 'hr.intake.approve', 'Phê duyệt chính thức hồ sơ nhân sự toàn hệ thống'),
    ('SUPER_ADMIN', 'hr.intake.submit', 'Gửi hồ sơ nhân sự trình duyệt toàn hệ thống'),
    
    -- COMPANY_ADMIN: Quản lý trong phạm vi công ty
    ('COMPANY_ADMIN', 'hr.intake.upload', 'Tải lên hồ sơ nhân sự công ty qua chatbot'),
    ('COMPANY_ADMIN', 'hr.intake.confirm_company', 'Xác nhận công ty cho hồ sơ nhân sự công ty'),
    ('COMPANY_ADMIN', 'hr.intake.approve', 'Phê duyệt chính thức hồ sơ nhân sự công ty'),
    ('COMPANY_ADMIN', 'hr.intake.submit', 'Gửi hồ sơ nhân sự trình duyệt'),
    
    -- HR: Được upload, xác nhận công ty, submit chờ duyệt (Separation of Duties: không tự duyệt chính thức)
    ('HR', 'hr.intake.upload', 'Tải lên hồ sơ nhân sự công ty qua chatbot'),
    ('HR', 'hr.intake.confirm_company', 'Xác nhận công ty cho hồ sơ nhân sự công ty'),
    ('HR', 'hr.intake.submit', 'Gửi hồ sơ nhân sự trình phê duyệt')
ON CONFLICT DO NOTHING;

-- 4. Fix trigger sync_hr_profile_to_employee: NEVER hardcode SWC, NEVER conflate citizen_id with employee_code
CREATE OR REPLACE FUNCTION public.sync_hr_profile_to_employee()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_code VARCHAR(50);
  v_comp VARCHAR(50);
BEGIN
  -- Lấy mã nhân viên riêng biệt, không gán nhầm CCCD làm mã nhân viên
  v_code := NULLIF(TRIM(NEW.employee_id), '');
  
  -- Lấy công ty thực tế của hồ sơ, tuyệt đối không gán cứng SWC
  v_comp := NULLIF(TRIM(NEW.company_id), '');
  
  -- Chỉ đồng bộ sang employees khi đã có mã nhân viên và công ty hợp lệ
  IF v_code IS NOT NULL AND v_comp IS NOT NULL AND NEW.full_name IS NOT NULL THEN
    INSERT INTO employees (
      id, employee_code, employee_name, company_id, department, position, email, status, created_at, updated_at
    )
    VALUES (
      gen_random_uuid(),
      v_code,
      NEW.full_name,
      v_comp,
      COALESCE(NEW.department_staffing_plan, ''),
      COALESCE(NEW.job_title, ''),
      COALESCE(NEW.email, ''),
      'ACTIVE',
      NOW(),
      NOW()
    )
    ON CONFLICT (company_id, employee_code) DO UPDATE SET
      employee_name = EXCLUDED.employee_name,
      department = COALESCE(NULLIF(EXCLUDED.department, ''), employees.department),
      position = COALESCE(NULLIF(EXCLUDED.position, ''), employees.position),
      email = COALESCE(NULLIF(EXCLUDED.email, ''), employees.email),
      updated_at = NOW();
  END IF;
  
  RETURN NEW;
END;
$function$;
