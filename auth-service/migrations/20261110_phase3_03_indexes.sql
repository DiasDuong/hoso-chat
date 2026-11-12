-- ==============================================================================
-- SOTRANS HUB — PHASE 3.1: MIGRATION 03: INDEXES
-- ==============================================================================

CREATE INDEX IF NOT EXISTS idx_identity_doc_hmac ON hr_person_identity_documents(doc_number_hmac);
CREATE INDEX IF NOT EXISTS idx_identity_doc_person ON hr_person_identity_documents(person_id);
CREATE INDEX IF NOT EXISTS idx_identity_doc_lookup ON hr_person_identity_documents(doc_number_hmac, hmac_key_version);
CREATE INDEX IF NOT EXISTS idx_employees_person_id ON employees(person_id);
CREATE INDEX IF NOT EXISTS idx_hr_persons_normalized_name ON hr_persons(normalized_name);
CREATE INDEX IF NOT EXISTS idx_hr_employment_history_emp ON hr_employment_history(employment_id);
CREATE INDEX IF NOT EXISTS idx_hr_employment_history_person ON hr_employment_history(person_id);
CREATE INDEX IF NOT EXISTS idx_hr_employment_docs_emp ON hr_employment_documents(employment_id);
CREATE INDEX IF NOT EXISTS idx_hr_employment_comp_emp ON hr_employment_compensation(employment_id);
