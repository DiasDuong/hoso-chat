-- =============================================================================
-- SOTRANS HUB - MIGRATION 07: HYBRID ONEDRIVE SOURCE ASSOCIATIONS & RBAC
-- Target: Enable many-to-many Agent-Source associations and granular Source ACL
-- Safe & Idempotent: Does not drop existing data, preserves all historical snapshots
-- =============================================================================

BEGIN;

-- 1. Bổ sung các cột mở rộng cho user_onedrive_sources (nếu chưa có)
ALTER TABLE public.user_onedrive_sources
  ADD COLUMN IF NOT EXISTS company_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS source_scope VARCHAR(50) DEFAULT 'PERSONAL',
  ADD COLUMN IF NOT EXISTS is_shared BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE;

-- Cập nhật company_id từ bảng users cho các bản ghi hiện tại
UPDATE public.user_onedrive_sources s
SET company_id = u.company_id
FROM public.users u
WHERE s.owner_user_id = u.user_id AND (s.company_id IS NULL OR s.company_id = '');

-- 2. Bổ sung quyền đóng góp nguồn cho bảng agent_shares (nếu chưa có)
ALTER TABLE public.agent_shares
  ADD COLUMN IF NOT EXISTS can_contribute_source BOOLEAN DEFAULT FALSE;

-- 3. Tạo bảng trung gian quan hệ Nhiều - Nhiều giữa Agent và Nguồn OneDrive
CREATE TABLE IF NOT EXISTS public.agent_onedrive_source_associations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES public.user_agents(id) ON DELETE CASCADE,
    source_id UUID NOT NULL REFERENCES public.user_onedrive_sources(id) ON DELETE CASCADE,
    added_by UUID NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
    association_scope VARCHAR(50) NOT NULL DEFAULT 'PERSONAL', -- 'PERSONAL', 'SHARED'
    permission_status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',   -- 'ACTIVE', 'REVOKED', 'PENDING'
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_agent_source_association UNIQUE (agent_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_source_assoc_agent 
  ON public.agent_onedrive_source_associations(agent_id, permission_status);

CREATE INDEX IF NOT EXISTS idx_agent_source_assoc_source 
  ON public.agent_onedrive_source_associations(source_id, permission_status);

CREATE INDEX IF NOT EXISTS idx_agent_source_assoc_added_by 
  ON public.agent_onedrive_source_associations(added_by);

-- 4. BẢO TRÌ & SỬA LỖI DỮ LIỆU ĐÍCH CHO HR_STL (User ID: 9a2e8590-c1a2-41c6-abb2-b802cb8060c6)
-- Agent đích: cbb7053e-c388-4072-a87f-1e49b6facf07 (Excel-Data-Pro thuộc sở hữu emp_stl)
-- Source đích: b0112ae9-6035-4af3-b82d-47d1fa21608f (Pricing Vendor.xlsx, snapshot v4)

-- 4a. Cập nhật quyền đóng góp nguồn cho hr_stl trên Agent cbb7053e...
UPDATE public.agent_shares
SET can_contribute_source = TRUE,
    updated_at = NOW()
WHERE agent_id = 'cbb7053e-c388-4072-a87f-1e49b6facf07'
  AND target_user_id = '9a2e8590-c1a2-41c6-abb2-b802cb8060c6'
  AND status = 'ACTIVE';

-- 4b. Chuẩn hóa agent_id từ slug 'excel-data-pro' sang UUID chuẩn 'cbb7053e-c388-4072-a87f-1e49b6facf07'
UPDATE public.user_onedrive_sources
SET agent_id = 'cbb7053e-c388-4072-a87f-1e49b6facf07',
    source_scope = 'SHARED',
    is_shared = TRUE,
    company_id = 'STL',
    updated_at = NOW()
WHERE id = 'b0112ae9-6035-4af3-b82d-47d1fa21608f'
  AND owner_user_id = '9a2e8590-c1a2-41c6-abb2-b802cb8060c6';

-- 4c. Tạo bản ghi liên kết hợp lệ trong agent_onedrive_source_associations
INSERT INTO public.agent_onedrive_source_associations (
    agent_id,
    source_id,
    added_by,
    association_scope,
    permission_status
) VALUES (
    'cbb7053e-c388-4072-a87f-1e49b6facf07',
    'b0112ae9-6035-4af3-b82d-47d1fa21608f',
    '9a2e8590-c1a2-41c6-abb2-b802cb8060c6',
    'SHARED',
    'ACTIVE'
) ON CONFLICT (agent_id, source_id) 
DO UPDATE SET 
    permission_status = 'ACTIVE',
    association_scope = 'SHARED',
    updated_at = NOW();

-- 4d. Tạo association tương ứng cho nguồn của emp_vtx (agent b6a784da-cfb1-43c4-81ba-8853116cd9cd, source 90c8fad8-7e9e-4223-bd46-76cce394e1f6)
INSERT INTO public.agent_onedrive_source_associations (
    agent_id,
    source_id,
    added_by,
    association_scope,
    permission_status
) VALUES (
    'b6a784da-cfb1-43c4-81ba-8853116cd9cd',
    '90c8fad8-7e9e-4223-bd46-76cce394e1f6',
    'bd33d589-3804-469e-a373-a934a5855d19',
    'PERSONAL',
    'ACTIVE'
) ON CONFLICT (agent_id, source_id) DO NOTHING;

-- 5. Đánh dấu is_archived = TRUE cho 17 nguồn cũ bị DISCONNECTED của emp_stl (không xóa vật lý)
UPDATE public.user_onedrive_sources
SET is_archived = TRUE,
    company_id = 'STL'
WHERE owner_user_id = 'f2b6606e-3125-409c-b5f9-d3ed82282c26'
  AND sync_status = 'DISCONNECTED'
  AND is_archived = FALSE;

COMMIT;
