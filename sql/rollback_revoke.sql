CREATE OR REPLACE FUNCTION revoke_document(p_document_id text, p_user text) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_document_id));
  UPDATE documents SET status = 'revoked', expiry_date = CURRENT_DATE - 1
   WHERE document_id = p_document_id AND status IN ('active','scheduled');
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO audit_log(actor, action, detail)
  VALUES (p_user, 'revoke', jsonb_build_object('document_id', p_document_id, 'rows', n));
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION rollback_version(p_document_id text, p_user text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE cur uuid; prev uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_document_id));
  SELECT doc_version_id INTO cur FROM documents
   WHERE document_id = p_document_id AND status = 'active';
  SELECT doc_version_id INTO prev FROM documents
   WHERE document_id = p_document_id AND status = 'superseded'
   ORDER BY version DESC LIMIT 1;
  IF prev IS NULL THEN RAISE EXCEPTION 'Khong co phien ban superseded de quay lai'; END IF;
  IF cur IS NOT NULL THEN
    UPDATE documents SET status = 'revoked' WHERE doc_version_id = cur;
  END IF;
  UPDATE documents SET status = 'active', expiry_date = NULL WHERE doc_version_id = prev;
  INSERT INTO audit_log(actor, action, doc_version_id) VALUES (p_user, 'rollback', prev);
  RETURN 'active';
END $$;
