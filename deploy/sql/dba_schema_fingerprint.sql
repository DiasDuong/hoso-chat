-- ==============================================================================
-- SOTRANS HUB — DBA PRODUCTION SCHEMA FINGERPRINT EXTRACTION SCRIPT
-- ==============================================================================
-- PURPOSE: Generates a deterministic schema fingerprint of database 'hrbot'
--          strictly from system catalogs (ZERO business data, ZERO employee PII).
-- USAGE:   psql -U postgres -d hrbot -f dba_schema_fingerprint.sql > schema_fingerprint.txt
-- ==============================================================================

\echo '=== 1. PUBLIC BASE TABLES ==='
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' AND table_type = 'BASE TABLE' 
ORDER BY table_name;

\echo '=== 2. COLUMN DEFINITIONS & DATA TYPES ==='
SELECT 
  table_name, 
  column_name, 
  data_type, 
  is_nullable, 
  character_maximum_length 
FROM information_schema.columns 
WHERE table_schema = 'public' 
ORDER BY table_name, ordinal_position;

\echo '=== 3. PRIMARY & FOREIGN KEY CONSTRAINTS ==='
SELECT 
  tc.table_name, 
  tc.constraint_name, 
  tc.constraint_type, 
  kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu 
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
WHERE tc.table_schema = 'public'
ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position;

\echo '=== 4. PUBLIC SEQUENCES ==='
SELECT 
  sequence_name, 
  data_type, 
  start_value, 
  minimum_value, 
  maximum_value 
FROM information_schema.sequences 
WHERE sequence_schema = 'public' 
ORDER BY sequence_name;

\echo '=== 5. INDEXES ==='
SELECT 
  tablename, 
  indexname 
FROM pg_indexes 
WHERE schemaname = 'public' 
ORDER BY tablename, indexname;

\echo '=== 6. ROLE ATTRIBUTES & OWNERSHIP CHECK ==='
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
WHERE rolname IN ('postgres', 'hr_app_user', 'bi_readonly', 'hrbot');
