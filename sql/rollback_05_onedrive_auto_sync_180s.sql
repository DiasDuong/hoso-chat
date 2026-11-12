-- ============================================================================
-- SOTRANS HUB — ROLLBACK MIGRATION 05: ONEDRIVE AUTOMATIC BACKGROUND SYNC
-- ============================================================================

DROP TABLE IF EXISTS public.onedrive_sync_worker_states;

DROP INDEX IF EXISTS idx_onedrive_sources_polling;
DROP INDEX IF EXISTS idx_onedrive_sources_parent;

ALTER TABLE public.user_onedrive_sources
    DROP COLUMN IF EXISTS source_type,
    DROP COLUMN IF EXISTS parent_folder_id,
    DROP COLUMN IF EXISTS delta_link,
    DROP COLUMN IF EXISTS last_polled_at,
    DROP COLUMN IF EXISTS next_poll_at,
    DROP COLUMN IF EXISTS is_watched,
    DROP COLUMN IF EXISTS poll_status,
    DROP COLUMN IF EXISTS poll_error_count,
    DROP COLUMN IF EXISTS retry_after_until;

ALTER TABLE public.onedrive_sync_jobs
    DROP COLUMN IF EXISTS worker_instance_id,
    DROP COLUMN IF EXISTS retry_after_seconds;
