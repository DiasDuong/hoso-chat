-- ============================================================================
-- SOTRANS HUB — MIGRATION 05: ONEDRIVE AUTOMATIC BACKGROUND SYNC (180 SECONDS)
-- Task ID: ONEDRIVE-AUTO-SYNC-180S-01
-- ============================================================================

-- 1. Bổ sung các cột phục vụ Polling ngầm, Delta Query và Watched Folders vào user_onedrive_sources
ALTER TABLE public.user_onedrive_sources
    ADD COLUMN IF NOT EXISTS source_type VARCHAR(50) NOT NULL DEFAULT 'FILE', -- 'FILE', 'FOLDER'
    ADD COLUMN IF NOT EXISTS parent_folder_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS delta_link TEXT,
    ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS next_poll_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS is_watched BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS poll_status VARCHAR(50) NOT NULL DEFAULT 'IDLE', -- 'IDLE', 'POLLING', 'DETECTED', 'DOWNLOADING', 'PROCESSING', 'THROTTLED'
    ADD COLUMN IF NOT EXISTS poll_error_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS retry_after_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_onedrive_sources_polling 
    ON public.user_onedrive_sources(is_watched, sync_status, next_poll_at);

CREATE INDEX IF NOT EXISTS idx_onedrive_sources_parent 
    ON public.user_onedrive_sources(owner_user_id, parent_folder_id);

-- 2. Bổ sung cột cho onedrive_sync_jobs để theo dõi worker instance và retry
ALTER TABLE public.onedrive_sync_jobs
    ADD COLUMN IF NOT EXISTS worker_instance_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS retry_after_seconds INTEGER;

-- 3. Tạo bảng lưu trữ trạng thái và thống kê vận hành của Background Sync Worker
CREATE TABLE IF NOT EXISTS public.onedrive_sync_worker_states (
    id VARCHAR(100) PRIMARY KEY DEFAULT 'primary_worker',
    worker_instance_id VARCHAR(255),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    interval_ms INTEGER NOT NULL DEFAULT 180000,
    last_heartbeat TIMESTAMPTZ,
    last_run_started_at TIMESTAMPTZ,
    last_run_completed_at TIMESTAMPTZ,
    last_run_status VARCHAR(50) DEFAULT 'IDLE', -- 'IDLE', 'RUNNING', 'COMPLETED', 'FAILED', 'THROTTLED'
    last_run_duration_ms INTEGER DEFAULT 0,
    total_runs INTEGER DEFAULT 0,
    total_files_polled INTEGER DEFAULT 0,
    total_files_updated INTEGER DEFAULT 0,
    total_files_deleted INTEGER DEFAULT 0,
    total_errors INTEGER DEFAULT 0,
    stats JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Khởi tạo bản ghi mặc định cho primary worker
INSERT INTO public.onedrive_sync_worker_states (id, is_active, interval_ms, last_run_status, updated_at)
VALUES ('primary_worker', TRUE, 180000, 'IDLE', NOW())
ON CONFLICT (id) DO NOTHING;
