-- ============================================================================
-- SOTRANS HUB — PRODUCTION DATABASE LEAST PRIVILEGE SCRIPT 02 (RECONCILED)
-- TARGET: BI READ-ONLY REPORTING ROLE (bi_readonly)
-- EXECUTION: DBA / Lead DevOps
-- DATABASE: hrbot (PostgreSQL 16)
-- DESCRIPTION: Sets up strictly read-only, column-level granted role matching
--              EXACTLY the 38 columns used by Analytics Engine (Phase 1.4)
-- ============================================================================

-- 1. Database Safety Check
DO $$
BEGIN
  IF current_database() NOT IN ('hrbot', 'sotrans_production_rehearsal') THEN
    RAISE EXCEPTION 'FATAL: Script must be executed on database "hrbot" or "sotrans_production_rehearsal", current database is "%"', current_database();
  END IF;
END $$;

-- 2. Create or Standardize Role bi_readonly
-- Strictly enforce 8 core security attributes:
-- LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT, NOREPLICATION, NOBYPASSRLS
-- NOTE: Created without hardcoded password to prevent secret leakage in Git/logs.
-- DBA must set the password interactively via \password bi_readonly after running this script.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bi_readonly') THEN
    CREATE ROLE bi_readonly WITH 
      LOGIN 
      NOSUPERUSER 
      NOCREATEDB 
      NOCREATEROLE 
      NOINHERIT 
      NOREPLICATION 
      NOBYPASSRLS;
    RAISE NOTICE 'Role "bi_readonly" created successfully with 8 security attributes (PASSWORD NULL).';
  ELSE
    ALTER ROLE bi_readonly WITH 
      LOGIN 
      NOSUPERUSER 
      NOCREATEDB 
      NOCREATEROLE 
      NOINHERIT 
      NOREPLICATION 
      NOBYPASSRLS;
    RAISE NOTICE 'Role "bi_readonly" already exists, standardized to Least Privilege.';
  END IF;
END $$;

-- 3. Configure Connection Boundaries & Strict Read-Only Safeguards
ALTER ROLE bi_readonly SET statement_timeout = '3000'; -- Max 3 seconds statement timeout
ALTER ROLE bi_readonly SET default_transaction_read_only = 'on'; -- Enforce read-only transaction mode
ALTER ROLE bi_readonly SET idle_in_transaction_session_timeout = '5000'; -- Max 5s idle in transaction
ALTER ROLE bi_readonly SET TIME ZONE 'Asia/Ho_Chi_Minh';

-- 4. Grant Database & Schema Connect Access
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO bi_readonly', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO bi_readonly;

-- 5. Revoke ALL Existing/Public Privileges on Schema public
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM bi_readonly;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM bi_readonly;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM bi_readonly;
REVOKE ALL ON SCHEMA information_schema FROM bi_readonly;
REVOKE ALL ON SCHEMA pg_catalog FROM bi_readonly;
GRANT USAGE ON SCHEMA pg_catalog TO bi_readonly; -- Minimal catalog lookup for connection handshake

-- 6. Lock Out Excluded Tables (Companies & Document Relationships are not queried by Analytics Engine)
REVOKE ALL ON public.companies FROM bi_readonly;
REVOKE ALL ON public.document_relationships FROM bi_readonly;

-- 7. Grant Column-Level SELECT Privileges (EXACT 38 COLUMNS VERIFIED IN ANALYTICS ENGINE)

-- 7.1. Bảng public.documents (KPI 1, 2, 3, 4, 14: Đúng 9 cột)
GRANT SELECT (
  doc_version_id, 
  status, 
  effective_date, 
  expiry_date, 
  deleted_at, 
  branch_scope, 
  doc_type, 
  category, 
  parse_quality
) ON public.documents TO bi_readonly;

-- 7.2. Bảng public.hr_intake_batches (KPI 5, 6, 7, 8: Đúng 6 cột)
GRANT SELECT (
  id, 
  company_id, 
  status, 
  total_files, 
  uploaded_by, 
  created_at
) ON public.hr_intake_batches TO bi_readonly;

-- 7.3. Bảng public.hr_employee_staging (KPI 8, 11, 13, 15: Đúng 10 cột)
-- CRITICAL PII EXCLUSIONS: cccd, citizen_id, phone_number, email, base_salary, full_name, extracted_data
GRANT SELECT (
  id, 
  batch_id, 
  company_id, 
  staging_status, 
  suspected_duplicate, 
  missing_fields, 
  uncertain_fields, 
  created_at, 
  approved_at, 
  reviewed_at
) ON public.hr_employee_staging TO bi_readonly;

-- 7.4. Bảng public.users (KPI 16: Đúng 4 cột)
-- CRITICAL PII EXCLUSIONS: password_hash, employee_id
GRANT SELECT (
  user_id, 
  role, 
  company_id, 
  status
) ON public.users TO bi_readonly;

-- 7.5. Bảng public.auth_audit_logs (KPI 16: Đúng 4 cột)
-- CRITICAL PII EXCLUSIONS: metadata, ip_address, target_user_id
GRANT SELECT (
  id, 
  actor_user_id, 
  action, 
  created_at
) ON public.auth_audit_logs TO bi_readonly;

-- 7.6. Bảng public.chat_log (KPI 17: Đúng 5 cột)
-- CRITICAL PII EXCLUSIONS: question, reply, rewritten, user_id, username, content, metadata
GRANT SELECT (
  id, 
  company_id, 
  answerable, 
  best_sim, 
  at
) ON public.chat_log TO bi_readonly;

-- 8. Post-Execution Verification Queries (Run to confirm EXACT 38 columns granted)
SELECT 
  rolname, 
  rolsuper, 
  rolinherit, 
  rolcreaterole, 
  rolcreatedb, 
  rolcanlogin,
  rolreplication,
  rolbypassrls
FROM pg_roles 
WHERE rolname = 'bi_readonly';

SELECT 
  table_name, 
  column_name, 
  privilege_type 
FROM information_schema.column_privileges 
WHERE grantee = 'bi_readonly' 
ORDER BY table_name, column_name;

-- Total column count check (MUST RETURN EXACTLY 38)
SELECT COUNT(*) AS total_granted_columns 
FROM information_schema.column_privileges 
WHERE grantee = 'bi_readonly';

-- ============================================================================
-- 9. DBA SECURE PASSWORD PROVISIONING (EXECUTE AFTER THIS SCRIPT)
-- ============================================================================
-- DO NOT edit this script to insert plaintext passwords!
-- DO NOT commit passwords into Git or version control!
--
-- Set password securely using ONE of the following safe methods:
--
-- METHOD 1 (Interactive psql - RECOMMENDED, ZERO LOGGING):
--   In psql terminal, run:
--     \password bi_readonly
--   (Type password when prompted; input is masked and omitted from history)
--
-- METHOD 2 (Non-interactive via environment variable and ignorespace):
--   HISTCONTROL=ignorespace psql -U postgres -d hrbot -c "ALTER ROLE bi_readonly WITH PASSWORD '$PG_RO_PASSWORD';"
-- ============================================================================
