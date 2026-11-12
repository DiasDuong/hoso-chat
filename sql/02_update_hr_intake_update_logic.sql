-- ==============================================================================
-- MIGRATION: HR INTAKE PROFILE UPDATE & GRANULAR RBAC SYSTEM
-- ==============================================================================

-- 1. Add update tracking columns to hr_employee_staging
ALTER TABLE public.hr_employee_staging
    ADD COLUMN IF NOT EXISTS intake_mode VARCHAR(30) NOT NULL DEFAULT 'new_profile',
    ADD COLUMN IF NOT EXISTS target_profile_id INTEGER REFERENCES public.hr_employee_profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS target_employee_code VARCHAR(50),
    ADD COLUMN IF NOT EXISTS proposed_changes JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- Add check constraint for intake_mode if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'hr_employee_staging_intake_mode_check'
    ) THEN
        ALTER TABLE public.hr_employee_staging
            ADD CONSTRAINT hr_employee_staging_intake_mode_check 
            CHECK (intake_mode IN (
                'new_profile',
                'update_profile',
                'suspected_duplicate',
                'multiple_matches',
                'company_mismatch',
                'insufficient_data',
                'conflict_data'
            ));
    END IF;
END $$;

-- 2. Add version column to hr_employee_profiles for optimistic concurrency control
ALTER TABLE public.hr_employee_profiles
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- 3. Register Granular Permissions in role_permissions
-- Permissions:
-- hr.profile.add_document
-- hr.profile.edit_contact
-- hr.profile.edit_department
-- hr.profile.edit_salary
-- hr.profile.edit_identity
-- hr.profile.edit_code
-- hr.profile.transfer_company
-- hr.profile.deactivate

INSERT INTO public.role_permissions (role, permission)
VALUES
    -- SUPER_ADMIN: All permissions
    ('SUPER_ADMIN', 'hr.profile.add_document'),
    ('SUPER_ADMIN', 'hr.profile.edit_contact'),
    ('SUPER_ADMIN', 'hr.profile.edit_department'),
    ('SUPER_ADMIN', 'hr.profile.edit_salary'),
    ('SUPER_ADMIN', 'hr.profile.edit_identity'),
    ('SUPER_ADMIN', 'hr.profile.edit_code'),
    ('SUPER_ADMIN', 'hr.profile.transfer_company'),
    ('SUPER_ADMIN', 'hr.profile.deactivate'),

    -- COMPANY_ADMIN: Operational permissions within company, NOT transfer_company or edit_code
    ('COMPANY_ADMIN', 'hr.profile.add_document'),
    ('COMPANY_ADMIN', 'hr.profile.edit_contact'),
    ('COMPANY_ADMIN', 'hr.profile.edit_department'),
    ('COMPANY_ADMIN', 'hr.profile.edit_salary'),
    ('COMPANY_ADMIN', 'hr.profile.edit_identity'),
    ('COMPANY_ADMIN', 'hr.profile.deactivate'),

    -- HR: Non-sensitive operations only (Separation of duties: no salary, no identity edit, no code edit)
    ('HR', 'hr.profile.add_document'),
    ('HR', 'hr.profile.edit_contact'),
    ('HR', 'hr.profile.edit_department')

ON CONFLICT (role, permission) DO NOTHING;
