-- Migration: 20261106_hr_document_owner_delete.sql
-- Mục đích: Hỗ trợ HR Document Owner Delete Permission & Phục hồi đúng trạng thái gốc

-- 1. Bổ sung các cột lưu vết xóa mềm vào bảng documents
ALTER TABLE documents ADD COLUMN IF NOT EXISTS status_before_trash text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_by text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deletion_reason text;

-- 2. Cập nhật hàm delete_version để ghi nhận status_before_trash, deleted_by
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

  -- Neu ban nay da o trong Thung rac roi -> Xoa vinh vien (Purge)
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

  -- Neu chua trong Thung rac -> Chuyen vao Thung rac (Soft Delete) luu 30 ngay
  -- Ghi nhận lại status_before_trash để phục vụ khôi phục đúng trạng thái ban đầu
  UPDATE documents
     SET status_before_trash = r.status::text,
         status = 'trash',
         deleted_at = now(),
         deleted_by = p_actor,
         expiry_date = CURRENT_DATE - 1
   WHERE doc_version_id = p_id;

  INSERT INTO admin_actions (actor, action, document_id, doc_version_id, detail)
  VALUES (p_actor, 'trash', r.document_id, p_id,
          jsonb_build_object('title', r.title, 'version', r.version,
                             'status_before', r.status::text,
                             'days_retained', 30));
  RETURN 'trash';
END $function$;

-- 3. Cập nhật hàm restore_version để phục hồi ĐÚNG trạng thái trước khi xóa
-- Không tự ý chuyển rejected hoặc draft thành active; không tự ý duyệt tài liệu
CREATE OR REPLACE FUNCTION public.restore_version(p_id uuid, p_actor text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  v documents%ROWTYPE;
  target_status text;
BEGIN
  SELECT * INTO v FROM documents WHERE doc_version_id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Khong tim thay van ban nay.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v.document_id));

  -- Xác định trạng thái cần khôi phục:
  IF v.status_before_trash = 'rejected' OR (v.status_before_trash IS NULL AND v.reject_reason IS NOT NULL AND v.approved_at IS NULL) THEN
    target_status := 'rejected';
    UPDATE documents
       SET status = 'rejected', deleted_at = NULL, deleted_by = NULL, deletion_reason = NULL, status_before_trash = NULL
     WHERE doc_version_id = p_id;
  ELSIF v.status_before_trash = 'draft' OR (v.status_before_trash IS NULL AND v.approved_at IS NULL) THEN
    target_status := 'draft';
    UPDATE documents
       SET status = 'draft', deleted_at = NULL, deleted_by = NULL, deletion_reason = NULL, status_before_trash = NULL
     WHERE doc_version_id = p_id;
  ELSE
    target_status := 'active';
    UPDATE documents SET status = 'superseded', expiry_date = CURRENT_DATE - 1
     WHERE document_id = v.document_id AND status = 'active' AND doc_version_id <> p_id;

    UPDATE documents
       SET status = 'active', expiry_date = NULL, deleted_at = NULL, deleted_by = NULL, deletion_reason = NULL, status_before_trash = NULL,
           approved_by = COALESCE(approved_by, p_actor), approved_at = COALESCE(approved_at, now())
     WHERE doc_version_id = p_id;
  END IF;

  INSERT INTO audit_log(actor, action, doc_version_id, detail)
  VALUES (p_actor, 'restore', p_id, jsonb_build_object('document_id', v.document_id, 'version', v.version, 'title', v.title, 'restored_status', target_status));

  INSERT INTO admin_actions(actor, action, document_id, doc_version_id, detail)
  VALUES (p_actor, 'restore', v.document_id, p_id, jsonb_build_object('version', v.version, 'title', v.title, 'status', target_status));

  RETURN target_status;
END $function$;
