-- Migration: Unique Constraint & Foreign Key Constraint between employees and hr_employee_profiles
-- File: sql/migrations/20261029_create_fk_employees_hr_profiles.sql
-- Reference: SOTRANS Hub Remediation - Đợt 2 (DEF-004 / AUD-012 / BUG-005)
-- Description: 
--   1. Tạo Unique Constraint uq_employees_employee_code trên bảng employees(employee_code).
--   2. Tạo Foreign Key Constraint fk_hr_employee_profiles_employee_code giữa
--      hr_employee_profiles(employee_id) và employees(employee_code)
--      với ON UPDATE CASCADE ON DELETE CASCADE và DEFERRABLE INITIALLY DEFERRED.

DO $$
BEGIN
    -- 1. Đảm bảo Unique Constraint cho employees(employee_code)
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'uq_employees_employee_code' 
          AND conrelid = 'public.employees'::regclass
    ) THEN
        ALTER TABLE public.employees 
        ADD CONSTRAINT uq_employees_employee_code UNIQUE (employee_code);
        RAISE NOTICE 'Added UNIQUE CONSTRAINT uq_employees_employee_code to employees(employee_code).';
    ELSE
        RAISE NOTICE 'UNIQUE CONSTRAINT uq_employees_employee_code already exists on employees.';
    END IF;

    -- 2. Đảm bảo Foreign Key Constraint giữa hr_employee_profiles và employees
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'fk_hr_employee_profiles_employee_code' 
          AND conrelid = 'public.hr_employee_profiles'::regclass
    ) THEN
        ALTER TABLE public.hr_employee_profiles 
        ADD CONSTRAINT fk_hr_employee_profiles_employee_code 
        FOREIGN KEY (employee_id) REFERENCES public.employees(employee_code) 
        ON UPDATE CASCADE ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED;
        RAISE NOTICE 'Added FOREIGN KEY CONSTRAINT fk_hr_employee_profiles_employee_code to hr_employee_profiles(employee_id).';
    ELSE
        RAISE NOTICE 'FOREIGN KEY CONSTRAINT fk_hr_employee_profiles_employee_code already exists on hr_employee_profiles.';
    END IF;
END $$;
