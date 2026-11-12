-- Migration: Create agent_output_files for Personal AI Agents output artifacts
-- Generated: 2026-10-19

CREATE TABLE IF NOT EXISTS public.agent_output_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    agent_id UUID NOT NULL,
    conversation_id UUID,
    file_name VARCHAR(255) NOT NULL,
    storage_path TEXT NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    file_size BIGINT NOT NULL,
    checksum_sha256 VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'READY',
    download_count INT NOT NULL DEFAULT 0,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),

    CONSTRAINT fk_agent_output_user FOREIGN KEY (user_id) 
        REFERENCES public.users(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_agent_output_agent FOREIGN KEY (agent_id) 
        REFERENCES public.user_agents(id) ON DELETE CASCADE,
    CONSTRAINT fk_agent_output_conv FOREIGN KEY (conversation_id) 
        REFERENCES public.ai_conversations(id) ON DELETE SET NULL,
    CONSTRAINT chk_agent_output_status CHECK (status IN ('GENERATING', 'READY', 'FAILED', 'EXPIRED'))
);

CREATE INDEX IF NOT EXISTS idx_agent_output_user_status ON public.agent_output_files(user_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_output_conv ON public.agent_output_files(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_output_expiry ON public.agent_output_files(expires_at) WHERE status != 'EXPIRED';
