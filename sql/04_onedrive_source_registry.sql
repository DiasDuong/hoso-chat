-- ============================================================================
-- SOTRANS HUB — MIGRATION 04: ONEDRIVE SOURCE REGISTRY & HYBRID SYNC SNAPSHOTS
-- ============================================================================

-- 1. Bảng lưu trữ nguồn tệp OneDrive đã liên kết (User OneDrive Sources)
CREATE TABLE IF NOT EXISTS public.user_onedrive_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id UUID NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
    agent_id VARCHAR(255), -- Hỗ trợ cả bot tích hợp ('excel-data-pro') lẫn My Agents (UUID)
    conversation_id VARCHAR(255),
    sharing_url TEXT,
    drive_id VARCHAR(255),
    item_id VARCHAR(255),
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    file_size BIGINT DEFAULT 0,
    etag VARCHAR(255),
    ctag VARCHAR(255),
    last_modified_at TIMESTAMPTZ,
    last_synced_at TIMESTAMPTZ,
    active_version INTEGER DEFAULT 0,
    sync_status VARCHAR(50) NOT NULL DEFAULT 'SYNCED', -- 'SYNCED', 'SYNCING', 'STALE', 'ERROR', 'DISCONNECTED'
    last_error TEXT,
    storage_path TEXT,
    active_snapshot_id UUID,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onedrive_sources_owner ON public.user_onedrive_sources(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_onedrive_sources_agent ON public.user_onedrive_sources(agent_id);
CREATE INDEX IF NOT EXISTS idx_onedrive_sources_item ON public.user_onedrive_sources(owner_user_id, item_id);
CREATE INDEX IF NOT EXISTS idx_onedrive_sources_status ON public.user_onedrive_sources(sync_status);

-- 2. Bảng lưu trữ Snapshot phiên bản tệp (Immutable Version Snapshots)
CREATE TABLE IF NOT EXISTS public.onedrive_source_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES public.user_onedrive_sources(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    etag VARCHAR(255),
    ctag VARCHAR(255),
    file_name VARCHAR(255) NOT NULL,
    file_size BIGINT NOT NULL,
    storage_path TEXT NOT NULL,
    manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
    data_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
    prompt_context TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'STAGING', -- 'STAGING', 'PUBLISHED', 'FAILED', 'ARCHIVED'
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_onedrive_snapshots_source ON public.onedrive_source_snapshots(source_id);
CREATE INDEX IF NOT EXISTS idx_onedrive_snapshots_status ON public.onedrive_source_snapshots(source_id, status);

-- 3. Bảng quản lý Job đồng bộ & Khóa Idempotency (Sync Jobs)
CREATE TABLE IF NOT EXISTS public.onedrive_sync_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES public.user_onedrive_sources(id) ON DELETE CASCADE,
    job_type VARCHAR(50) NOT NULL DEFAULT 'QUERY_TIME', -- 'WEBHOOK', 'SCHEDULED', 'QUERY_TIME', 'MANUAL'
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED'
    idempotency_key VARCHAR(255) UNIQUE,
    attempt_count INTEGER DEFAULT 0,
    target_etag VARCHAR(255),
    snapshot_id UUID REFERENCES public.onedrive_source_snapshots(id) ON DELETE SET NULL,
    error_message TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onedrive_sync_jobs_source ON public.onedrive_sync_jobs(source_id);
CREATE INDEX IF NOT EXISTS idx_onedrive_sync_jobs_status ON public.onedrive_sync_jobs(status);

-- 4. Bảng theo dõi Webhook Subscriptions từ Microsoft Graph (Graph Subscriptions)
CREATE TABLE IF NOT EXISTS public.onedrive_graph_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id VARCHAR(255) UNIQUE NOT NULL,
    user_id UUID NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
    resource VARCHAR(255) NOT NULL,
    change_type VARCHAR(100) NOT NULL DEFAULT 'updated',
    client_state VARCHAR(255) NOT NULL,
    notification_url TEXT NOT NULL,
    expiration_time TIMESTAMPTZ NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'EXPIRED', 'FAILED'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onedrive_subs_user ON public.onedrive_graph_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_onedrive_subs_subid ON public.onedrive_graph_subscriptions(subscription_id);
