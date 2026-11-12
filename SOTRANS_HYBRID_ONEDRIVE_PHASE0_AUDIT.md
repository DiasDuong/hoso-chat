# SOTRANS HUB — BÁO CÁO GIAI ĐOẠN 0: AUDIT & THIẾT KẾ KIẾN TRÚC HYBRID ONEDRIVE DATA ACCESS
## QUẢN LÝ NGUỒN DỮ LIỆU CÁ NHÂN VÀ DÙNG CHUNG CHO PERSONAL AI AGENT

**Dự án:** SOTRANS Hub (`D:\hoso-chat`)  
**Phạm vi áp dụng:** Hệ thống Personal AI Agents, Microsoft OneDrive Integration, Excel-Data-Pro  
**Phạm vi công ty:** SOTRANS Logistics (`STL`), Vietranstimex (`VTX`), Sowatco (`SWC`)  
**Phương án triển khai:** Phương án C — Hybrid Data Access (Personal Source & Shared Source)  
**Thời điểm thực hiện kiểm toán:** 03/11/2026 — 09:25:00 (GMT+7)  
**Chế độ thực thi:** STRICT READ-ONLY AUDIT (Không sửa code, không migration, không ghi database, không restart container)  
**Trạng thái kiểm toán:** HOÀN THÀNH GIAI ĐOẠN 0 — CHỜ PHÊ DUYỆT TRƯỚC KHI TRIỂN KHAI  

---

## 1. SƠ ĐỒ KIẾN TRÚC HIỆN TẠI (CURRENT ARCHITECTURE)

### 1.1. Luồng vận hành hiện hữu
Trong kiến trúc hiện tại, mối quan hệ giữa Người dùng, Tài khoản Microsoft OAuth, Nguồn OneDrive, Snapshot và Personal AI Agent được tổ chức đơn tuyến (1-1 cứng nhắc) và bị cô lập tuyệt đối theo `owner_user_id`:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ KIẾN TRÚC HIỆN TẠI (ĐƠN TUYẾN - THIẾU LỚP SOURCE ACL)                           │
└─────────────────────────────────────────────────────────────────────────────────┘

 [User (hr_stl / STL)]                   [User (emp_vtx / VTX)]
        │ (Login JWT)                           │ (Login JWT)
        ▼                                       ▼
┌──────────────────┐                    ┌──────────────────┐
│user_oauth_tokens │                    │user_oauth_tokens │
│(Token riêng)     │                    │(Token riêng)     │
└────────┬─────────┘                    └────────┬─────────┘
         │                                       │
         ▼ (Chưa Import)                         ▼ (Đã Import)
┌─────────────────────────┐             ┌─────────────────────────┐
│  user_onedrive_sources  │             │  user_onedrive_sources  │
│  (0 bản ghi cho hr_stl) │             │  (Source: 90c8fad8...)  │
└─────────────────────────┘             │  owner_user_id: emp_vtx │
                                        │  agent_id: b6a784da...  │
                                        │  active_version: v51    │
                                        └────────┬────────────────┘
                                                 │
                                                 ▼ (180s Worker Poll)
                                        ┌─────────────────────────┐
                                        │onedrive_source_snapshots│
                                        │(Snapshot: e8fb6c58...v51│
                                        │ 8 sheets, 12 rows MB)   │
                                        └─────────────────────────┘

[Agent Chat: custom_cbb7053e... (Excel-Data-Pro)]
   ▲
   │ (Người dùng hr_stl gửi câu hỏi: "giá từ Thái Hà đến Lô B2...")
   │
   ├─► ensureAgentSourcesFreshness(userId: hr_stl.id)
   │     │
   │     ▼
   │   getConnectedSourcesForAgent(ownerUserId: hr_stl.id)
   │     │
   │     ▼
   │   SQL: SELECT * FROM user_onedrive_sources WHERE owner_user_id = hr_stl.id ...
   │     │
   │     ▼
   │   ❌ KẾT QUẢ: 0 SOURCES TRẢ VỀ (Do hr_stl chưa tự import source nào)
   │   (Mặc dù Agent này được chia sẻ từ emp_stl, và file đã có snapshot v51 trong DB!)
   │
   └─► FALLBACK PROMPT INJECTION (routes/agents.js:1881):
         "Hiện tại KHÔNG có tệp dữ liệu nào đang được kết nối với Agent..."
```

### 1.2. Các điểm nghẽn và hạn chế cốt lõi của kiến trúc hiện tại
1. **Thiếu hoàn toàn khái niệm Source Scope:** Bảng `user_onedrive_sources` không có cột phân loại `source_scope` (Personal vs Shared), không có cột `company_id`. Mọi nguồn đều bị mặc định là tài sản cá nhân đơn lẻ của `owner_user_id`.
2. **Quan hệ 1-1 cứng giữa Source và Agent:** Cột `agent_id VARCHAR(255)` nằm trực tiếp trên bảng `user_onedrive_sources`. Một nguồn không thể phục vụ đồng thời cho 2 Agent khác nhau; nếu gán nguồn cho Agent mới, liên kết với Agent cũ bị ghi đè.
3. **Sự đứt gãy giữa Agent ACL và Source ACL:** Hệ thống đã có bảng `agent_shares` để chia sẻ quyền Agent (`VIEWER`, `EDITOR`), nhưng tầng dữ liệu OneDrive hoàn toàn không nhận biết `agent_shares`. Người dùng được chia sẻ Agent không thể đọc nguồn dữ liệu mà chủ sở hữu đã gắn vào Agent.
4. **Vòng đời OAuth mang tính hủy diệt (Destructive Disconnect):** Khi người dùng ngắt kết nối Microsoft OAuth, hàm `disconnectOAuth()` lập tức chạy câu lệnh:
   `UPDATE user_onedrive_sources SET sync_status = 'DISCONNECTED', active_snapshot_id = NULL, agent_id = NULL WHERE owner_user_id = $1`
   Hành vi này xóa sạch liên kết Agent và gỡ bỏ con trỏ snapshot hoạt động, biến các nguồn thành dữ liệu mồ côi không thể tự khôi phục khi kết nối lại.
5. **Giao diện người dùng phản ánh sai trạng thái thực tế:**
   - Header button hiển thị màu xanh **"OneDrive [Đã nối]"** chỉ dựa vào cờ `connected === true` của tài khoản Microsoft, dù Agent đang có 0 tệp.
   - Modal hiển thị trạng thái daemon hệ thống (`primary_worker.lastRunStatus = 'COMPLETED'`) thay vì trạng thái đồng bộ dữ liệu của chính người dùng.

---

## 2. SƠ ĐỒ KIẾN TRÚC ĐỀ XUẤT (PROPOSED HYBRID ARCHITECTURE — OPTION C)

Kiến trúc Hybrid Data Access tách biệt rõ ràng hai tầng kiểm soát: **Agent ACL** (Quyền trên cấu hình Agent) và **Source ACL** (Quyền trên nguồn dữ liệu), đồng thời phân định minh bạch hai phạm vi nguồn: **PERSONAL SOURCE** và **SHARED SOURCE**.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ KIẾN TRÚC ĐỀ XUẤT: HYBRID ONEDRIVE DATA ACCESS (PHƯƠNG ÁN C)                                     │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘

                                 [Microsoft OneDrive Upstream]
                                              │ (OAuth Token per Owner)
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ TẦNG NGUỒN DỮ LIỆU ONEDRIVE (STORAGE & SNAPSHOT ENGINE)                                         │
│                                                                                                 │
│  public.user_onedrive_sources                                                                   │
│  ├─ id (UUID PK)                                                                                │
│  ├─ owner_user_id (UUID FK -> users)                                                            │
│  ├─ company_id (VARCHAR FK -> companies: STL, VTX, SWC)                                         │
│  ├─ source_scope ('PERSONAL' | 'SHARED')                                                        │
│  ├─ is_shared (BOOLEAN)                                                                         │
│  ├─ sync_status ('SYNCED' | 'DISCONNECTED' | 'PAUSED' | 'DELETED_UPSTREAM')                     │
│  └─ active_snapshot_id (UUID FK -> onedrive_source_snapshots)                                   │
│                                                                                                 │
│  public.onedrive_source_snapshots (Bản chụp cấu trúc dữ liệu bất biến: v1, v2... v51)           │
└───────────────────────┬─────────────────────────────────────────────────┬───────────────────────┘
                        │                                                 │
                        ▼ (Quan hệ N - N)                                 ▼ (Phân quyền độc lập)
┌──────────────────────────────────────────────┐ ┌────────────────────────────────────────────────┐
│ TẦNG LIÊN KẾT NGUỒN - AGENT                  │ │ TẦNG PHÂN QUYỀN NGUỒN DỮ LIỆU (SOURCE ACL)     │
│ (agent_onedrive_source_associations)         │ │ (onedrive_source_shares)                       │
│                                              │ │                                                │
│ ├─ id (UUID PK)                              │ │ ├─ id (UUID PK)                                │
│ ├─ source_id (UUID FK)                       │ │ ├─ source_id (UUID FK)                         │
│ ├─ agent_id (VARCHAR/UUID)                   │ │ ├─ shared_by (UUID FK)                         │
│ ├─ source_role ('PRIMARY'|'SUPPLEMENTARY')   │ │ ├─ share_type ('USER'|'DEPT'|'COMP'|'AGENT')   │
│ ├─ status ('ACTIVE' | 'UNLINKED')            │ │ ├─ target_user_id / target_company_id          │
│ └─ added_by (UUID FK)                        │ │ ├─ permission ('READ'|'MANAGE'|'SHARE')        │
│                                              │ │ ├─ cross_company_approved_by (UUID FK)         │
│                                              │ │ └─ status ('ACTIVE' | 'REVOKED' | 'EXPIRED')   │
└───────────────────────┬──────────────────────┘ └────────────────────────┬───────────────────────┘
                        │                                                 │
                        └───────────────────────┬─────────────────────────┘
                                                ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ TẦNG BẢO VỆ ĐỘ MỚI & TRUY XUẤT (QUERY-TIME FRESHNESS & ACCESS GUARD)                            │
│                                                                                                 │
│  Caller: req.user (user_id, company_id, role)                                                   │
│  Target Agent: agent_id                                                                         │
│                                                                                                 │
│  1. Kiểm tra Agent ACL: Người dùng có quyền truy cập Agent không? (Owner / Viewer / Editor)     │
│  2. Truy xuất Nguồn Cá nhân: Sources do chính caller sở hữu gắn với Agent này                   │
│  3. Truy xuất Nguồn Dùng chung: Sources gắn với Agent mà caller ĐƯỢC CẤP QUYỀN READ_SOURCE     │
│  4. Kiểm tra Ranh giới Công ty (STL / VTX / SWC):                                               │
│     - Cùng công ty: Cho phép nếu có Source ACL hợp lệ.                                          │
│     - Khác công ty: Chặn tuyệt đối (DENY BY DEFAULT) trừ khi có Explicit Cross-Company Grant.   │
│  5. Hợp nhất danh sách nguồn được phép (Permitted Sources)                                      │
│  6. Nạp Snapshots tương ứng vào activeFiles & activeSpreadsheets                                │
└───────────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                                ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ TẦNG TRÍ TUỆ NHÂN TẠO & TRÍCH XUẤT (AGENT REASONING & DATA ENGINE)                              │
│                                                                                                 │
│  - dataEngine.searchSpreadsheetRecords: Tìm kiếm chính xác trên bảng tính được cấp quyền         │
│  - Zero Hallucination: Không suy đoán ngoài phạm vi snapshot hợp lệ                             │
│  - Provenance Notes: Ghi chú rõ nguồn dữ liệu trích xuất (Cá nhân hay Dùng chung của Công ty)   │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. SCHEMA HIỆN TẠI VÀ THAY ĐỔI SCHEMA CẦN THIẾT

### 3.1. Schema hiện tại trong PostgreSQL

#### Bảng `public.user_onedrive_sources`
```sql
Table "public.user_onedrive_sources"
- id: uuid NOT NULL DEFAULT gen_random_uuid() (PK)
- owner_user_id: uuid NOT NULL (FK -> users.user_id ON DELETE CASCADE)
- agent_id: character varying(255) NULL
- conversation_id: character varying(255) NULL
- sharing_url: text NULL
- drive_id: character varying(255) NULL
- item_id: character varying(255) NULL
- file_name: character varying(255) NOT NULL
- mime_type: character varying(100) NOT NULL
- file_size: bigint NULL DEFAULT 0
- etag: character varying(255) NULL
- ctag: character varying(255) NULL
- last_modified_at: timestamp with time zone NULL
- last_synced_at: timestamp with time zone NULL
- active_version: integer NULL DEFAULT 0
- sync_status: character varying(50) NOT NULL DEFAULT 'SYNCED'
- last_error: text NULL
- storage_path: text NULL
- active_snapshot_id: uuid NULL
- metadata: jsonb NULL DEFAULT '{}'::jsonb
- content_hash: character varying(64) NULL
- last_successful_sync_at: timestamp with time zone NULL
- sync_started_at: timestamp with time zone NULL
- source_type: character varying(50) NOT NULL DEFAULT 'FILE'
- parent_folder_id: character varying(255) NULL
- delta_link: text NULL
- last_polled_at: timestamp with time zone NULL
- next_poll_at: timestamp with time zone NULL
- is_watched: boolean NOT NULL DEFAULT true
- poll_status: character varying(50) NOT NULL DEFAULT 'IDLE'
- poll_error_count: integer NOT NULL DEFAULT 0
- retry_after_until: timestamp with time zone NULL
- created_at: timestamp with time zone NOT NULL DEFAULT now()
- updated_at: timestamp with time zone NOT NULL DEFAULT now()

Indexes hiện có:
- user_onedrive_sources_pkey PRIMARY KEY (id)
- idx_onedrive_sources_owner (owner_user_id)
- idx_onedrive_sources_item (owner_user_id, item_id)
- idx_onedrive_sources_agent (agent_id)
- idx_onedrive_sources_status (sync_status)
- idx_onedrive_sources_polling (is_watched, sync_status, next_poll_at)
```

#### Bảng `public.agent_shares` (Agent-Level ACL)
```sql
Table "public.agent_shares"
- id: uuid NOT NULL DEFAULT gen_random_uuid() (PK)
- agent_id: uuid NOT NULL (FK -> user_agents.id ON DELETE CASCADE)
- shared_by: uuid NOT NULL (FK -> users.user_id ON DELETE CASCADE)
- share_type: character varying(30) NOT NULL CHECK (share_type IN ('USER', 'DEPARTMENT', 'COMPANY', 'ALL_INTERNAL'))
- target_user_id: uuid NULL (FK -> users.user_id ON DELETE CASCADE)
- target_department: character varying(100) NULL
- target_company_id: character varying(50) NULL (FK -> companies.id ON DELETE CASCADE)
- permission_role: character varying(20) NOT NULL CHECK (permission_role IN ('VIEWER', 'EDITOR'))
- can_clone: boolean NOT NULL DEFAULT true
- can_reshare: boolean NOT NULL DEFAULT false
- status: character varying(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED'))
- expires_at: timestamp with time zone NULL
- created_at: timestamp with time zone NOT NULL DEFAULT now()
- updated_at: timestamp with time zone NOT NULL DEFAULT now()
```

### 3.2. Thay đổi Schema đề xuất (Non-Destructive DDL)

Để hỗ trợ Phương án C mà không phá vỡ dữ liệu và code hiện có:

#### 1. Mở rộng bảng `public.user_onedrive_sources`
Bổ sung các cột xác định Scope và Tenant:
```sql
-- 1. Bổ sung company_id (xác thực theo tenant của chủ sở hữu nguồn)
ALTER TABLE public.user_onedrive_sources 
  ADD COLUMN IF NOT EXISTS company_id character varying(50) REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;

-- 2. Bổ sung source_scope (PERSONAL hoặc SHARED)
ALTER TABLE public.user_onedrive_sources 
  ADD COLUMN IF NOT EXISTS source_scope character varying(30) NOT NULL DEFAULT 'PERSONAL' 
  CHECK (source_scope IN ('PERSONAL', 'SHARED'));

-- 3. Bổ sung cờ chia sẻ và lưu trữ
ALTER TABLE public.user_onedrive_sources 
  ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT false;

ALTER TABLE public.user_onedrive_sources 
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;

-- 4. Bổ sung Index hỗ trợ tìm kiếm nhanh theo Tenant và Scope
CREATE INDEX IF NOT EXISTS idx_onedrive_sources_tenant_scope 
  ON public.user_onedrive_sources (company_id, source_scope, sync_status);
```

#### 2. Tạo bảng liên kết Nhiều - Nhiều: `public.agent_onedrive_source_associations`
Cho phép một nguồn được gắn vào nhiều Agent mà không ghi đè, hỗ trợ gỡ nguồn độc lập:
```sql
CREATE TABLE IF NOT EXISTS public.agent_onedrive_source_associations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES public.user_onedrive_sources(id) ON DELETE CASCADE,
  agent_id character varying(255) NOT NULL, -- Hỗ trợ cả UUID custom agent và mã preset 'excel-data-pro'
  added_by uuid NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  source_role character varying(30) NOT NULL DEFAULT 'PRIMARY' CHECK (source_role IN ('PRIMARY', 'SUPPLEMENTARY', 'REFERENCE')),
  status character varying(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'UNLINKED', 'DISABLED')),
  unlinked_at timestamp with time zone NULL,
  unlinked_by uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT agent_onedrive_source_associations_pkey PRIMARY KEY (id),
  CONSTRAINT uq_active_agent_source UNIQUE (source_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_source_assoc_agent 
  ON public.agent_onedrive_source_associations (agent_id, status);

CREATE INDEX IF NOT EXISTS idx_agent_source_assoc_source 
  ON public.agent_onedrive_source_associations (source_id, status);
```

#### 3. Tạo bảng phân quyền nguồn chuyên biệt: `public.onedrive_source_shares`
Tách biệt hoàn toàn Source ACL với Agent ACL:
```sql
CREATE TABLE IF NOT EXISTS public.onedrive_source_shares (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES public.user_onedrive_sources(id) ON DELETE CASCADE,
  shared_by uuid NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  share_type character varying(30) NOT NULL CHECK (share_type IN ('USER', 'DEPARTMENT', 'COMPANY', 'AGENT_BOUND', 'CROSS_COMPANY')),
  target_user_id uuid NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  target_company_id character varying(50) NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  target_department character varying(100) NULL,
  target_agent_id character varying(255) NULL,
  permission character varying(30) NOT NULL CHECK (permission IN ('READ_SOURCE', 'MANAGE_SOURCE', 'SHARE_SOURCE', 'REVOKE_SOURCE')),
  cross_company_approved_by uuid NULL REFERENCES public.users(user_id) ON DELETE SET NULL,
  cross_company_approval_ref text NULL,
  status character varying(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  expires_at timestamp with time zone NULL,
  revoked_at timestamp with time zone NULL,
  revoked_by uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT onedrive_source_shares_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_source_shares_lookup 
  ON public.onedrive_source_shares (source_id, status, permission);

CREATE INDEX IF NOT EXISTS idx_source_shares_target_user 
  ON public.onedrive_source_shares (target_user_id, status) WHERE target_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_source_shares_target_company 
  ON public.onedrive_source_shares (target_company_id, status) WHERE target_company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_source_shares_agent_bound 
  ON public.onedrive_source_shares (target_agent_id, status) WHERE target_agent_id IS NOT NULL;
```

---

## 4. MA TRẬN PHÂN QUYỀN THỰC TẾ (STL / VTX / SWC)

Áp dụng nguyên tắc cốt lõi: **DENY BY DEFAULT — ALLOW BY EXPLICIT GRANT.**

### 4.1. Ma trận vai trò nội bộ và quyền thao tác trên Nguồn dữ liệu

| Vai trò / Đối tượng | Tạo Personal Source | Đọc Personal Source | Gỡ Personal Source | Chuyển sang Shared Source | Cấp quyền Nội bộ (Cùng Công ty) | Cấp quyền Liên công ty (Cross-Company) | Đọc Shared Source | Quản lý/Sync Shared Source | Thu hồi Shared Source |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Owner (Chủ nguồn)** | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ Cần Admin duyệt | ✅ | ✅ | ✅ |
| **Admin Công ty (STL/VTX/SWC)** | ✅ | ✅ (Của mình) | ✅ (Của mình) | ✅ | ✅ | ✅ (Ký duyệt) | ✅ (Nếu được cấp/toàn cty) | ✅ (Phạm vi cty) | ✅ (Phạm vi cty) |
| **HR Công ty** | ✅ | ✅ (Của mình) | ✅ (Của mình) | ⚠️ Cần duyệt | ❌ | ❌ | ✅ (Nếu được cấp) | ❌ | ❌ |
| **Agent Editor** | ✅ | ✅ (Của mình) | ⚠️ Chỉ trên Agent | ❌ | ❌ | ❌ | ✅ (Nếu có `READ_SOURCE`) | ⚠️ Chỉ khi có `MANAGE_SOURCE` | ❌ |
| **Agent Viewer** | ✅ | ✅ (Của mình) | ❌ | ❌ | ❌ | ❌ | ✅ (Nếu có `READ_SOURCE`) | ❌ | ❌ |
| **Guest / Anonymous** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

### 4.2. Ma trận ranh giới dữ liệu liên công ty (Cross-Company Boundary Matrix)

| Người dùng thao tác | Nguồn dữ liệu STL | Nguồn dữ liệu VTX | Nguồn dữ liệu SWC | Điều kiện ngoại lệ truy cập chéo |
| :--- | :---: | :---: | :---: | :--- |
| **Nhân sự STL** (`hr_stl`, `emp_stl`, `admin_stl`) | **CHO PHÉP** (Theo ACL) | **CHẶN MẶC ĐỊNH (DENY)** | **CHẶN MẶC ĐỊNH (DENY)** | Phải có bản ghi `onedrive_source_shares` loại `CROSS_COMPANY`, được Admin VTX/SWC phê duyệt và có hạn sử dụng. |
| **Nhân sự VTX** (`hr_vtx`, `emp_vtx`, `admin_vtx`) | **CHẶN MẶC ĐỊNH (DENY)** | **CHO PHÉP** (Theo ACL) | **CHẶN MẶC ĐỊNH (DENY)** | Phải có bản ghi `onedrive_source_shares` loại `CROSS_COMPANY`, được Admin STL/SWC phê duyệt và có hạn sử dụng. |
| **Nhân sự SWC** (`hr_swc`, `emp_swc`, `admin_swc`) | **CHẶN MẶC ĐỊNH (DENY)** | **CHẶN MẶC ĐỊNH (DENY)** | **CHO PHÉP** (Theo ACL) | Phải có bản ghi `onedrive_source_shares` loại `CROSS_COMPANY`, được Admin STL/VTX phê duyệt và có hạn sử dụng. |
| **Superadmin Hệ thống** | Xem Metadata | Xem Metadata | Xem Metadata | Chỉ truy cập nội dung khi có tác vụ kiểm toán khẩn cấp được xác nhận. |

> [!CAUTION]
> **Quy tắc bảo mật bắt buộc:**
> - Việc một Agent được chia sẻ chéo công ty (ví dụ `emp_vtx` chia sẻ Agent cho `emp_swc` qua `agent_shares`) **TUYỆT ĐỐI KHÔNG TỰ ĐỘNG CẤP QUYỀN TRUY CẬP NGUỒN DỮ LIỆU ONEDRIVE CỦA VTX CHO SWC**.
> - Người dùng SWC khi dùng Agent này sẽ chỉ dùng được nguồn cá nhân của chính mình, HOẶC nguồn của VTX nếu nguồn đó có bản ghi phê duyệt `CROSS_COMPANY` rõ ràng trong `onedrive_source_shares`.

---

## 5. CÁC LỖ HỔNG BẢO MẬT VÀ RỦI RO ĐÃ ĐƯỢC PHÁT HIỆN

| Mã định danh | Tên lỗ hổng / Rủi ro | Mức độ | Cơ chế phát sinh | Hậu quả thực tế |
| :---: | :--- | :---: | :--- | :--- |
| **VULN-01** | **Confused Deputy in Agent Sharing (Owner Blindness)** | **HIGH** | `getConnectedSourcesForAgent` lọc cứng theo `owner_user_id = req.user.user_id`. | Người dùng được chia sẻ Agent hợp pháp bị tước quyền đọc tri thức tệp mà chủ sở hữu đã gắn vào Agent. Ngược lại, nếu bỏ điều kiện này mà không có ACL, sẽ gây rò rỉ dữ liệu cá nhân cho mọi Viewer. |
| **VULN-02** | **RBAC Bypass / False 403 on Import** | **HIGH** | `POST /sources/import` chỉ kiểm tra `user_agents.user_id = caller` mà bỏ qua `agent_shares`. | Thành viên hợp pháp trong nhóm không thể liên kết tệp dữ liệu cá nhân vào Agent được chia sẻ để phục vụ công việc. |
| **VULN-03** | **Destructive Disconnect Cascade** | **HIGH** | `disconnectOAuth()` gán `agent_id = NULL` và `active_snapshot_id = NULL` đồng loạt khi ngắt kết nối. | Khi một nhân sự ngắt kết nối tài khoản, toàn bộ Agent đang dùng nguồn đó bị mất dữ liệu vĩnh viễn dù các bản chụp snapshot trên đĩa vẫn còn nguyên. |
| **VULN-04** | **Single Association Overwrite** | **MEDIUM** | Cột `agent_id` duy nhất trên `user_onedrive_sources`. | Khi người dùng muốn tái sử dụng một bảng giá chung cho nhiều Agent chuyên biệt, Agent sau sẽ cướp quyền liên kết của Agent trước. |
| **VULN-05** | **UI Status Spoofing / Misrepresentation** | **MEDIUM** | Frontend hiển thị badge xanh "OneDrive [Đã nối]" chỉ cần token OAuth tồn tại. | Người dùng bị đánh lừa thị giác rằng Agent đã sẵn sàng dữ liệu, dẫn đến khiếu nại lỗi sai lệch khi bot không trả lời được giá. |
| **VULN-06** | **Telemetry Inversion** | **LOW** | Modal hiển thị trạng thái `primary_worker.lastRunStatus` chung của hệ thống. | Tạo ra thông tin mâu thuẫn: Hệ thống báo đồng bộ thành công nhưng số tệp cập nhật của user lại bằng 0. |
| **VULN-07** | **Audit Log Foreign Key Failure** | **LOW** | Truyền mã Agent có tiền tố `custom_` vào cột UUID của bảng `agent_audit_logs`. | Các hành vi chia sẻ và truy xuất Agent bị lỗi ghi log ngầm, làm mất dấu vết kiểm toán an ninh. |

---

## 6. CÁC API VÀ SERVICE CẦN ĐIỀU CHỈNH

### 6.1. Backend Services (`auth-service/services/`)

#### 1. `oneDriveSourceService.js`
- **Hàm `getConnectedSourcesForAgent({ userId, companyId, agentId, conversationId })`:**
  - Viết lại câu truy vấn: Kết hợp Nguồn cá nhân (`source_scope = 'PERSONAL' AND owner_user_id = $userId`) VÀ Nguồn dùng chung (`source_scope = 'SHARED'`) thông qua bảng phân quyền `onedrive_source_shares` và bảng liên kết `agent_onedrive_source_associations`.
  - Thực hiện lọc loại trùng và kiểm tra tính hợp lệ của snapshot (`status = 'PUBLISHED'`).
- **Hàm `importSourceFromDriveItem` & `registerOrUpdateSource`:**
  - Bổ sung tham số `sourceScope` (`PERSONAL` hoặc `SHARED`).
  - Gán tự động `company_id` từ hồ sơ người dùng đăng nhập.
  - Tạo bản ghi liên kết trong `agent_onedrive_source_associations` thay vì chỉ ghi đè cột `agent_id`.
- **Hàm `disconnectSource`:**
  - Sửa lại: Chỉ chuyển trạng thái liên kết trong `agent_onedrive_source_associations` thành `UNLINKED`. Không xóa snapshot, không làm ảnh hưởng các Agent khác đang dùng chung nguồn này.

#### 2. `oneDriveService.js`
- **Hàm `disconnectOAuth(userId)`:**
  - Sửa thành **Non-Destructive**: Chỉ cập nhật `sync_status = 'DISCONNECTED'`, giữ nguyên `active_snapshot_id`, bảo tồn liên kết trong `agent_onedrive_source_associations`.
  - Đánh dấu trạng thái cảnh báo Stale / Offline để bot vẫn đọc được bản chụp nội bộ khi cần đối soát lịch sử.
- **Cơ chế Reconnect OAuth:**
  - Khi người dùng liên kết lại, tự động đối soát `item_id` và khôi phục trạng thái nguồn cũ sang `SYNCED` mà không tạo thêm bản ghi trùng lặp.

#### 3. `toolRegistry.js`
- Bổ sung kiểm tra Source ACL trước khi thực thi công cụ `search_spreadsheet_data` và `calculate_spreadsheet_metrics`.
- Chặn đứng mọi hành vi đọc trộm tệp giữa các công ty STL / VTX / SWC ở tầng runtime tool execution.

### 6.2. Backend Routes (`auth-service/routes/`)

#### 1. `routes/onedrive.js`
- **`POST /api/onedrive/sources/import`:**
  - Kiểm tra quyền: Người dùng phải là Owner của Agent HOẶC có quyền `EDITOR`/`VIEWER` trong `agent_shares`.
  - Nếu import dạng `SHARED`: Kiểm tra quyền `SHARE_SOURCE` hoặc quyền Admin của công ty.
- **`GET /api/onedrive/sources`:**
  - Trả về danh sách nguồn kèm các thuộc tính mở rộng: `source_scope`, `company_id`, `owner_username`, `permissions: ['READ', 'MANAGE']`.
- **`GET /api/onedrive/sync-status`:**
  - Tách bạch telemetry: Trả về trạng thái đồng bộ của các tệp thuộc quyền user, tách riêng với trạng thái tiến trình nền của hệ thống.
- **Bổ sung các endpoints mới phục vụ Quản lý chia sẻ nguồn:**
  - `POST /api/onedrive/sources/:id/share`: Cấp quyền đọc/quản lý nguồn cho User, Phòng ban, Công ty hoặc Agent.
  - `POST /api/onedrive/sources/:id/revoke`: Thu hồi quyền chia sẻ nguồn.
  - `GET /api/onedrive/sources/:id/shares`: Xem danh sách các quyền đã cấp cho nguồn.

#### 2. `routes/agents.js`
- **`ensureAgentSourcesFreshness`:**
  - Gọi hàm `getConnectedSourcesForAgent` phiên bản Hybrid.
  - Đưa thông tin nguồn gốc dữ liệu vào Prompt Context (`[NGUỒN DỮ LIỆU CÁ NHÂN]` vs `[NGUỒN DỮ LIỆU DOANH NGHIỆP DÙNG CHUNG]`).

### 6.3. Frontend Client (`chat/index.html`)

1. **Header Badge Agent (`updateOneDriveHeaderUI`):**
   - Phân biệt rõ 3 trạng thái độc lập:
     - 🔴 Chưa kết nối Microsoft: `[🔗 Kết nối OneDrive]`.
     - 🟡 Đã kết nối tài khoản nhưng Agent chưa có tệp: `[OneDrive: Chưa chọn tệp ⚠️]`.
     - 🟢 Đã có tệp dữ liệu hoạt động: `[OneDrive: Pricing Vendor.xlsx (v51) ✓]`.
2. **File Picker Modal (`openOneDriveFilePickerModal`):**
   - Tự động mở hoặc hiển thị lời nhắc trực quan ngay sau khi xác thực OAuth thành công.
   - Bổ sung tùy chọn khi liên kết: *"Liên kết cho riêng tôi"* (Personal) hoặc *"Chia sẻ cho các thành viên của Agent"* (Shared).
3. **OneDrive Management Modal (`renderOneDriveSourcesList`):**
   - Chia 2 tab hoặc 2 khu vực rõ ràng: **Nguồn cá nhân của bạn** và **Nguồn dùng chung được chia sẻ**.
   - Hiển thị chính xác thời gian đồng bộ của từng tệp, không mượn trạng thái của daemon hệ thống.

---

## 7. TÁC ĐỘNG ĐẾN DỮ LIỆU HIỆN CÓ (DATA IMPACT ANALYSIS)

Bảng đối chiếu hiện trạng và phương án bảo vệ toàn vẹn dữ liệu:

| Đối tượng dữ liệu | Hiện trạng trong DB | Rủi ro nếu thao tác sai | Phương án xử lý bảo vệ an toàn |
| :--- | :--- | :--- | :--- |
| **Source VTX (`Pricing Vendor.xlsx`)** | ID: `90c8fad8...`, Owner: `emp_vtx`, Version: **v51**, Status: `SYNCED`. | Bị chuyển quyền sở hữu nhầm hoặc bị ghi đè snapshot. | **TUYỆT ĐỐI BẢO VỆ NGUYÊN VẸN.** Giữ nguyên Owner `emp_vtx`, gán `company_id = 'VTX'`, `source_scope = 'PERSONAL'`. Tạo bản ghi liên kết vào `b6a784da...`. |
| **Snapshot v51** | ID: `e8fb6c58...`, 51.031 bytes, 8 sheets, chứa 2 dòng mới STT 12 & 13. | Bị xóa hoặc bị nạp đè bởi parser lỗi. | **BẢO TỒN NGUYÊN TRẠNG.** Làm mốc chuẩn tham chiếu cho toàn bộ các bài kiểm thử hồi quy. |
| **17 Sources cũ của `emp_stl`** | 17 bản ghi `Pricing Vendor.xlsx` ở trạng thái `DISCONNECTED`, `active_snapshot_id = NULL`. | Bị xóa nhầm hoặc kích hoạt đồng bộ ồ ạt gây xung đột. | Đánh dấu `company_id = 'STL'`, `source_scope = 'PERSONAL'`, chuyển vào trạng thái lưu trữ kiểm toán `is_archived = true`. Không khôi phục tự động hàng loạt. |
| **Tài khoản OAuth `hr_stl`** | Token hợp lệ đến `09:54:21` (03/11/2026), chưa có source nào. | Bị ngắt kết nối hoặc mất token. | Giữ nguyên. Cung cấp quy trình File Picker chuẩn xác để `hr_stl` chủ động nạp nguồn dữ liệu hợp lệ cho mình. |
| **148 Snapshots lịch sử** | Nằm trong `onedrive_source_snapshots`. | Bị DROP CASCADE nếu đụng vào bảng cha. | Giữ nguyên 100%. Mọi DDL mới chỉ mở rộng thêm bảng và cột, không DROP/TRUNCATE. |

---

## 8. KẾ HOẠCH MIGRATION (MIGRATION PLAN)

Quá trình di chuyển dữ liệu được thực hiện theo nguyên tắc **Zero Downtime & Zero Data Loss**:

### Bước 1: Sao lưu toàn diện (Pre-Migration Backup)
- Tạo bản dump PostgreSQL toàn bộ schema `hrbot` trước khi chạy DDL:
  `docker exec hrbot-postgres-1 pg_dump -U hrbot -d hrbot -F c -b -v -f /var/lib/postgresql/data/backup_pre_hybrid_migration.dump`
- Sao lưu các tệp mã nguồn sẽ chỉnh sửa (`agents.js`, `onedrive.js`, `oneDriveSourceService.js`, `oneDriveService.js`, `index.html`).

### Bước 2: Chạy DDL mở rộng Schema
- Thực thi script `sql/migrations/20261103_hybrid_onedrive_schema.sql` (chứa các câu lệnh `ADD COLUMN IF NOT EXISTS` và `CREATE TABLE IF NOT EXISTS` đã nêu ở Mục 3.2).
- Tạo index hỗ trợ truy vấn hiệu năng cao.

### Bước 3: Data Backfill (Điền dữ liệu lịch sử an toàn)
```sql
-- 1. Cập nhật company_id cho tất cả các source hiện hữu từ bảng users
UPDATE public.user_onedrive_sources s
SET company_id = u.company_id
FROM public.users u
WHERE s.owner_user_id = u.user_id AND s.company_id IS NULL;

-- 2. Gán mặc định source_scope = 'PERSONAL' cho toàn bộ nguồn hiện có
UPDATE public.user_onedrive_sources
SET source_scope = 'PERSONAL'
WHERE source_scope IS NULL;

-- 3. Di chuyển liên kết agent_id hiện hữu sang bảng agent_onedrive_source_associations
INSERT INTO public.agent_onedrive_source_associations (source_id, agent_id, added_by, source_role, status)
SELECT s.id, s.agent_id, s.owner_user_id, 'PRIMARY', 'ACTIVE'
FROM public.user_onedrive_sources s
WHERE s.agent_id IS NOT NULL AND s.agent_id != ''
ON CONFLICT (source_id, agent_id) DO NOTHING;

-- 4. Đánh dấu lưu trữ các bản ghi duplicate cũ của emp_stl
UPDATE public.user_onedrive_sources
SET is_archived = true
WHERE owner_user_id = 'f2b6606e-3125-409c-b5f9-d3ed82282c26' AND sync_status = 'DISCONNECTED';
```

### Bước 4: Kiểm tra tính toàn vẹn sau Migration
- Kiểm tra số lượng bản ghi: 18 sources không đổi.
- Kiểm tra bản ghi liên kết mới: Bản ghi của `emp_vtx` (`90c8fad8...`) được liên kết thành công vào `b6a784da...`.
- Xác minh không có bản ghi nào bị gán sai `company_id`.

---

## 9. KẾ HOẠCH ROLLBACK (ROLLBACK PLAN)

Nếu xảy ra sự cố trong quá trình nâng cấp, quy trình khôi phục nguyên trạng được chuẩn bị sẵn:

### Trường hợp 1: Rollback tầng Ứng dụng (Application Code Rollback)
- Khôi phục lại các file code JavaScript gốc từ bản backup.
- Do schema mới có tính tương thích ngược hoàn toàn (các cột cũ như `agent_id`, `owner_user_id` vẫn tồn tại và giữ nguyên dữ liệu), ứng dụng cũ vẫn hoạt động bình thường trên schema mở rộng mà không bị lỗi.

### Trường hợp 2: Rollback tầng Cơ sở dữ liệu (Database Schema Rollback)
Nếu cần đưa Database về đúng trạng thái ban đầu:
```sql
-- 1. Xóa các bảng mới tạo
DROP TABLE IF EXISTS public.onedrive_source_shares CASCADE;
DROP TABLE IF EXISTS public.agent_onedrive_source_associations CASCADE;

-- 2. Xóa các cột đã thêm vào user_onedrive_sources
ALTER TABLE public.user_onedrive_sources DROP COLUMN IF EXISTS is_archived;
ALTER TABLE public.user_onedrive_sources DROP COLUMN IF EXISTS is_shared;
ALTER TABLE public.user_onedrive_sources DROP COLUMN IF EXISTS source_scope;
ALTER TABLE public.user_onedrive_sources DROP COLUMN IF EXISTS company_id;
```

### Trường hợp 3: Khôi phục thảm họa (Disaster Recovery)
- Khôi phục toàn bộ từ file dump:
  `docker exec hrbot-postgres-1 pg_restore -U hrbot -d hrbot --clean --if-exists /var/lib/postgresql/data/backup_pre_hybrid_migration.dump`

---

## 10. DANH SÁCH TEST CASES (TEST MATRIX)

Ma trận kiểm thử xác minh toàn diện gồm 24 test cases chuyên biệt:

### Nhóm 1: Kiểm thử Quyền Nguồn Cá nhân (Personal Source Tests)
- **TC-PERS-01:** Chủ sở hữu (Owner) truy vấn và đọc dữ liệu nguồn cá nhân của chính mình trên Agent đã liên kết ➔ **Kỳ vọng: PASS (200 OK, trả đúng số liệu)**.
- **TC-PERS-02:** Người dùng B (khác user) cố tình gọi API đọc nguồn cá nhân của User A bằng cách truyền `source_id` ➔ **Kỳ vọng: PASS (404 / 403 Forbidden)**.
- **TC-PERS-03:** User A gỡ nguồn cá nhân khỏi Agent 1 nhưng vẫn giữ nguồn trên Agent 2 ➔ **Kỳ vọng: PASS (Agent 1 không đọc được, Agent 2 vẫn đọc bình thường)**.
- **TC-PERS-04:** User A ngắt kết nối OAuth ➔ **Kỳ vọng: PASS (Nguồn chuyển sang DISCONNECTED, liên kết Agent không bị xóa trắng, snapshot cũ vẫn bảo tồn)**.

### Nhóm 2: Kiểm thử Quyền Nguồn Dùng chung (Shared Source Tests)
- **TC-SHAR-01:** Chủ sở hữu chuyển đổi nguồn sang `SHARED` và cấp quyền `READ_SOURCE` cho Agent X.
- **TC-SHAR-02:** User B có quyền `VIEWER` trên Agent X hỏi về số liệu trong nguồn dùng chung ➔ **Kỳ vọng: PASS (AI trả lời đúng dữ liệu từ snapshot)**.
- **TC-SHAR-03:** User B có quyền `VIEWER` trên Agent X thử gọi API xóa hoặc đồng bộ nguồn dùng chung ➔ **Kỳ vọng: PASS (Bị từ chối 403 Forbidden do thiếu `MANAGE_SOURCE`)**.
- **TC-SHAR-04:** User C có quyền `EDITOR` trên Agent X nhưng chỉ được cấp `READ_SOURCE` (không có `MANAGE_SOURCE`) thử gỡ nguồn khỏi Agent ➔ **Kỳ vọng: PASS (Bị từ chối 403)**.
- **TC-SHAR-05:** Chủ sở hữu thu hồi quyền chia sẻ (`REVOKE_SOURCE`) ➔ **Kỳ vọng: PASS (User B ngay lập tức không thể truy xuất dữ liệu trong các câu hỏi tiếp theo, cache bị vô hiệu hóa ngay)**.

### Nhóm 3: Kiểm thử Ranh giới Công ty STL / VTX / SWC (Multi-Company Boundary Tests)
- **TC-COMP-01:** Nhân sự STL truy xuất nguồn Shared của STL ➔ **Kỳ vọng: PASS**.
- **TC-COMP-02:** Nhân sự STL truy xuất nguồn của VTX (chưa có ủy quyền) ➔ **Kỳ vọng: PASS (Bị chặn DENY BY DEFAULT, không rò rỉ prompt hay tool context)**.
- **TC-COMP-03:** Nhân sự VTX truy xuất nguồn của SWC (chưa có ủy quyền) ➔ **Kỳ vọng: PASS (Bị chặn DENY BY DEFAULT)**.
- **TC-COMP-04:** Nhân sự SWC truy xuất nguồn của STL (chưa có ủy quyền) ➔ **Kỳ vọng: PASS (Bị chặn DENY BY DEFAULT)**.
- **TC-COMP-05:** Admin STL cố gắng quản lý/sửa nguồn dữ liệu thuộc quyền sở hữu của VTX ➔ **Kỳ vọng: PASS (Bị từ chối 403)**.
- **TC-COMP-06:** Tạo bản ghi ủy quyền liên công ty (`CROSS_COMPANY`) có phê duyệt của Admin VTX cho nhân sự STL đọc bảng giá VTX ➔ **Kỳ vọng: PASS (Nhân sự STL đọc được đúng phạm vi ủy quyền)**.

### Nhóm 4: Kiểm thử Tham chiếu Thực tế với `Pricing Vendor.xlsx`
- **TC-DATA-01:** Đối soát tuyến *Thái Hà ➔ Lô B2 WHA Nghệ An* trên snapshot v51:
  - Giá Cost: **`9.500.000 VNĐ`**
  - Loại cont: **`Cont 20' (đi đơn)`**
  - Mặt hàng: **`Axit hydrofluoric (HF) - DG Class 8`**
  - Phụ phí: **`Lạch Huyện + 450.000/cont`**
  - Mã REF: **`43_RUB_FCL`**
  ➔ **Kỳ vọng: AI trích xuất chính xác 100%, không suy đoán, không hallucination**.

### Nhóm 5: Kiểm thử Sửa các Lỗi tồn đọng (Bug Verification Tests)
- **TC-BUG-01:** Kiểm tra Header badge khi tài khoản Microsoft kết nối nhưng chưa có tệp ➔ **Kỳ vọng: Hiển thị màu cam "OneDrive: Chưa chọn tệp ⚠️", không hiển thị xanh**.
- **TC-BUG-02:** Kiểm tra Modal quản lý OneDrive ➔ **Kỳ vọng: Hiển thị đúng số tệp cá nhân của user, không lấy `primary_worker.lastRunStatus` làm trạng thái cá nhân**.
- **TC-BUG-03:** Kiểm tra API `POST /sources/import` khi user được chia sẻ Agent qua `agent_shares` ➔ **Kỳ vọng: Không bị lỗi 403 sai, cho phép liên kết tệp hợp lệ**.
- **TC-BUG-04:** Kiểm tra ghi log `agent_audit_logs` với Agent ID có tiền tố `custom_` ➔ **Kỳ vọng: Sanitize UUID chuẩn xác, ghi log thành công, không vi phạm Foreign Key**.

---

## 11. CÁC VẤN ĐỀ NGHIỆP VỤ CẦN XIN Ý KIẾN PHÊ DUYỆT (DECISION POINTS)

Trước khi tiến hành viết code và chạy migration ở Giai đoạn 1, kính trình xin ý kiến quyết định của Người quản trị / Stakeholder về 4 điểm nghiệp vụ sau:

### Quyết định 1: Chính sách mặc định khi Viewer sử dụng Agent có Shared Source
- **Lựa chọn A (Đề xuất):** Khi một Agent được chia sẻ công khai trong phòng ban hoặc công ty, mọi tệp được đánh dấu `SHARED` gắn với Agent đó mặc định cho phép các thành viên có quyền `VIEWER` trên Agent được phép **ĐỌC DỮ LIỆU** (`READ_SOURCE`), trừ khi chủ nguồn chủ động loại trừ user cụ thể.
- **Lựa chọn B (Khắt khe hơn):** Chia sẻ Agent và chia sẻ Nguồn là 2 thao tác hoàn toàn riêng biệt. Chia sẻ Agent chỉ cho phép nói chuyện với Bot; muốn Bot đọc được file Excel thì chủ nguồn phải bấm chia sẻ tệp thêm một lần nữa cho từng người.

### Quyết định 2: Quyền liên kết tệp của người có vai trò Editor trên Agent
- **Lựa chọn A (Đề xuất):** Editor của Agent được quyền liên kết **tệp cá nhân của chính mình** vào Agent để phục vụ công việc của mình; nhưng không được quyền gỡ hoặc chỉnh sửa các tệp Shared do người khác sở hữu (trừ khi được cấp `MANAGE_SOURCE`).
- **Lựa chọn B:** Chỉ duy nhất Owner của Agent mới có quyền thêm/bớt tệp dữ liệu vào Agent.

### Quyết định 3: Xử lý 17 bản ghi nguồn cũ bị DISCONNECTED của `emp_stl`
- **Lựa chọn A (Đề xuất):** Đánh dấu lưu trữ kiểm toán (`is_archived = true`), giữ nguyên trạng thái `DISCONNECTED`. Người dùng `emp_stl` hoặc `hr_stl` khi muốn sử dụng sẽ vào File Picker để liên kết lại một bản ghi sạch duy nhất (tránh duplicate 17 bản ghi như trước).
- **Lựa chọn B:** Chọn lọc bản ghi mới nhất (v43) để khôi phục tự động về `SYNCED`.

### Quyết định 4: Cơ chế chia sẻ bảng giá liên công ty (STL ↔ VTX ↔ SWC)
- **Lựa chọn A (Đề xuất):** Chỉ cho phép chia sẻ nguồn liên công ty khi có sự chấp thuận rõ ràng của Admin công ty sở hữu tệp (xác nhận qua giao diện hoặc nhập mã phê duyệt).
- **Lựa chọn B:** Cho phép bất kỳ chủ sở hữu tệp nào cũng có thể chia sẻ tệp cho đồng nghiệp ở công ty thành viên khác trong tập đoàn SOTRANS.

---

**KẾT THÚC BÁO CÁO GIAI ĐOẠN 0.**  
*Hệ thống đang dừng lại ở trạng thái READ-ONLY tuyệt đối. Kính đề nghị Người quản trị xem xét báo cáo và phê duyệt kiến trúc đề xuất cùng các quyết định nghiệp vụ trước khi triển khai Giai đoạn 1.*
