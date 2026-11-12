DROP FUNCTION IF EXISTS public.edit_version_info(uuid, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.edit_version_info(
  p_id uuid,
  p_actor text,
  p_title text,
  p_number text,
  p_effective_date text DEFAULT NULL,
  p_expiry_date text DEFAULT NULL,
  p_branch_scope text DEFAULT NULL,
  p_doc_type text DEFAULT NULL,
  p_role_access text DEFAULT NULL,
  p_change_summary text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
AS $function$
DECLARE
  r documents%ROWTYPE;
  t text := btrim(coalesce(p_title, ''));
  n text := btrim(coalesce(p_number, ''));
  eff date;
  exp date;
  new_status doc_status;
  new_branch text[];
  new_role text[];
  new_type text;
  new_summary text;
BEGIN
  SELECT * INTO r FROM documents WHERE doc_version_id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy văn bản này.'; END IF;
  IF t = '' THEN RAISE EXCEPTION 'Tiêu đề không được để trống.'; END IF;

  eff := r.effective_date;
  IF p_effective_date IS NOT NULL AND btrim(p_effective_date) <> '' THEN
    eff := p_effective_date::date;
  END IF;

  exp := r.expiry_date;
  IF p_expiry_date IS NOT NULL THEN
    IF btrim(p_expiry_date) = '' THEN
      exp := NULL;
    ELSE
      exp := p_expiry_date::date;
    END IF;
  END IF;

  IF exp IS NOT NULL AND exp < eff THEN
    RAISE EXCEPTION 'Ngày hết hiệu lực phải sau ngày có hiệu lực.';
  END IF;

  new_status := r.status;
  -- Nếu đang ở trạng thái scheduled mà đổi ngày hiệu lực <= hôm nay:
  -- Tự động kích hoạt thành active luôn!
  IF r.status = 'scheduled' AND eff <= CURRENT_DATE THEN
    new_status := 'active';
    UPDATE documents SET status = 'superseded', expiry_date = eff - 1
     WHERE document_id = r.document_id AND status = 'active' AND doc_version_id <> p_id;
  ELSIF r.status = 'active' AND eff > CURRENT_DATE THEN
    new_status := 'scheduled';
  END IF;

  -- Xử lý branch_scope
  new_branch := r.branch_scope;
  IF p_branch_scope IS NOT NULL AND btrim(p_branch_scope) <> '' THEN
    new_branch := string_to_array(btrim(p_branch_scope), ',');
  END IF;

  -- Xử lý role_access
  new_role := r.role_access;
  IF p_role_access IS NOT NULL AND btrim(p_role_access) <> '' THEN
    new_role := string_to_array(btrim(p_role_access), ',');
  END IF;

  -- Xử lý doc_type
  new_type := r.doc_type;
  IF p_doc_type IS NOT NULL AND btrim(p_doc_type) <> '' THEN
    new_type := btrim(p_doc_type);
  END IF;

  -- Xử lý change_summary
  new_summary := r.change_summary;
  IF p_change_summary IS NOT NULL AND btrim(p_change_summary) <> '' THEN
    new_summary := btrim(p_change_summary);
  END IF;

  UPDATE documents
     SET title = t,
         doc_number = n,
         effective_date = eff,
         expiry_date = exp,
         status = new_status,
         branch_scope = new_branch,
         role_access = new_role,
         doc_type = new_type,
         change_summary = new_summary
   WHERE doc_version_id = p_id;

  INSERT INTO admin_actions (actor, action, document_id, doc_version_id, detail)
  VALUES (p_actor, 'edit', r.document_id, p_id,
          jsonb_build_object(
            'title_old', r.title, 'title_new', t,
            'number_old', r.doc_number, 'number_new', n,
            'effective_old', r.effective_date, 'effective_new', eff,
            'status_old', r.status, 'status_new', new_status,
            'branch_old', r.branch_scope, 'branch_new', new_branch,
            'role_old', r.role_access, 'role_new', new_role,
            'doc_type_old', r.doc_type, 'doc_type_new', new_type,
            'summary', new_summary
          ));

  RETURN new_status::text;
END $function$;
