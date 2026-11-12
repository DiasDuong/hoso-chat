-- Rollback Migration: rollback_20261106_hr_document_owner_delete.sql

-- 1. Phục hồi delete_version ban đầu
CREATE OR REPLACE FUNCTION public.delete_version(p_id uuid, p_actor text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  r documents%ROWTYPE;
  n int;
BEGIN
  SELECT * INTO r FROM documents WHERE doc_version_id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Khong tim thay van ban nay.'; END IF;
  IF r.status::text IN ('active', 'scheduled') THEN
    RAISE EXCEPTION 'Van ban dang ap dung hoac cho hieu luc. Hay bam Huy van ban truoc, roi moi chuyen vao Thung rac duoc.';
  END IF;

  IF r.status::text = 'trash' THEN
    DELETE FROM chunks WHERE doc_version_id = p_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM documents WHERE doc_version_id = p_id;

    INSERT INTO admin_actions (actor, action, document_id, doc_version_id, detail)
    VALUES (p_actor, 'purge', r.document_id, p_id,
            jsonb_build_object('title', r.title, 'version', r.version,
                               'status', 'purged', 'chunks', n));
    RETURN 'purged';
  END IF;

  UPDATE documents
     SET status = 'trash', deleted_at = now(), expiry_date = CURRENT_DATE - 1
   WHERE doc_version_id = p_id;

  INSERT INTO admin_actions (actor, action, document_id, doc_version_id, detail)
  VALUES (p_actor, 'trash', r.document_id, p_id,
          jsonb_build_object('title', r.title, 'version', r.version,
                             'days_retained', 30));
  RETURN 'trash';
END $function$;

-- 2. Phục hồi restore_version ban đầu
CREATE OR REPLACE FUNCTION public.restore_version(p_id uuid, p_actor text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  v documents%ROWTYPE;
BEGIN
  SELECT * INTO v FROM documents WHERE doc_version_id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Khong tim thay van ban nay.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v.document_id));

  UPDATE documents SET status = 'superseded', expiry_date = CURRENT_DATE - 1
   WHERE document_id = v.document_id AND status = 'active' AND doc_version_id <> p_id;

  UPDATE documents
     SET status = 'active', expiry_date = NULL, deleted_at = NULL, approved_by = p_actor, approved_at = now()
   WHERE doc_version_id = p_id;

  INSERT INTO audit_log(actor, action, doc_version_id, detail)
  VALUES (p_actor, 'restore', p_id, jsonb_build_object('document_id', v.document_id, 'version', v.version, 'title', v.title));

  INSERT INTO admin_actions(actor, action, document_id, doc_version_id, detail)
  VALUES (p_actor, 'restore', v.document_id, p_id, jsonb_build_object('version', v.version, 'title', v.title, 'status', 'active'));

  RETURN 'active';
END $function$;

-- 3. Xóa các cột đã thêm
ALTER TABLE documents DROP COLUMN IF EXISTS status_before_trash;
ALTER TABLE documents DROP COLUMN IF EXISTS deleted_by;
ALTER TABLE documents DROP COLUMN IF EXISTS deletion_reason;
