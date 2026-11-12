-- ROLLBACK SCRIPT FOR PHASE 3 PERSON-EMPLOYMENT RE-ARCHITECTURE
-- Timestamp: 2026-11-10

DROP VIEW IF EXISTS hr_employments;
DROP SEQUENCE IF EXISTS seq_employee_code_stl;
DROP SEQUENCE IF EXISTS seq_employee_code_vtx;
DROP SEQUENCE IF EXISTS seq_employee_code_swc;

DROP TABLE IF EXISTS hr_employment_compensation CASCADE;
DROP TABLE IF EXISTS hr_employment_documents CASCADE;
DROP TABLE IF EXISTS hr_employment_history CASCADE;

ALTER TABLE hr_employee_profiles DROP COLUMN IF EXISTS employment_id CASCADE;
ALTER TABLE employees DROP COLUMN IF EXISTS effective_end_date CASCADE;
ALTER TABLE employees DROP COLUMN IF EXISTS transfer_date CASCADE;
ALTER TABLE employees DROP COLUMN IF EXISTS transfer_reason CASCADE;
ALTER TABLE employees DROP COLUMN IF EXISTS transfer_target_company CASCADE;
ALTER TABLE employees DROP COLUMN IF EXISTS transfer_source_company CASCADE;
ALTER TABLE employees DROP COLUMN IF EXISTS person_id CASCADE;

DROP TABLE IF EXISTS hr_person_identity_documents CASCADE;
DROP TABLE IF EXISTS hr_persons CASCADE;
