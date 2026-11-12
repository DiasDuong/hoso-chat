-- =========================================================================
-- MIGRATION: 06_enterprise_agent_sharing.sql
-- SOTRANS HUB — Enterprise Personal AI Agent Sharing System
-- Viewer + Editor + Clone | Cross-company STL / VTX / SWC
-- =========================================================================

BEGIN;

-- 1. Bổ sung các cột vào bảng user_agents để hỗ trợ chia sẻ và nhân bản (cloning)
ALTER TABLE public.user_agents
  ADD COLUMN IF NOT EXISTS origin_agent_id UUID REFERENCES public.user_agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS origin_version INT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_shared BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_cloning BOOLEAN DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_user_agents_origin ON public.user_agents(origin_agent_id);

-- 2. Bổ sung các cột vào bảng user_agent_versions để hỗ trợ vòng đời phiên bản (draft, pending_review, published, archived)
ALTER TABLE public.user_agent_versions
  ADD COLUMN IF NOT EXISTS version_status VARCHAR(30) DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS published_by UUID REFERENCES public.users(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ DEFAULT NOW();

-- Cập nhật tất cả các phiên bản hiện có thành 'published'
UPDATE public.user_agent_versions 
SET version_status = 'published', published_at = created_at, published_by = created_by 
WHERE version_status IS NULL;

-- 3. Tạo bảng agent_shares để lưu trữ quyền chia sẻ Agent (Viewer, Editor, Target Scope, Expiry, Revoke)
CREATE TABLE IF NOT EXISTS public.agent_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.user_agents(id) ON DELETE CASCADE,
  shared_by UUID NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  share_type VARCHAR(30) NOT NULL CHECK (share_type IN ('USER', 'DEPARTMENT', 'COMPANY', 'ALL_INTERNAL')),
  target_user_id UUID REFERENCES public.users(user_id) ON DELETE CASCADE,
  target_department VARCHAR(100),
  target_company_id VARCHAR(50) REFERENCES public.companies(id) ON DELETE CASCADE,
  permission_role VARCHAR(20) NOT NULL CHECK (permission_role IN ('VIEWER', 'EDITOR')),
  can_clone BOOLEAN NOT NULL DEFAULT true,
  can_reshare BOOLEAN NOT NULL DEFAULT false,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Chỉ mục tối ưu hóa tra cứu quyền truy cập
CREATE INDEX IF NOT EXISTS idx_agent_shares_agent_id ON public.agent_shares(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_shares_target_user ON public.agent_shares(target_user_id, status) WHERE target_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_shares_target_comp ON public.agent_shares(target_company_id, status) WHERE target_company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_shares_active_lookup ON public.agent_shares(status, expires_at);

-- Ràng buộc Unique chống chia sẻ trùng lặp trong trạng thái ACTIVE
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_agent_share ON public.agent_shares(
  agent_id, 
  share_type, 
  COALESCE(target_user_id, '00000000-0000-0000-0000-000000000000'::uuid), 
  COALESCE(target_company_id, ''), 
  COALESCE(target_department, '')
) WHERE status = 'ACTIVE';

-- 4. Bảng agent_audit_logs ghi lại toàn bộ hoạt động chia sẻ, clone, versioning, đổi chủ sở hữu và từ chối truy cập
CREATE TABLE IF NOT EXISTS public.agent_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES public.user_agents(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES public.users(user_id) ON DELETE SET NULL,
  actor_username VARCHAR(100),
  actor_company_id VARCHAR(50),
  action VARCHAR(50) NOT NULL,
  target_type VARCHAR(50),
  target_id VARCHAR(100),
  details JSONB DEFAULT '{}'::jsonb,
  ip_address VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_audit_agent_id ON public.agent_audit_logs(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_audit_actor ON public.agent_audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_audit_action ON public.agent_audit_logs(action, created_at DESC);

-- 5. Bảng agent_notifications phục vụ thông báo cho người dùng khi được chia sẻ, thay đổi quyền, duyệt version
CREATE TABLE IF NOT EXISTS public.agent_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  sender_id UUID REFERENCES public.users(user_id) ON DELETE SET NULL,
  agent_id UUID REFERENCES public.user_agents(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_notifications_recipient ON public.agent_notifications(recipient_id, is_read, created_at DESC);

COMMIT;
