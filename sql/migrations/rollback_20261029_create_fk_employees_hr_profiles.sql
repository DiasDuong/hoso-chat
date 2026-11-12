-- Rollback Migration: Drop Foreign Key & Unique Constraint between employees and hr_employee_profiles
-- File: sql/migrations/rollback_20261029_create_fk_employees_hr_profiles.sql
-- Reference: SOTRANS Hub Remediation - Đợt 2 (DEF-004 / AUD-012 / BUG-005)

DO $$
BEGIN
    -- 1. Gỡ bỏ Foreign Key Constraint trên hr_employee_profiles
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'fk_hr_employee_profiles_employee_code' 
          AND conrelid = 'public.hr_employee_profiles'::regclass
    ) THEN
        ALTER TABLE public.hr_employee_profiles 
        DROP CONSTRAINT fk_hr_employee_profiles_employee_code;
        RAISE NOTICE 'Dropped FOREIGN KEY CONSTRAINT fk_hr_employee_profiles_employee_code.';
    END IF;

    -- 2. Gỡ bỏ Unique Constraint trên employees
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'uq_employees_employee_code' 
          AND conrelid = 'public.employees'::regclass
    ) THEN
        ALTER TABLE public.employees 
        DROP CONSTRAINT uq_employees_employee_code;
        RAISE NOTICE 'Dropped UNIQUE CONSTRAINT uq_employees_employee_code.';
    END IF;
END $$;
