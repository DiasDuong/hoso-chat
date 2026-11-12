-- Function to mark single or multiple unanswered questions as handled/unhandled
-- Supports: single ID ('56'), comma-separated IDs ('56,55,54'), or exact question text
CREATE OR REPLACE FUNCTION mark_unanswered_handled(p_id text, p_mode text)
RETURNS jsonb AS $$
DECLARE
  v_handled boolean;
  v_count int;
BEGIN
  v_handled := CASE WHEN p_mode = 'unhandle' THEN false ELSE true END;

  IF p_id ~ '^[0-9]+(,[0-9]+)*$' THEN
    UPDATE unanswered_log
    SET handled = v_handled
    WHERE id = ANY(string_to_array(p_id, ',')::bigint[]);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSE
    UPDATE unanswered_log
    SET handled = v_handled
    WHERE trim(lower(question)) = trim(lower(p_id));
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('ok', true, 'target', p_id, 'handled', v_handled, 'count', v_count);
END;
$$ LANGUAGE plpgsql;
