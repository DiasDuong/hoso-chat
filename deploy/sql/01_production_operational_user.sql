-- ============================================================================
-- SOTRANS HUB — PRODUCTION DATABASE LEAST PRIVILEGE SCRIPT 01 (RECONCILED)
-- TARGET: OPERATIONAL APPLICATION RUNTIME ROLE (hr_app_user)
-- EXECUTION: DBA / Lead DevOps
-- DATABASE: hrbot (PostgreSQL 16)
-- DESCRIPTION: Sets up dedicated non-superuser operational application role
--              with explicit table DML and sequence privileges.
--              STRICTLY EXCLUDES DDL, SUPERUSER, CREATEDB, CREATEROLE.
-- ============================================================================

-- 1. Database Safety Check
DO $$
BEGIN
  IF current_database() NOT IN ('hrbot', 'sotrans_production_rehearsal') THEN
    RAISE EXCEPTION 'FATAL: Script must be executed on database "hrbot" or "sotrans_production_rehearsal", current database is "%"', current_database();
  END IF;
END $$;

-- 2. Create or Standardize Role hr_app_user
-- Strictly enforce 8 core security attributes:
-- LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT, NOREPLICATION, NOBYPASSRLS
-- NOTE: Created without hardcoded password to prevent secret leakage in Git/logs.
-- DBA must set the password interactively via \password hr_app_user after running this script.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hr_app_user') THEN
    CREATE ROLE hr_app_user WITH 
      LOGIN 
      NOSUPERUSER 
      NOCREATEDB 
      NOCREATEROLE 
      NOINHERIT 
      NOREPLICATION 
      NOBYPASSRLS;
    RAISE NOTICE 'Role "hr_app_user" created successfully with 8 security attributes (PASSWORD NULL).';
  ELSE
    ALTER ROLE hr_app_user WITH 
      LOGIN 
      NOSUPERUSER 
      NOCREATEDB 
      NOCREATEROLE 
      NOINHERIT 
      NOREPLICATION 
      NOBYPASSRLS;
    RAISE NOTICE 'Role "hr_app_user" already exists, standardized to Least Privilege.';
  END IF;
END $$;

-- 3. Configure Connection Boundaries & Safety Timeouts
ALTER ROLE hr_app_user SET statement_timeout = '15000'; -- Max 15s for operational transactions
ALTER ROLE hr_app_user SET idle_in_transaction_session_timeout = '30000'; -- Max 30s idle in transaction
ALTER ROLE hr_app_user SET TIME ZONE 'Asia/Ho_Chi_Minh';

-- 4. Grant Database & Schema Usage (NO CREATE PRIVILEGE ON SCHEMA)
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO hr_app_user', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO hr_app_user;

-- Explicitly revoke CREATE on public schema to PREVENT runtime DDL (CREATE/DROP/ALTER TABLE)
-- Migrations and schema changes must be performed exclusively by DBA / migration account.
REVOKE CREATE ON SCHEMA public FROM hr_app_user;
REVOKE ALL ON SCHEMA information_schema FROM hr_app_user;
REVOKE ALL ON SCHEMA pg_catalog FROM hr_app_user;
GRANT USAGE ON SCHEMA pg_catalog TO hr_app_user; -- Minimal catalog lookup

-- 5. Revoke Any Default Broad Privileges
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM hr_app_user;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM hr_app_user;

-- 6. Grant Specific DML Privileges on Operational Application Tables

-- 6.1. Core Authentication, Users & Organizations
GRANT SELECT, INSERT, UPDATE ON public.users TO hr_app_user;
GRANT SELECT ON public.companies TO hr_app_user;
GRANT SELECT ON public.role_permissions TO hr_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.oauth_state_nonces TO hr_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_oauth_tokens TO hr_app_user;

-- 6.2. HR Employee Master, Profiles & Intake Staging
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employees TO hr_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_employee_profiles TO hr_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_employee_staging TO hr_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_intake_batches TO hr_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_sync_tasks TO hr_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_sync_outbox TO hr_app_user;

-- 6.3. Document Management, Knowledge Base & Chunks (RAG)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO hr_app_user;
GRANT SELECT, INSERT, DELETE ON public.chunks TO hr_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_relationships TO hr_app_user;
GRANT SELECT, INSERT, UPDATE ON public.document_retrieval_controls TO hr_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_retry_leases TO hr_app_user;

-- 6.4. Conversations, Messages & Chat History
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_conversations TO hr_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_messages TO hr_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_attachments TO hr_app_user;
GRANT SELECT, INSERT, UPDATE ON public.chat_log TO hr_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_conversation_files TO hr_app_user;
GRANT SELECT, INSERT, UPDATE ON public.unanswered_log TO hr_app_user;
GRANT SELECT ON public.golden_questions TO hr_app_user;

-- 6.5. Enterprise Custom Agents & File Studio
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_agents TO hr_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_agent_versions TO hr_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_output_files TO hr_app_user;
GRANT SELECT, INSERT, DELETE ON public.agent_shares TO hr_app_user;
GRANT SELECT, INSERT, UPDATE ON public.agent_notifications TO hr_app_user;

-- 6.6. OneDrive Integration & Background Workers
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_onedrive_sources TO hr_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.onedrive_source_snapshots TO hr_app_user;
GRANT SELECT, INSERT, UPDATE ON public.onedrive_sync_jobs TO hr_app_user;
GRANT SELECT, INSERT, UPDATE ON public.onedrive_sync_worker_states TO hr_app_user;
GRANT SELECT, INSERT, DELETE ON public.agent_onedrive_source_associations TO hr_app_user;

-- 6.7. System Audit Logs
GRANT SELECT, INSERT ON public.auth_audit_logs TO hr_app_user;
GRANT SELECT, INSERT ON public.audit_log TO hr_app_user;
GRANT SELECT, INSERT ON public.document_audit_logs TO hr_app_user;
GRANT SELECT, INSERT ON public.agent_audit_logs TO hr_app_user;
GRANT SELECT, INSERT ON public.admin_actions TO hr_app_user;

-- 7. Grant Sequence Usage (Required for auto-incrementing surrogate keys)
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO hr_app_user;

-- 8. Post-Execution Verification Queries
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
WHERE rolname = 'hr_app_user';

-- Check that hr_app_user does NOT have CREATE permission on public schema
SELECT 
  has_schema_privilege('hr_app_user', 'public', 'CREATE') AS has_schema_create_privilege; -- Must return FALSE

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
--     \password hr_app_user
--   (Type password when prompted; input is masked and omitted from history)
--
-- METHOD 2 (Non-interactive via environment variable and ignorespace):
--   HISTCONTROL=ignorespace psql -U postgres -d hrbot -c "ALTER ROLE hr_app_user WITH PASSWORD '$PG_PASSWORD';"
-- ============================================================================
