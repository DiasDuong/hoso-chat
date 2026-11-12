-- HR Assistant: bổ sung cho gói 2 (Sửa thông tin, Xoá) và gói 4 (người thực hiện)
-- Chạy một lần. An toàn khi chạy lại.

CREATE TABLE IF NOT EXISTS admin_actions (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  actor          text NOT NULL,
  action         text NOT NULL,
  document_id    text,
  doc_version_id uuid,
  detail         jsonb
);

CREATE OR REPLACE FUNCTION edit_version_info(p_id uuid, p_actor text, p_title text, p_number text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  r documents%ROWTYPE;
  t text := btrim(coalesce(p_title, ''));
  n text := btrim(coalesce(p_number, ''));
BEGIN
  SELECT * INTO r FROM documents WHERE doc_version_id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy văn bản này.'; END IF;
  IF t = '' THEN RAISE EXCEPTION 'Tiêu đề không được để trống.'; END IF;

  UPDATE documents SET title = t, doc_number = n WHERE doc_version_id = p_id;

  INSERT INTO admin_actions (actor, action, document_id, doc_version_id, detail)
  VALUES (p_actor, 'edit', r.document_id, p_id,
          jsonb_build_object('title_old', r.title, 'title_new', t,
                             'number_old', r.doc_number, 'number_new', n));
  RETURN 'updated';
END $$;

CREATE OR REPLACE FUNCTION delete_version(p_id uuid, p_actor text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  r documents%ROWTYPE;
  n int;
BEGIN
  SELECT * INTO r FROM documents WHERE doc_version_id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy văn bản này.'; END IF;
  IF r.status::text IN ('active', 'scheduled') THEN
    RAISE EXCEPTION 'Văn bản đang áp dụng hoặc chờ hiệu lực. Hãy bấm Huỷ văn bản trước, rồi mới xoá được.';
  END IF;

  DELETE FROM chunks WHERE doc_version_id = p_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM documents WHERE doc_version_id = p_id;

  INSERT INTO admin_actions (actor, action, document_id, doc_version_id, detail)
  VALUES (p_actor, 'delete', r.document_id, p_id,
          jsonb_build_object('title', r.title, 'version', r.version,
                             'status', r.status::text, 'chunks', n));
  RETURN 'deleted';
END $$;
