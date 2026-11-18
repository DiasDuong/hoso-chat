# SOTRANS HUB — BÁO CÁO HOÀN THIỆN ĐIỀU KIỆN VÀ KỊCH BẢN THỰC THI DBA (REVISION 3)
## PHASE 1.4 DBA EXECUTION SCRIPT SAFETY CORRECTION & LEAST PRIVILEGE SPECIFICATION
**Dự án:** SOTRANS Hub — BI Reporting System  
**Workspace:** `D:\hoso-chat`  
**Ngày thực hiện:** 15/11/2026  
**Môi trường áp dụng:** Staging (`sotrans_staging` trên PostgreSQL 16.15)  
**Trạng thái kiểm thử hệ thống:** **148 / 148 PASS (100%)** *(Giữ nguyên, không sửa code)*  
**Phương án phân quyền đã chốt:** **COLUMN-LEVEL ACCESS CONTROL** (Cấp quyền theo cột trên bảng `public.*`)  
**Kết luận:** **READY FOR DBA REVIEW — NON-DESTRUCTIVE EXECUTION SCRIPT**

---

## 1. QUYẾT ĐỊNH KIẾN TRÚC & PHƯƠNG ÁN PHÂN QUYỀN

Sau khi đối soát toàn bộ mã nguồn của [`auth-service/services/analyticsEngine.js`](file:///D:/hoso-chat/auth-service/services/analyticsEngine.js):
- 100% các câu truy vấn SQL nghiệp vụ (14 câu truy vấn thực thi 14 KPI hoạt động) đều tham chiếu trực tiếp đến các bảng trong schema `public`: `public.documents`, `public.hr_intake_batches`, `public.hr_employee_staging`, `public.users`, `public.auth_audit_logs`, `public.chat_log`.
- **Chốt phương án phân quyền:** Áp dụng **COLUMN-LEVEL ACCESS CONTROL** trực tiếp trên các bảng `public.*`.
- **Lý do kỹ thuật:**
  1. Bảo đảm tương thích tuyệt đối 100% với mã nguồn hiện tại của Analytics Engine mà không cần chỉnh sửa bất kỳ ký tự SQL nào trong ứng dụng.
  2. Áp dụng ngay nguyên tắc đặc quyền tối thiểu (Principle of Least Privilege), bảo vệ toàn diện các trường dữ liệu định danh cá nhân (PII), thông tin lương và bí mật nhân sự.
  3. Phương án **Secure Views (`bi_reporting.v_*`)** được chuyển thành kiến trúc nâng cấp dài hạn (Phase 2 Roadmap) khi hệ thống xây dựng Data Warehouse độc lập.

---

## 2. KỊCH BẢN SQL CHÍNH THỨC DÀNH CHO DBA (NON-DESTRUCTIVE EXECUTION SCRIPT)

Kịch bản dưới đây được thiết kế theo chuẩn an toàn tối đa: **Tuyệt đối không sử dụng `REASSIGN OWNED` hay `DROP OWNED` tự động**. Mọi trạng thái bất thường về Object Ownership hoặc Role Membership đều được xử lý bằng cơ chế **Pre-flight Inspection & ABORT / STOP**, yêu cầu DBA rà soát thủ công nhằm tránh làm thay đổi cấu trúc của các dịch vụ khác trên Staging.

```sql
-- ============================================================================
-- SOTRANS HUB: OFFICIAL DBA LEAST-PRIVILEGE SCRIPT (POSTGRESQL 16.15)
-- Target Database: sotrans_staging (Port 5433)
-- Target Role: staging_readonly
-- Execution Mode: Non-Destructive / Least Privilege / Column-Level Access Control
-- ============================================================================

\connect sotrans_staging

-- ----------------------------------------------------------------------------
-- GIAI ĐOẠN 1: PRE-FLIGHT CHECK 1 — KIỂM TRA OBJECT OWNERSHIP & ABORT NẾU CÓ
-- (TUYỆT ĐỐI KHÔNG DÙNG REASSIGN OWNED HOẶC DROP OWNED TỰ ĐỘNG)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_count INT := 0;
  v_details TEXT := '';
  r RECORD;
BEGIN
  -- 1.1. Kiểm tra role staging_readonly có đang sở hữu table, view, sequence, routine, schema không
  FOR r IN (
    SELECT 'table' AS obj_type, n.nspname || '.' || c.relname AS obj_name
    FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    JOIN pg_roles r ON c.relowner = r.oid
    WHERE r.rolname = 'staging_readonly' AND c.relkind IN ('r', 'p')
    UNION ALL
    SELECT 'view' AS obj_type, n.nspname || '.' || c.relname AS obj_name
    FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    JOIN pg_roles r ON c.relowner = r.oid
    WHERE r.rolname = 'staging_readonly' AND c.relkind IN ('v', 'm')
    UNION ALL
    SELECT 'sequence' AS obj_type, n.nspname || '.' || c.relname AS obj_name
    FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    JOIN pg_roles r ON c.relowner = r.oid
    WHERE r.relname = 'staging_readonly' AND c.relkind = 'S'
    UNION ALL
    SELECT 'routine' AS obj_type, n.nspname || '.' || p.proname AS obj_name
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    JOIN pg_roles r ON p.proowner = r.oid
    WHERE r.rolname = 'staging_readonly'
    UNION ALL
    SELECT 'schema' AS obj_type, nspname AS obj_name
    FROM pg_namespace n
    JOIN pg_roles r ON n.nspowner = r.oid
    WHERE r.rolname = 'staging_readonly'
    UNION ALL
    SELECT 'database' AS obj_type, datname AS obj_name
    FROM pg_database d
    JOIN pg_roles r ON d.datdba = r.oid
    WHERE r.rolname = 'staging_readonly'
    UNION ALL
    SELECT 'tablespace' AS obj_type, spcname AS obj_name
    FROM pg_tablespace t
    JOIN pg_roles r ON t.spcowner = r.oid
    WHERE r.rolname = 'staging_readonly'
  ) LOOP
    v_count := v_count + 1;
    v_details := v_details || format(E'\n  - [%s]: %s', r.obj_type, r.obj_name);
  END LOOP;

  IF v_count > 0 THEN
    RAISE EXCEPTION E'[STOP / ABORT EXECUTION] An toàn bị vi phạm: Role staging_readonly đang sở hữu % đối tượng CSDL:% \nYêu cầu DBA kiểm tra nguồn gốc và xử lý thủ công. Tuyệt đối không tự động chuyển owner hay drop object!', v_count, v_details;
  ELSE
    RAISE NOTICE '[PRE-FLIGHT 1 PASSED] Role staging_readonly không sở hữu bất kỳ database object nào.';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- GIAI ĐOẠN 2: PRE-FLIGHT CHECK 2 — KIỂM TRA ROLE MEMBERSHIP HAI CHIỀU & ABORT
-- (TUYỆT ĐỐI KHÔNG TỰ ĐỘNG THU HỒI HÀNG LOẠT NẾU CHƯA ĐƯỢC DBA PHÊ DUYỆT)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_member_count INT := 0;
  v_details TEXT := '';
  r RECORD;
BEGIN
  -- 2.1. Chiều 1: staging_readonly được gán vào group role khác (nhận quyền từ group)
  FOR r IN (
    SELECT 
      b.rolname AS group_role, 
      m.admin_option, 
      m.inherit_option, 
      m.set_option
    FROM pg_auth_members m
    JOIN pg_roles r ON m.member = r.oid
    JOIN pg_roles b ON m.roleid = b.oid
    WHERE r.rolname = 'staging_readonly'
  ) LOOP
    v_member_count := v_member_count + 1;
    v_details := v_details || format(E'\n  - [Thành viên của]: %s (ADMIN=%s, INHERIT=%s, SET=%s)', r.group_role, r.admin_option, r.inherit_option, r.set_option);
  END LOOP;

  -- 2.2. Chiều 2: Các role khác được gán vào staging_readonly
  FOR r IN (
    SELECT 
      r.rolname AS member_role, 
      m.admin_option, 
      m.inherit_option, 
      m.set_option
    FROM pg_auth_members m
    JOIN pg_roles r ON m.member = r.oid
    JOIN pg_roles b ON m.roleid = b.oid
    WHERE b.rolname = 'staging_readonly'
  ) LOOP
    v_member_count := v_member_count + 1;
    v_details := v_details || format(E'\n  - [Role khác nhận staging_readonly]: %s (ADMIN=%s, INHERIT=%s, SET=%s)', r.member_role, r.admin_option, r.inherit_option, r.set_option);
  END LOOP;

  IF v_member_count > 0 THEN
    RAISE EXCEPTION E'[STOP / ABORT EXECUTION] Phát hiện % quan hệ Role Membership liên quan đến staging_readonly:% \nYêu cầu DBA rà soát và gỡ bỏ membership thủ công trước khi tiếp tục!', v_member_count, v_details;
  ELSE
    RAISE NOTICE '[PRE-FLIGHT 2 PASSED] Role staging_readonly hoàn toàn độc lập, không có membership liên đới.';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- GIAI ĐOẠN 3: TẠO MỚI HOẶC CHUẨN HÓA ĐẦY ĐỦ THUỘC TÍNH BẢO VỆ CỦA ROLE
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_old_super BOOLEAN;
  v_old_bypass BOOLEAN;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'staging_readonly') THEN
    CREATE ROLE staging_readonly WITH 
      LOGIN 
      NOSUPERUSER 
      NOCREATEDB 
      NOCREATEROLE 
      NOINHERIT 
      NOREPLICATION 
      NOBYPASSRLS 
      CONNECTION LIMIT 20 
      PASSWORD '<SECURE_PASSWORD_PROVIDED_BY_DBA>';
    RAISE NOTICE '[ROLE CREATED] Role staging_readonly được tạo mới với đầy đủ 8 thuộc tính an toàn.';
  ELSE
    -- Hiển thị cảnh báo nếu role cũ có thuộc tính nguy hiểm trước khi chuẩn hóa
    SELECT rolsuper, rolbypassrls INTO v_old_super, v_old_bypass FROM pg_roles WHERE rolname = 'staging_readonly';
    IF v_old_super OR v_old_bypass THEN
      RAISE WARNING '[SECURITY ALERT] Role staging_readonly trước đó có SUPERUSER=% hoặc BYPASSRLS=%. Tiến hành thu hồi ngay.', v_old_super, v_old_bypass;
    END IF;

    ALTER ROLE staging_readonly WITH 
      LOGIN 
      NOSUPERUSER 
      NOCREATEDB 
      NOCREATEROLE 
      NOINHERIT 
      NOREPLICATION 
      NOBYPASSRLS 
      CONNECTION LIMIT 20;
    RAISE NOTICE '[ROLE NORMALIZED] Thuộc tính của staging_readonly đã được chuẩn hóa.';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- GIAI ĐOẠN 4: THU HỒI SẠCH QUYỀN CŨ TRÊN SCHEMA PUBLIC (PURGE BEFORE GRANT)
-- (Lưu ý: Lệnh này thu hồi cả table và column privileges cũ để reset sạch sẽ)
-- ----------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM staging_readonly;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM staging_readonly;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM staging_readonly;
REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM staging_readonly;
REVOKE ALL ON SCHEMA public FROM staging_readonly;
REVOKE ALL ON DATABASE sotrans_staging FROM staging_readonly;

-- ----------------------------------------------------------------------------
-- GIAI ĐOẠN 5: CẤP QUYỀN TRUY CẬP HẠ TẦNG TỐI THIỂU
-- ----------------------------------------------------------------------------
-- 5.1. Chỉ cấp CONNECT trên database (Tuyệt đối không cấp CREATE hay TEMPORARY)
GRANT CONNECT ON DATABASE sotrans_staging TO staging_readonly;

-- 5.2. Chỉ cấp USAGE trên schema public (Tuyệt đối không cấp CREATE)
GRANT USAGE ON SCHEMA public TO staging_readonly;

-- ----------------------------------------------------------------------------
-- GIAI ĐOẠN 6: CẤP QUYỀN SELECT THEO TỪNG CỘT (EXACT 38 COLUMNS MATRIX)
-- ----------------------------------------------------------------------------

-- 6.1. Bảng public.documents (KPI 1, 2, 3, 4, 14: Đúng 9 cột)
GRANT SELECT (
  doc_version_id, 
  status, 
  effective_date, 
  expiry_date, 
  deleted_at, 
  branch_scope, 
  doc_type, 
  category, 
  parse_quality
) ON public.documents TO staging_readonly;

-- 6.2. Bảng public.hr_intake_batches (KPI 5, 6, 7, 8: Đúng 6 cột)
GRANT SELECT (
  id, 
  company_id, 
  status, 
  total_files, 
  uploaded_by, 
  created_at
) ON public.hr_intake_batches TO staging_readonly;

-- 6.3. Bảng public.hr_employee_staging (KPI 8, 11, 13, 15: Đúng 10 cột)
GRANT SELECT (
  id, 
  batch_id, 
  company_id, 
  staging_status, 
  suspected_duplicate, 
  missing_fields, 
  uncertain_fields, 
  created_at, 
  approved_at, 
  reviewed_at
) ON public.hr_employee_staging TO staging_readonly;

-- 6.4. Bảng public.users (KPI 16: Đúng 4 cột)
GRANT SELECT (
  user_id, 
  role, 
  company_id, 
  status
) ON public.users TO staging_readonly;

-- 6.5. Bảng public.auth_audit_logs (KPI 16: Đúng 4 cột)
GRANT SELECT (
  id, 
  actor_user_id, 
  action, 
  created_at
) ON public.auth_audit_logs TO staging_readonly;

-- 6.6. Bảng public.chat_log (KPI 17: Đúng 5 cột)
GRANT SELECT (
  id, 
  company_id, 
  answerable, 
  best_sim, 
  at
) ON public.chat_log TO staging_readonly;

-- ----------------------------------------------------------------------------
-- GIAI ĐOẠN 7: KHÓA HAI BẢNG NGOÀI PHẠM VI (ZERO PRIVILEGE)
-- ----------------------------------------------------------------------------
REVOKE ALL ON public.companies FROM staging_readonly;
REVOKE ALL ON public.document_relationships FROM staging_readonly;

-- ============================================================================
-- KẾT THÚC KỊCH BẢN THỰC THI DBA
-- ============================================================================
```

---

## 3. LÀM RÕ CƠ CHẾ VÀ RỦI RO CỦA `ALTER DEFAULT PRIVILEGES`

> [!WARNING]
> **PHÂN TÍCH CHUYÊN SÂU POSTGRESQL VỀ QUYỀN MẶC ĐỊNH (DEFAULT PRIVILEGES):**
> 
> Tuyệt đối không ngộ nhận rằng câu lệnh:
> ```sql
> ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM staging_readonly;
> ```
> có thể tự động khóa mọi quyền phát sinh trên tất cả các bảng tạo mới trong tương lai.

### A. Bản chất kỹ thuật của `ALTER DEFAULT PRIVILEGES`:
1. **Áp dụng theo Creator Role (`FOR ROLE <creator>`):**
   - Trong PostgreSQL, default privileges luôn gắn liền với **role sẽ thực thi lệnh tạo bảng (`CREATE TABLE`) trong tương lai**.
   - Nếu chạy `ALTER DEFAULT PRIVILEGES ...` mà không có mệnh đề `FOR ROLE`, PostgreSQL chỉ áp dụng quyền đó cho các đối tượng do **chính user đang chạy script này** (ví dụ `staging_admin`) tạo ra.
   - Nếu trong tương lai, một role khác (ví dụ: `hrbot`, migration tool, hoặc superuser khác) tạo bảng mới trong schema `public`, các bảng đó sẽ tuân theo default privileges của role tạo ra chúng chứ không bị chặn bởi lệnh của `staging_admin`.
2. **Phạm vi Global vs Schema-level:**
   - Default privileges có 2 phạm vi: **Global cấp database** (không có `IN SCHEMA`) và **Schema cấp schema** (`IN SCHEMA public`).
   - Lệnh `REVOKE` ở cấp Schema không tự động vô hiệu hóa hay ghi đè các thiết lập `GRANT` đã được định nghĩa ở cấp Global nếu trước đó đã được cấu hình.
3. **Quy tắc an toàn:**
   - **Không tự động chạy `ALTER DEFAULT PRIVILEGES FOR ROLE ...` trên các role khác** nếu chưa có sự đánh giá và phê duyệt bằng văn bản từ DBA.
   - Bất kỳ bảng nghiệp vụ mới nào được bổ sung trong tương lai đều phải trải qua quy trình cấp quyền tường minh (Explicit Grant), không phụ thuộc vào quyền tự động.

### B. Truy vấn kiểm tra cấu hình Default Privileges thực tế (`pg_default_acl`):
```sql
SELECT 
  r.rolname AS target_creator_role,
  COALESCE(n.nspname, '* GLOBAL (ALL SCHEMAS) *') AS target_schema,
  CASE a.defaclobjtype
    WHEN 'r' THEN 'TABLE'
    WHEN 'S' THEN 'SEQUENCE'
    WHEN 'f' THEN 'FUNCTION/ROUTINE'
    WHEN 'T' THEN 'TYPE'
    WHEN 's' THEN 'SCHEMA'
  END AS object_type,
  a.defaclacl AS configured_acl
FROM pg_default_acl a
JOIN pg_roles r ON a.defaclrole = r.oid
LEFT JOIN pg_namespace n ON a.defaclnamespace = n.oid
WHERE a.defaclacl::text LIKE '%staging_readonly%';
```
*Kỳ vọng:* Không có cấu hình default privilege nào tự động cấp quyền `SELECT` toàn bảng cho `staging_readonly`.

---

## 4. KIỂM SOÁT VÀ ĐÁNH GIÁ QUYỀN EXECUTE CỦA `PUBLIC` TRÊN CÁC ROUTINE

> [!CAUTION]
> **NGUYÊN TẮC BẢO TOÀN VẬN HÀNH:**
> Tuyệt đối không thực thi lệnh thu hồi hàng loạt:
> `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;`
> Việc thu hồi tự động này có thể làm tê liệt toàn bộ các dịch vụ nghiệp vụ hiện hành (trigger tự động, hàm băm mật khẩu, hàm tạo UUID, toán tử pgvector, các hàm tiện ích của hệ thống HRBot).
> 
> Thay vào đó, DBA thực hiện quy trình kiểm kê và đánh giá rủi ro theo từng routine (Surgical Assessment).

### A. Truy vấn kiểm kê toàn bộ Functions / Routines trong schema `public`:
```sql
SELECT 
  p.proname AS routine_name,
  pg_get_userbyid(p.proowner) AS routine_owner,
  CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END AS execution_security,
  p.proconfig AS custom_search_path,
  has_function_privilege('staging_readonly', p.oid, 'EXECUTE') AS readonly_can_execute,
  has_function_privilege('PUBLIC', p.oid, 'EXECUTE') AS public_can_execute,
  -- Đánh dấu hàm có thể đọc dữ liệu PII hoặc mật khẩu qua mã nguồn
  CASE 
    WHEN pg_get_functiondef(p.oid) ~* '(citizen_id|base_salary|password_hash|phone_number|email|question|reply|file_uri)' 
    THEN 'POTENTIAL_PII_LEAK_RISK'
    ELSE 'SAFE_ROUTINE'
  END AS pii_risk_classification
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
ORDER BY p.prosecdef DESC, pii_risk_classification DESC, p.proname ASC;
```

### B. Tiêu chí phân tích rủi ro routine dành cho DBA:
1. **Routines loại `SECURITY DEFINER`:**
   - Routine chạy dưới quyền của `routine_owner` (thường là superuser hoặc table owner).
   - *Rủi ro:* Nếu `staging_readonly` được phép thực thi (`EXECUTE`) một hàm `SECURITY DEFINER` mà hàm đó truy vấn các cột PII (`citizen_id`, `password_hash`...), tài khoản Read-Only có thể gián tiếp đọc được dữ liệu nhạy cảm dù không có quyền trực tiếp trên bảng.
   - *Kiểm tra Search Path:* Kiểm tra cột `custom_search_path` (`proconfig`). Nếu hàm `SECURITY DEFINER` không cố định `search_path = pg_catalog, public`, hàm đó có nguy cơ bị tấn công Trojan Search Path.
2. **Routines loại `SECURITY INVOKER`:**
   - Routine chạy dưới quyền của chính người gọi (`staging_readonly`).
   - Do `staging_readonly` đã bị chặn 100% trên các cột PII, các hàm này khi chạy sẽ bị PostgreSQL từ chối (`permission denied`) nếu cố truy cập dữ liệu nhạy cảm. Do đó, các hàm `SECURITY INVOKER` hoàn toàn an toàn.
3. **Đề xuất xử lý của DBA:**
   - Nếu phát hiện hàm `SECURITY DEFINER` có khả năng xuất dữ liệu PII: Chỉ thu hồi `EXECUTE` cụ thể trên hàm đó đối với `staging_readonly` hoặc `PUBLIC`:
     ```sql
     REVOKE EXECUTE ON FUNCTION public.<hazardous_function_name> FROM staging_readonly;
     REVOKE EXECUTE ON FUNCTION public.<hazardous_function_name> FROM PUBLIC;
     ```

---

## 5. MA TRẬN QUYỀN VÀ BỘ KIỂM TRA PHI PHÁ HOẠI (EFFECTIVE PRIVILEGES MATRIX)

Phương án phân quyền **Column-Level Grants trên 38 cột** được giữ nguyên hoàn toàn. Sau khi chạy script tại Mục 2, DBA thực thi bộ truy vấn kiểm chứng phi phá hoại dưới đây:

### A. Ma trận 38 cột được phép truy vấn:

| Bảng CSDL | 38 Cột Được Phép Truy Vấn (Exact Columns) | Mệnh Đề Tham Gia Trong SQL Engine |
|:---|:---|:---|
| **`public.documents`** *(9 cột)* | `doc_version_id`, `status`, `effective_date`, `expiry_date`, `deleted_at`, `branch_scope`, `doc_type`, `category`, `parse_quality` | `SELECT`, `WHERE`, `GROUP BY`, `ORDER BY` |
| **`public.hr_intake_batches`** *(6 cột)* | `id`, `company_id`, `status`, `total_files`, `uploaded_by`, `created_at` | `SELECT`, `WHERE`, `GROUP BY`, `ORDER BY`, CTE |
| **`public.hr_employee_staging`** *(10 cột)* | `id`, `batch_id`, `company_id`, `staging_status`, `suspected_duplicate`, `missing_fields`, `uncertain_fields`, `created_at`, `approved_at`, `reviewed_at` | `SELECT`, `JOIN`, `WHERE`, `GROUP BY`, Subqueries |
| **`public.users`** *(4 cột)* | `user_id`, `role`, `company_id`, `status` | `JOIN`, `WHERE`, `SELECT`, `GROUP BY` |
| **`public.auth_audit_logs`** *(4 cột)* | `id`, `actor_user_id`, `action`, `created_at` | `SELECT`, `JOIN`, `WHERE`, `GROUP BY`, `ORDER BY` |
| **`public.chat_log`** *(5 cột)* | `id`, `company_id`, `answerable`, `best_sim`, `at` | `SELECT`, `WHERE` |

---

### B. Danh mục dữ liệu PII và bảng bị CẤM TUYỆT ĐỐI:

```
+====================================================================================================+
|                               DANH MỤC DỮ LIỆU BỊ CẤM TRUY CẬP (ACCESS DENIED)                     |
+====================================================================================================+
| 1. BẢNG hr_employee_staging (CẤM 100% CÁC CỘT PII VÀ BÍ MẬT NHÂN SỰ):                                |
|    - citizen_id                  : Số Căn cước công dân / CMND (High Risk PII)                     |
|    - full_name, date_of_birth    : Họ tên, ngày sinh nhân sự / ứng viên tuyển dụng                 |
|    - gender, phone_number, email : Giới tính, số điện thoại, email cá nhân                         |
|    - base_salary                 : Mức lương thỏa thuận (Bí mật tiền lương / Confidential)         |
|    - permanent_address           : Địa chỉ thường trú / Nơi ở riêng tư                             |
|    - recruitment_decision_no    : Số quyết định tuyển dụng cá nhân                                |
|    - extracted_data              : Toàn bộ JSON OCR bóc tách nhân thân                             |
|    - proposed_changes            : Đề xuất sửa đổi dữ liệu hồ sơ                                   |
|    - file_storage_path          : Đường dẫn tệp chứa ảnh scan CCCD và hồ sơ gốc                   |
|                                                                                                    |
| 2. BẢNG users (CẤM THÔNG TIN XÁC THỰC VÀ PII):                                                     |
|    - password_hash               : Mật khẩu băm Bcrypt (Critical Security Credential)               |
|    - failed_login_attempts       : Số lần đăng nhập sai (Dữ liệu kiểm soát an ninh)                |
|    - locked_until                : Thời điểm khóa tài khoản                                        |
|    - email, full_name, phone     : PII thông tin liên lạc người dùng                               |
|                                                                                                    |
| 3. BẢNG chat_log (CẤM NỘI DUNG VĂN BẢN TRÒ CHUYỆN):                                                |
|    - question, rewritten         : Nội dung câu hỏi gốc của nhân viên (Có thể chứa PII/Bí mật)     |
|    - reply, content              : Toàn bộ câu trả lời chi tiết của trợ lý AI                      |
|    - user_id, username, session_id: Danh tính và phiên trò chuyện cá nhân                           |
|                                                                                                    |
| 4. BẢNG auth_audit_logs (CẤM DỮ LIỆU HẠ TẦNG MẠNG):                                                |
|    - ip_address                  : Địa chỉ IP máy trạm (Network Infrastructure Data)                |
|    - metadata, user_agent        : Dấu vân tay trình duyệt và chi tiết thiết bị                    |
|                                                                                                    |
| 5. BẢNG documents (CẤM ĐƯỜNG DẪN FILE VÀ NỘI DUNG VĂN BẢN):                                         |
|    - file_uri, file_sha256       : Đường dẫn lưu trữ máy chủ vật lý và mã băm                      |
|    - deletion_reason, reject_reason: Thông tin giải trình nội bộ về lý do hủy/từ chối              |
|    - raw_text, search_vector     : Toàn bộ nội dung văn bản văn phòng                              |
|                                                                                                    |
| 6. HAI BẢNG NGOÀI PHẠM VI (ZERO PRIVILEGE - CẤM TOÀN BỘ BẢNG):                                     |
|    - public.companies            : CẤM (Không có câu truy vấn SQL nào sử dụng)                     |
|    - public.document_relationships: CẤM (KPI 12 bị BLOCKED, trả tĩnh trong bộ nhớ)                |
+====================================================================================================+
```

---

### C. Bộ truy vấn kiểm chứng phi phá hoại (Non-Destructive Audit Queries):

```sql
SELECT
  -- NHÓM 1: KIỂM TRA ĐỦ 8 CỘT ĐẠI DIỆN ĐƯỢC PHÉP TRUY CẬP (TẤT CẢ PHẢI LÀ TRUE)
  has_column_privilege('staging_readonly', 'public.documents', 'doc_version_id', 'SELECT') AS allow_doc_version_id,
  has_column_privilege('staging_readonly', 'public.documents', 'branch_scope', 'SELECT') AS allow_branch_scope,
  has_column_privilege('staging_readonly', 'public.hr_intake_batches', 'company_id', 'SELECT') AS allow_intake_company_id,
  has_column_privilege('staging_readonly', 'public.hr_employee_staging', 'id', 'SELECT') AS allow_staging_id,
  has_column_privilege('staging_readonly', 'public.hr_employee_staging', 'staging_status', 'SELECT') AS allow_staging_status,
  has_column_privilege('staging_readonly', 'public.users', 'role', 'SELECT') AS allow_user_role,
  has_column_privilege('staging_readonly', 'public.auth_audit_logs', 'action', 'SELECT') AS allow_audit_action,
  has_column_privilege('staging_readonly', 'public.chat_log', 'best_sim', 'SELECT') AS allow_chat_best_sim,

  -- NHÓM 2: KIỂM TRA CHẶN TOÀN DIỆN CÁC CỘT PII VÀ BÍ MẬT (TẤT CẢ PHẢI LÀ FALSE)
  has_column_privilege('staging_readonly', 'public.hr_employee_staging', 'citizen_id', 'SELECT') AS block_pii_citizen_id,
  has_column_privilege('staging_readonly', 'public.hr_employee_staging', 'base_salary', 'SELECT') AS block_confidential_salary,
  has_column_privilege('staging_readonly', 'public.hr_employee_staging', 'full_name', 'SELECT') AS block_pii_fullname,
  has_column_privilege('staging_readonly', 'public.hr_employee_staging', 'phone_number', 'SELECT') AS block_pii_phone,
  has_column_privilege('staging_readonly', 'public.hr_employee_staging', 'email', 'SELECT') AS block_pii_email,
  has_column_privilege('staging_readonly', 'public.hr_employee_staging', 'file_storage_path', 'SELECT') AS block_storage_path,
  has_column_privilege('staging_readonly', 'public.users', 'password_hash', 'SELECT') AS block_credential_password,
  has_column_privilege('staging_readonly', 'public.chat_log', 'question', 'SELECT') AS block_pii_question,
  has_column_privilege('staging_readonly', 'public.chat_log', 'reply', 'SELECT') AS block_pii_reply,
  has_column_privilege('staging_readonly', 'public.auth_audit_logs', 'ip_address', 'SELECT') AS block_network_ip,
  has_column_privilege('staging_readonly', 'public.documents', 'file_uri', 'SELECT') AS block_documents_file_uri,

  -- NHÓM 3: KIỂM TRA CHẶN HAI BẢNG NGOÀI PHẠM VI (TẤT CẢ PHẢI LÀ FALSE)
  has_table_privilege('staging_readonly', 'public.companies', 'SELECT') AS block_table_companies,
  has_table_privilege('staging_readonly', 'public.document_relationships', 'SELECT') AS block_table_doc_rel,

  -- NHÓM 4: KIỂM TRA CHẶN CÁC LỆNH GHI VÀ PHÁ HOẠI (TẤT CẢ PHẢI LÀ FALSE)
  has_table_privilege('staging_readonly', 'public.documents', 'INSERT') AS block_insert_docs,
  has_table_privilege('staging_readonly', 'public.hr_employee_staging', 'UPDATE') AS block_update_staging,
  has_table_privilege('staging_readonly', 'public.chat_log', 'DELETE') AS block_delete_chat,
  has_table_privilege('staging_readonly', 'public.users', 'TRUNCATE') AS block_truncate_users;
```

**Đếm số cột thực tế qua `information_schema.column_privileges`:**
```sql
SELECT table_name, COUNT(column_name) AS granted_columns_count
FROM information_schema.column_privileges 
WHERE grantee = 'staging_readonly' AND privilege_type = 'SELECT'
GROUP BY table_name
ORDER BY table_name;
```
*Kết quả chuẩn: Đúng 38 cột (`documents`: 9, `hr_intake_batches`: 6, `hr_employee_staging`: 10, `users`: 4, `auth_audit_logs`: 4, `chat_log`: 5).*

---

## 6. NGUYÊN TẮC VÀ RANH GIỚI BẢO VỆ CÁCH LY TENANT

> [!IMPORTANT]
> **RANH GIỚI BẢO MẬT BẮT BUỘC:**
> 1. Quyền CSDL Read-Only (`staging_readonly`) là cơ chế bảo vệ ở tầng lưu trữ vật lý nhằm chống phá hoại (chặn ghi) và chống rò rỉ thông tin cá nhân (chặn PII). **Nó không phải và không thể thay thế cơ chế cách ly tenant.**
> 2. Cơ chế cách ly dữ liệu giữa các đơn vị thành viên (`STL`, `VTX`, `SWC`) được đảm bảo 100% bởi **Backend Application Logic** và **Parameterized SQL Binding**:
>    - **ADMIN:** Chỉ được phép chọn trong tập cố định `['STL', 'VTX', 'SWC', 'ALL']`. Nếu thiếu hoặc sai lệch, request bị chặn ngay lập tức với mã lỗi `HTTP 400 Bad Request` và kích hoạt cảnh báo an ninh `SECURITY_TENANT_TAMPERING`.
>    - **HR:** Tham số `options.companyId` từ client bị loại bỏ hoàn toàn, hệ thống cưỡng chế gán `company_id` lấy từ payload JWT đã được ký số của tài khoản đăng nhập.
> 3. Thông tin kết nối CSDL của `staging_readonly` là **thông tin bảo mật nội bộ phía server**; tuyệt đối không đưa thông tin host, port, database, user hay password ra client, giao diện web hay nhật ký ứng dụng.

---

## 7. CÁC BƯỚC CẤU HÌNH ỨNG DỤNG STAGING (DEVOPS RUNBOOK)

### Bước 1: Khai báo biến môi trường cho `auth-staging` trong `docker-compose.staging.yml`
```yaml
services:
  auth-staging:
    image: node:20-alpine
    container_name: sotrans-auth-staging
    environment:
      # Kích hoạt tính năng BI Reporting
      BI_REPORTING_ENABLED: "true"
      # Thông tin kết nối bằng vai trò Read-Only tối thiểu
      PG_HOST: "postgres-staging"
      PG_PORT: "5432"
      PG_DATABASE: "sotrans_staging"
      PG_USER: "staging_readonly"
      PG_PASSWORD: "<SECURE_PASSWORD_PROVIDED_BY_DBA>"
```

### Bước 2: Khởi động lại service `auth-staging`
```powershell
docker compose -f docker-compose.staging.yml restart auth-staging
```

### Bước 3: Xác thực hoạt động Catalog Endpoint
```powershell
# 1. Đăng nhập tài khoản quản trị để lấy Token
$loginBody = @{ username = "admin"; password = "<ADMIN_PASSWORD>" } | ConvertTo-Json
$auth = Invoke-RestMethod -Uri "http://127.0.0.1:3001/api/auth/login" -Method Post -Body $loginBody -ContentType "application/json"

# 2. Gọi Catalog Endpoint kèm Bearer Token
$headers = @{ "Authorization" = "Bearer $($auth.token)" }
$catalog = Invoke-RestMethod -Uri "http://127.0.0.1:3001/api/analytics/catalog" -Method Get -Headers $headers

# 3. In kết quả kiểm tra
Write-Host "Catalog Endpoint Response Status: SUCCESS"
$catalog | ConvertTo-Json -Depth 3
```

---

## 8. KẾT LUẬN CUỐI CÙNG

$$\mathbf{KẾT\ LUẬN:\ READY\ FOR\ DBA\ REVIEW\ —\ NON-DESTRUCTIVE\ EXECUTION\ SCRIPT}$$

- Kịch bản DBA đã loại bỏ hoàn toàn các thao tác phá hoại tự động (`REASSIGN OWNED`, `DROP OWNED`, bulk revoke).
- Thay thế bằng cơ chế **Pre-flight Check 1 (Ownership)** và **Pre-flight Check 2 (Bidirectional Membership)** kèm điều kiện `ABORT / STOP` minh bạch nếu có bất thường.
- Chuẩn hóa đầy đủ 8 thuộc tính an toàn của PostgreSQL 16: `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION`, `NOBYPASSRLS`, `CONNECTION LIMIT 20`.
- Làm rõ cơ chế và rủi ro của `ALTER DEFAULT PRIVILEGES` và quyền `EXECUTE` của `PUBLIC` trên routines.
- Bảo toàn nguyên vẹn phương án phân quyền Column-Level trên 38 cột, ranh giới bảo vệ PII và cơ chế cô lập tenant.
- Kịch bản đã sẵn sàng để DBA rà soát độc lập và thực thi trên Staging.
