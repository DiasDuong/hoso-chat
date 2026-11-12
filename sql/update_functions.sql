-- Cập nhật đồng bộ các hàm quản trị HR với nhật ký admin_actions và audit_log

CREATE OR REPLACE FUNCTION public.activate_version(p_id uuid, p_user text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v documents%ROWTYPE;
BEGIN
  SELECT * INTO v FROM documents WHERE doc_version_id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiên bản'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v.document_id));
  IF v.status NOT IN ('testing','scheduled') THEN
    RAISE EXCEPTION 'Chỉ kích hoạt được bản testing/scheduled (hiện: %)', v.status;
  END IF;
  IF v.effective_date <= CURRENT_DATE THEN
    UPDATE documents SET status = 'superseded', expiry_date = v.effective_date - 1
     WHERE document_id = v.document_id AND status = 'active' AND doc_version_id <> p_id;
    UPDATE documents SET status = 'active', approved_by = p_user, approved_at = now()
     WHERE doc_version_id = p_id;
    INSERT INTO audit_log(actor, action, doc_version_id, detail)
    VALUES (p_user, 'activate', p_id, jsonb_build_object('document_id', v.document_id, 'version', v.version, 'title', v.title));
    INSERT INTO admin_actions(actor, action, document_id, doc_version_id, detail)
    VALUES (p_user, 'activate', v.document_id, p_id, jsonb_build_object('version', v.version, 'title', v.title, 'status', 'active'));
    RETURN 'active';
  ELSE
    UPDATE documents SET status = 'scheduled', approved_by = p_user, approved_at = now()
     WHERE doc_version_id = p_id;
    INSERT INTO audit_log(actor, action, doc_version_id, detail)
    VALUES (p_user, 'schedule', p_id, jsonb_build_object('document_id', v.document_id, 'version', v.version, 'title', v.title));
    INSERT INTO admin_actions(actor, action, document_id, doc_version_id, detail)
    VALUES (p_user, 'schedule', v.document_id, p_id, jsonb_build_object('version', v.version, 'title', v.title, 'status', 'scheduled'));
    RETURN 'scheduled';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.revoke_document(p_document_id text, p_user text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE r documents%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_document_id));
  SELECT * INTO r FROM documents WHERE document_id = p_document_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không có phiên bản active để hủy (%)', p_document_id;
  END IF;
  UPDATE documents SET status = 'revoked', expiry_date = CURRENT_DATE - 1
   WHERE doc_version_id = r.doc_version_id;
  INSERT INTO audit_log(actor, action, doc_version_id, detail)
  VALUES (p_user, 'revoke', r.doc_version_id, jsonb_build_object('document_id', p_document_id, 'title', r.title, 'version', r.version));
  INSERT INTO admin_actions(actor, action, document_id, doc_version_id, detail)
  VALUES (p_user, 'revoke', p_document_id, r.doc_version_id, jsonb_build_object('title', r.title, 'version', r.version));
  RETURN 'revoked';
END $$;

CREATE OR REPLACE FUNCTION public.rollback_version(p_document_id text, p_user text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE r_cur documents%ROWTYPE; r_prev documents%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_document_id));
  SELECT * INTO r_cur FROM documents
   WHERE document_id = p_document_id AND status = 'active' FOR UPDATE;
  SELECT * INTO r_prev FROM documents
   WHERE document_id = p_document_id AND status = 'superseded'
   ORDER BY version DESC LIMIT 1 FOR UPDATE;
  IF r_prev.doc_version_id IS NULL THEN
    RAISE EXCEPTION 'Không có phiên bản cũ (superseded) để quay lại';
  END IF;
  IF r_cur.doc_version_id IS NOT NULL THEN
    UPDATE documents SET status = 'revoked', expiry_date = CURRENT_DATE - 1 WHERE doc_version_id = r_cur.doc_version_id;
  END IF;
  UPDATE documents SET status = 'active', expiry_date = NULL WHERE doc_version_id = r_prev.doc_version_id;
  INSERT INTO audit_log(actor, action, doc_version_id, detail)
  VALUES (p_user, 'rollback', r_prev.doc_version_id, jsonb_build_object('document_id', p_document_id, 'restored_version', r_prev.version));
  INSERT INTO admin_actions(actor, action, document_id, doc_version_id, detail)
  VALUES (p_user, 'rollback', p_document_id, r_prev.doc_version_id, jsonb_build_object('restored_version', r_prev.version, 'revoked_version', r_cur.version));
  RETURN 'active';
END $$;
