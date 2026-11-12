-- ==============================================================================
-- MIGRATION: 20261030_02_remove_hard_delete_tables.sql
-- PURPOSE: Complete removal of Hard Delete workflow tables in Production (hrbot)
-- TASK: HR-REMOVE-HARD-DELETE-01
-- ==============================================================================

-- 1. Drop foreign keys referencing core tables first to avoid any cascading risks
ALTER TABLE IF EXISTS employee_hard_delete_requests 
  DROP CONSTRAINT IF EXISTS employee_hard_delete_requests_employee_id_fkey;

ALTER TABLE IF EXISTS employee_hard_delete_requests 
  DROP CONSTRAINT IF EXISTS employee_hard_delete_requests_company_id_fkey;

ALTER TABLE IF EXISTS employee_hard_delete_requests 
  DROP CONSTRAINT IF EXISTS employee_hard_delete_requests_requester_id_fkey;

ALTER TABLE IF EXISTS employee_hard_delete_requests 
  DROP CONSTRAINT IF EXISTS employee_hard_delete_requests_retention_policy_id_fkey;

ALTER TABLE IF EXISTS employee_retention_policies 
  DROP CONSTRAINT IF EXISTS employee_retention_policies_company_id_fkey;

-- 2. Drop child tables first in reverse dependency order
DROP TABLE IF EXISTS employee_hard_delete_audit;
DROP TABLE IF EXISTS employee_hard_delete_outbox;
DROP TABLE IF EXISTS employee_hard_delete_tombstones;
DROP TABLE IF EXISTS employee_hard_delete_executions;
DROP TABLE IF EXISTS employee_hard_delete_manifests;
DROP TABLE IF EXISTS employee_hard_delete_approvals;

-- 3. Drop parent request and retention policy tables
DROP TABLE IF EXISTS employee_hard_delete_requests;
DROP TABLE IF EXISTS employee_retention_policies;

-- 4. Verification assertion: Ensure no core tables were touched
DO $$
DECLARE
  v_emp_count INT;
BEGIN
  SELECT count(*) INTO v_emp_count FROM employees;
  IF v_emp_count != 5 THEN
    RAISE EXCEPTION 'CRITICAL INTEGRITY FAILURE: Core employees count changed from 5 to %!', v_emp_count;
  END IF;
  RAISE NOTICE 'Migration 20261030_02: Successfully removed 8 hard delete tables. Core employees count verified intact: %', v_emp_count;
END $$;
