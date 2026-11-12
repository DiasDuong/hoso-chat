-- ============================================================================
-- SOTRANS HUB - MIGRATION: DOCUMENT GOVERNANCE & POLICY RELATIONSHIPS
-- Date: 2026-11-03
-- Purpose:
--   1. Add document_family_id, doc_code, category, and structured scopes
--   2. Create table document_relationships for explicit policy links
--   3. Backfill existing 22 documents with semantic governance metadata
--   4. Update unique active constraint from (document_id) to (document_family_id)
-- ============================================================================

BEGIN;

-- 1. Bổ sung các cột định danh và phân cấp chính sách vào bảng documents
ALTER TABLE public.documents
    ADD COLUMN IF NOT EXISTS document_family_id TEXT,
    ADD COLUMN IF NOT EXISTS doc_code TEXT,
    ADD COLUMN IF NOT EXISTS category TEXT,
    ADD COLUMN IF NOT EXISTS department_scope TEXT[] DEFAULT '{all}'::TEXT[],
    ADD COLUMN IF NOT EXISTS business_unit_scope TEXT[] DEFAULT '{all}'::TEXT[],
    ADD COLUMN IF NOT EXISTS location_scope TEXT[] DEFAULT '{all}'::TEXT[],
    ADD COLUMN IF NOT EXISTS employee_group_scope TEXT[] DEFAULT '{all}'::TEXT[];

-- 2. Tạo bảng quan hệ chính sách văn bản (document_relationships)
CREATE TABLE IF NOT EXISTS public.document_relationships (
    relationship_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_doc_version_id UUID NOT NULL REFERENCES public.documents(doc_version_id) ON DELETE CASCADE,
    target_doc_version_id UUID NOT NULL REFERENCES public.documents(doc_version_id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL CHECK (relation_type IN ('supersedes', 'supplements', 'amends', 'clarifies', 'exception_to', 'applies_with')),
    approval_status TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
    notes TEXT,
    created_by TEXT DEFAULT 'system',
    approved_by TEXT DEFAULT 'system',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT unique_doc_relationship UNIQUE (source_doc_version_id, target_doc_version_id, relation_type)
);

-- 3. Tạo các chỉ mục tối ưu hóa truy vấn
CREATE INDEX IF NOT EXISTS idx_documents_family_id ON public.documents(document_family_id);
CREATE INDEX IF NOT EXISTS idx_documents_doc_code ON public.documents(doc_code);
CREATE INDEX IF NOT EXISTS idx_documents_category ON public.documents(category);
CREATE INDEX IF NOT EXISTS idx_doc_rel_source ON public.document_relationships(source_doc_version_id);
CREATE INDEX IF NOT EXISTS idx_doc_rel_target ON public.document_relationships(target_doc_version_id);
CREATE INDEX IF NOT EXISTS idx_doc_rel_type ON public.document_relationships(relation_type);

-- 4. Backfill dữ liệu cho 22 văn bản hiện hữu

-- Nhóm CHINH_SACH:
UPDATE public.documents
SET document_family_id = 'DOC-FAM-CS-VTX',
    doc_code = COALESCE(NULLIF(doc_number, 's/n'), 'CS-VTX-01'),
    category = 'CHINH_SACH',
    department_scope = '{all}',
    business_unit_scope = '{all}',
    employee_group_scope = '{all}'
WHERE doc_version_id = 'c031fd55-2baf-4c5a-a56d-80375b565141';

UPDATE public.documents
SET document_family_id = 'DOC-FAM-GIO-LAM-VIEC-MAU',
    doc_code = COALESCE(NULLIF(doc_number, 's/n'), 'CS-GLV-MAU'),
    category = 'CHINH_SACH',
    department_scope = '{khoi_van_phong}',
    business_unit_scope = '{sowatco}',
    employee_group_scope = '{all}'
WHERE doc_version_id = '481dad7a-6856-4f01-bbe1-e066e782ec39';

UPDATE public.documents
SET document_family_id = 'DOC-FAM-CA-09H30',
    doc_code = COALESCE(NULLIF(doc_number, 's/n'), 'QD-CA-09H30'),
    category = 'CHINH_SACH',
    department_scope = '{khoi_van_phong}',
    business_unit_scope = '{sowatco}',
    employee_group_scope = '{all}'
WHERE doc_version_id = '298d5728-7a73-4faf-ade8-b819991bdb64';

UPDATE public.documents
SET document_family_id = 'DOC-FAM-SO-TAY-DOANH-NGHIEP',
    doc_code = COALESCE(NULLIF(doc_number, 's/n'), 'ST-CSDN-2026-V4'),
    category = 'SO_TAY',
    department_scope = '{all}',
    business_unit_scope = '{all}',
    employee_group_scope = '{all}'
WHERE doc_version_id = '61a4bae2-9d0e-49ee-ae5d-54f9d73b0131';

UPDATE public.documents
SET document_family_id = 'DOC-FAM-SO-TAY-DOANH-NGHIEP',
    doc_code = COALESCE(NULLIF(doc_number, 's/n'), 'ST-CSDN-2026-V5'),
    category = 'SO_TAY',
    department_scope = '{all}',
    business_unit_scope = '{all}',
    employee_group_scope = '{all}'
WHERE doc_version_id = '3b782464-c43e-4598-b5ba-0b27070a999b';

UPDATE public.documents
SET document_family_id = 'DOC-FAM-TRU-SO-CHINH',
    doc_code = 'QC-VPC-2024-V1',
    category = 'QUY_CHE_QUY_TRINH',
    department_scope = '{khoi_van_phong,tru_so_chinh}',
    business_unit_scope = '{tru_so_chinh}',
    employee_group_scope = '{all}'
WHERE doc_version_id = '5b7d06fb-aeff-4000-ac28-75accf90e47e';

-- Nhóm QUY_CHE_QUY_TRINH:
UPDATE public.documents
SET document_family_id = 'DOC-FAM-CHI-NHANH-KHO-VAN',
    doc_code = COALESCE(NULLIF(doc_number, 's/n'), 'QC-CNKV-2025'),
    category = 'QUY_CHE_QUY_TRINH',
    department_scope = '{kho_bai,chi_nhanh_kho_van}',
    business_unit_scope = '{chi_nhanh_kho_van}',
    employee_group_scope = '{nhan_vien_kho,lai_xe_nang,tally}'
WHERE doc_version_id = 'fdc23a99-380f-4519-817d-e1a14d3d9ebc';

UPDATE public.documents
SET document_family_id = 'DOC-FAM-CHUYEN-DOI-SO',
    doc_code = 'QC-DXM-2026-FLEX',
    category = 'QUY_CHE_QUY_TRINH',
    department_scope = '{chuyen_doi_so,khoi_van_phong}',
    business_unit_scope = '{trung_tam_chuyen_doi_so}',
    employee_group_scope = '{nhan_vien_chuyen_doi_so,van_hanh_linh_hoat}'
WHERE doc_version_id = 'b8e88d94-b790-4122-be56-99a8b3ae8b74';

-- Nhóm GLOBAL & NOIQUY:
UPDATE public.documents
SET document_family_id = 'DOC-FAM-GLOBAL-POLICY',
    doc_code = '01/QC-SOTRANS',
    category = 'QUY_CHE_QUY_TRINH',
    department_scope = '{all}',
    business_unit_scope = '{all}',
    employee_group_scope = '{all}'
WHERE doc_version_id = 'e0bf4923-33c0-4c6f-8cd9-92d21ebca7ae';

UPDATE public.documents
SET document_family_id = 'DOC-FAM-NOIQUY',
    doc_code = '17/QĐ-LAODONG',
    category = 'NOIQUY',
    department_scope = '{all}',
    business_unit_scope = '{all}',
    employee_group_scope = '{all}'
WHERE doc_version_id = '980882d0-3afc-4992-826e-b2eb2281ac9c';

UPDATE public.documents
SET document_family_id = 'DOC-FAM-NOIQUY',
    doc_code = '15/QĐ-SOTRANS',
    category = 'NOIQUY',
    department_scope = '{kho_bai,van_tai,all}',
    business_unit_scope = '{all}',
    employee_group_scope = '{all}'
WHERE doc_version_id = '6309646b-6d02-4827-b739-7b90d19f756f';

-- Nhóm PHỤ CẤP:
UPDATE public.documents
SET document_family_id = 'DOC-FAM-PHUCAP-GLOBAL',
    doc_code = '18/2023/QC-SOTRANS',
    category = 'QUY_CHE_QUY_TRINH',
    department_scope = '{all}',
    business_unit_scope = '{all}',
    employee_group_scope = '{all}'
WHERE doc_version_id = 'a0000001-0001-4000-8000-000000000001';

UPDATE public.documents
SET document_family_id = 'DOC-FAM-PHUCAP-VTX',
    doc_code = '45/2024/QĐ-VTX',
    category = 'CHINH_SACH',
    branch_scope = '{vietranstimex}',
    department_scope = '{du_an,cong_truong,van_tai}',
    business_unit_scope = '{chi_nhanh_vtx}',
    employee_group_scope = '{chuyen_gia_du_an,ky_su_cong_truong,to_doi_spmt}'
WHERE doc_version_id = 'a0000002-0002-4000-8000-000000000002';

-- Nhóm CÔNG TY THÀNH VIÊN:
UPDATE public.documents
SET document_family_id = 'DOC-FAM-STL-POLICY',
    doc_code = '10/QD-STL',
    category = 'QUY_CHE_QUY_TRINH',
    branch_scope = '{sotrans_logistics}',
    department_scope = '{giao_nhan,hien_truong,all}',
    business_unit_scope = '{sotrans_logistics}',
    employee_group_scope = '{all}'
WHERE doc_version_id = 'a0b2ad2e-cdeb-4bf3-97a9-5243420384d2';

UPDATE public.documents
SET document_family_id = 'DOC-FAM-VTX-POLICY',
    doc_code = '20/QD-VTX',
    category = 'QUY_CHE_QUY_TRINH',
    branch_scope = '{vietranstimex}',
    department_scope = '{van_tai,du_an,all}',
    business_unit_scope = '{vietranstimex}',
    employee_group_scope = '{all}'
WHERE doc_version_id = '432a3c27-283c-474d-bde4-357ad092896e';

-- Các tài liệu còn lại (mặc định theo document_id):
UPDATE public.documents
SET document_family_id = COALESCE(document_family_id, 'DOC-FAM-' || document_id),
    doc_code = COALESCE(doc_code, NULLIF(doc_number, 's/n'), document_id),
    category = COALESCE(category, 'CHINH_SACH'),
    department_scope = COALESCE(department_scope, '{all}'),
    business_unit_scope = COALESCE(business_unit_scope, '{all}'),
    employee_group_scope = COALESCE(employee_group_scope, '{all}')
WHERE document_family_id IS NULL;

-- 5. Thiết lập quan hệ chính sách ban đầu giữa các văn bản đã rõ căn cứ
INSERT INTO public.document_relationships
    (source_doc_version_id, target_doc_version_id, relation_type, approval_status, notes, created_by, approved_by)
VALUES
    -- 45/2024/QĐ-VTX supplements 18/2023/QC-SOTRANS
    (
        'a0000002-0002-4000-8000-000000000002',
        'a0000001-0001-4000-8000-000000000001',
        'supplements',
        'approved',
        'Quyết định 45/2024/QĐ-VTX bổ sung chế độ phụ cấp công trường dự án cho Vietranstimex so với Quy chế 18/2023/QC-SOTRANS của Tập đoàn',
        'system',
        'system'
    ),
    -- 15/QĐ-SOTRANS supersedes 17/QĐ-LAODONG
    (
        '6309646b-6d02-4827-b739-7b90d19f756f',
        '980882d0-3afc-4992-826e-b2eb2281ac9c',
        'supersedes',
        'approved',
        'Quyết định 15/QĐ-SOTRANS thay thế cho Quyết định 17/QĐ-LAODONG về an toàn lao động',
        'system',
        'system'
    ),
    -- QC-DXM-2026-FLEX exception_to QC-VPC-2024-V1
    (
        'b8e88d94-b790-4122-be56-99a8b3ae8b74',
        '5b7d06fb-aeff-4000-ac28-75accf90e47e',
        'exception_to',
        'approved',
        'QC-DXM-2026-FLEX quy định giờ linh hoạt flexitime và hybrid là ngoại lệ áp dụng riêng cho Khối chuyển đổi số so với quy chuẩn Trụ sở chính',
        'system',
        'system'
    )
ON CONFLICT (source_doc_version_id, target_doc_version_id, relation_type) DO NOTHING;

-- 6. Thay thế ràng buộc một active per doc_id thành một active per document_family_id
DROP INDEX IF EXISTS public.one_active_per_doc;

CREATE UNIQUE INDEX one_active_per_family
ON public.documents (document_family_id)
WHERE status = 'active'::doc_status;

COMMIT;
