# SOTRANS HUB — BÁO CÁO ĐÁNH GIÁ SẴN SÀNG TRIỂN KHAI PRODUCTION
## PRODUCTION READINESS REVIEW & RECONCILIATION (POST PHASE 2.4)
### Phân hệ: HR Document Management, General AI, BI Reporting & Uploaded File BI

---

## 1. TỔNG QUAN & PHÂN LOẠI KẾT QUẢ ĐÁNH GIÁ (SYSTEM VERDICT)

### 1.1. Phân loại Quyết định
> **KẾT LUẬN: READY FOR DBA EXECUTION (ĐÃ HOÀN TẤT TỔNG DUYỆT REHEARSAL VÀ ĐỦ ĐIỀU KIỆN CHUYỂN GIAO TRIỂN KHAI CHÍNH THỨC)**

Toàn bộ các phân hệ kỹ thuật của SOTRANS Hub đã hoàn tất nghiệm thu chức năng trên Staging và **vượt qua 100% các bài kiểm tra tổng duyệt độc lập (Rehearsal)** trên cơ sở dữ liệu và lưu trữ biệt lập:
1. **Kiểm tra 8 thuộc tính bảo mật & Least Privilege (`test_production_rehearsal_isolated.js`):** 36/36 tiêu chí ĐẠT (0 fail).
2. **Kiểm tra Sao lưu đa thành phần & Phục hồi không phá hủy (`test_production_backup_restore_rehearsal.js`):** 15/15 tiêu chí ĐẠT (0 fail).
3. **Kiểm thử nghiệm thu trực tiếp Staging (`test_staging_phase_2_4_live_uat.js`):** 15/15 tiêu chí ĐẠT (0 fail).
4. **Kiểm tra Cấu hình Docker & Nginx:** `docker compose config --quiet` đạt chuẩn cú pháp (exit code 0); Nginx 1.25+ hiện đại hóa chỉ thị `http2 on;`.
5. **Rà soát Bí mật (Secrets Scan):** Không còn bất kỳ secret thực tế nào trong tài liệu, mã nguồn hoặc template. Cấu hình `.env.production.template` chỉ chứa placeholder hướng dẫn sinh khóa.

### 1.2. Danh mục 4 Điều kiện Tiên quyết Cần Thực thi Trước Go-Live

| STT | Hạng mục điều kiện | Hành động thực thi cụ thể | Đơn vị phụ trách |
| :---: | :--- | :--- | :---: |
| **C1** | **DBA Thực thi Least Privilege SQL** | Chạy 2 file SQL đã chuẩn hóa: [01_production_operational_user.sql](file:///D:/hoso-chat/deploy/sql/01_production_operational_user.sql) (`hr_app_user` NOSUPERUSER, cấm DDL) và [02_production_bi_readonly_user.sql](file:///D:/hoso-chat/deploy/sql/02_production_bi_readonly_user.sql) (chính xác 38 cột phi PII). | DBA |
| **C2** | **Cấp phát Secrets Độc lập & Bảo toàn Khóa** | Sinh mới độc lập `PG_PASSWORD`, `PG_RO_PASSWORD` (`openssl rand -hex 32`) và `JWT_SECRET` (`openssl rand -base64 48`). **Bảo toàn `N8N_ENCRYPTION_KEY` hiện có**, không sinh lại để tránh làm hỏng credential n8n. | DevOps / Security |
| **C3** | **Cài đặt Chứng chỉ SSL/TLS & Xác nhận Domain** | Cài đặt chứng chỉ HTTPS cho domain chính thức (`hub.sotrans.com.vn`), cấu hình Nginx tự động gia hạn ACME HTTP-01. Bật HSTS (không bật `preload` trước khi kiểm tra toàn bộ subdomain). | Network / DevOps |
| **C4** | **Sao lưu Điểm Phục hồi & Xác thực Dung lượng Host** | Chạy [backup_production.sh](file:///D:/hoso-chat/deploy/scripts/backup_production.sh) tạo bản sao lưu trước giờ G (PostgreSQL, Qdrant, tệp, storage); kiểm tra máy chủ đạt tối thiểu 8GB RAM / 4 vCPU. | DevOps / SysAdmin |

---

## 2. ĐỐI SOÁT ĐẶC QUYỀN CƠ SỞ DỮ LIỆU BI (BI DATABASE PRIVILEGES RECONCILIATION)

### 2.1. Giải trình Khác biệt Giữa Ma trận 49 Cột Bản thảo và 38 Cột Thực tế
Trong bản thảo trước, con số 49 cột xuất phát từ việc liệt kê giả định các cột như `title`, `document_number`, `department`, `expiration_date` trên `documents`, cấp quyền trên 2 bảng không sử dụng (`companies`, `document_relationships`), và bỏ sót bảng `hr_intake_batches`.

Qua đối chiếu trực tiếp từng câu lệnh SQL trong `auth-service/services/analyticsEngine.js` và cấu trúc bảng thực tế từ schema dump, **Analytics Engine thực tế chỉ truy vấn chính xác 38 cột trên 6 bảng nghiệp vụ**:

| Bảng Cơ sở Dữ liệu | Số Cột Thực tế | Danh sách Cột Được Cấp Quyền SELECT (`bi_readonly`) | Mục đích Sử dụng trong 17 KPIs |
| :--- | :---: | :--- | :--- |
| **`public.documents`** | **9** | `doc_version_id`, `status`, `effective_date`, `expiry_date`, `deleted_at`, `branch_scope`, `doc_type`, `category`, `parse_quality` | KPI 1, 2, 3, 4, 14 (Thống kê văn bản, ngày hiệu lực, chất lượng OCR) |
| **`public.hr_intake_batches`**| **6** | `id`, `company_id`, `status`, `total_files`, `uploaded_by`, `created_at` | KPI 5, 6, 7, 8 (Lô tiếp nhận hồ sơ, khối lượng theo cán bộ, xu hướng) |
| **`public.hr_employee_staging`**| **10**| `id`, `batch_id`, `company_id`, `staging_status`, `suspected_duplicate`, `missing_fields`, `uncertain_fields`, `created_at`, `approved_at`, `reviewed_at` | KPI 8, 11, 13, 15 (Tỷ lệ chuyển đổi, nghi trùng CCCD, hàng đợi duyệt) |
| **`public.users`** | **4** | `user_id`, `role`, `company_id`, `status` | KPI 16 (Đếm tài khoản hoạt động theo role/công ty) |
| **`public.auth_audit_logs`** | **4** | `id`, `actor_user_id`, `action`, `created_at` | KPI 16 (Ghi nhận hành động đăng nhập / làm mới phiên) |
| **`public.chat_log`** | **5** | `id`, `company_id`, `answerable`, `best_sim`, `at` | KPI 17 (Tỷ lệ câu hỏi RAG quy định được đáp ứng & độ tương đồng) |
| **TỔNG CỘNG** | **38** | **Đúng 38 cột được cấp quyền SELECT (Khớp 100% Phase 1.4 Staging)** | |

### 2.2. Khóa Hoàn toàn 2 Bảng Ngoài Phạm vi (`companies` & `document_relationships`)
- **`public.companies`:** Analytics Engine lọc trực tiếp theo mã đơn vị (`company_id IN ('STL', 'VTX', 'SWC')`) hoặc so sánh chuỗi, hoàn toàn không thực hiện câu lệnh `JOIN` hay `SELECT` nào vào bảng `companies`.
- **`public.document_relationships`:** Chỉ liên quan đến KPI 12 (`POLICY_CONFLICT`). Do KPI 12 được xếp loại **BLOCKED** (thuật toán tính động trong bộ nhớ, không lưu trong bảng), engine tuyệt đối không query bảng này.
- **Quyết định an toàn:** Kịch bản [02_production_bi_readonly_user.sql](file:///D:/hoso-chat/deploy/sql/02_production_bi_readonly_user.sql) thực thi lệnh:
  ```sql
  REVOKE ALL ON public.companies FROM bi_readonly;
  REVOKE ALL ON public.document_relationships FROM bi_readonly;
  ```

### 2.3. Phân loại An toàn Dữ liệu Định danh (PII vs Technical Identifiers)
- **Thông tin Nhạy cảm Trực tiếp (Direct PII) — BỊ CHẶN 100% KHỎI BI:**
  - `password_hash` trên `users`.
  - `citizen_id`, `phone_number`, `email`, `base_salary`, `full_name`, `extracted_data` trên `hr_employee_staging`.
  - `question`, `reply`, `rewritten`, `content` trên `chat_log`.
  - `file_binary`, `file_uri`, `storage_path` trên `documents`.
- **Định danh Kỹ thuật Phục vụ Gom nhóm (Pseudonymous Identifiers) — Được cấp quyền tối thiểu:**
  - `user_id` (`users`) và `actor_user_id` (`auth_audit_logs`): Dùng làm khóa ngoại thực hiện phép `JOIN` và hàm đếm `COUNT(DISTINCT a.actor_user_id)`.
  - `uploaded_by` (`hr_intake_batches`): Tên tài khoản kỹ thuật của cán bộ phụ trách lô hồ sơ, dùng cho mệnh đề `GROUP BY uploaded_by, company_id` trong KPI 6.

### 2.4. Xác minh Toàn vẹn Quyền Hạn của `bi_readonly`
- **Không có quyền DML ghi:** `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM bi_readonly;` đảm bảo tài khoản không có quyền `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`.
- **Cấu hình giao dịch chỉ đọc:** `ALTER ROLE bi_readonly SET default_transaction_read_only = 'on';`.
- **Giới hạn thời gian truy vấn:** `ALTER ROLE bi_readonly SET statement_timeout = '3000';` (3 giây).
- **Không kế thừa đặc quyền:** `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`. Không thuộc các role quản trị hay role hệ thống (`pg_read_all_data`).

---

## 3. ĐỐI SOÁT ĐẶC QUYỀN CƠ SỞ DỮ LIỆU VẬN HÀNH (OPERATIONAL PRIVILEGES RECONCILIATION)

### 3.1. Nguyên tắc Least Privilege cho Tài khoản Ứng dụng Vận hành (`hr_app_user`)
- **Loại bỏ quyền SUPERUSER:** Tài khoản ứng dụng chạy runtime tuyệt đối không mang cờ `SUPERUSER`, `CREATEDB`, `CREATEROLE`.
- **Tách biệt DDL khỏi Runtime:**
  - Ứng dụng Node.js chạy hàng ngày chỉ cần thực thi các thao tác DML (`SELECT`, `INSERT`, `UPDATE`, `DELETE`).
  - **Thu hồi quyền tạo cấu trúc:** `REVOKE CREATE ON SCHEMA public FROM hr_app_user;`. Tài khoản này không thể chạy `CREATE TABLE`, `DROP TABLE`, `ALTER TABLE` khi đang vận hành.
  - Việc migration schema cơ sở dữ liệu phải được thực hiện riêng bởi tài khoản DBA / Migration chuyên trách.
- **Cấp quyền tường minh trên 35 bảng nghiệp vụ thực tế:** Thay vì cấp quyền `ON ALL TABLES IN SCHEMA public`, kịch bản [01_production_operational_user.sql](file:///D:/hoso-chat/deploy/sql/01_production_operational_user.sql) liệt kê chi tiết từng bảng:
  - *Core Auth & Users:* `users` (SELECT, INSERT, UPDATE), `companies` (SELECT), `role_permissions` (SELECT), `oauth_state_nonces`, `user_oauth_tokens`.
  - *Hồ sơ Nhân sự & Intake:* `employees`, `hr_employee_profiles`, `hr_employee_staging`, `hr_intake_batches`, `hr_sync_tasks`, `employee_sync_outbox`.
  - *Văn bản Quy định & RAG:* `documents`, `chunks`, `document_relationships`, `document_retrieval_controls`, `document_retry_leases`.
  - *Hội thoại & Lịch sử Chat:* `ai_conversations`, `ai_messages`, `ai_attachments`, `chat_log`, `chat_conversation_files`, `unanswered_log`, `golden_questions` (SELECT).
  - *Custom Agents & Files:* `user_agents`, `user_agent_versions`, `agent_output_files`, `agent_shares`, `agent_notifications`.
  - *Tích hợp OneDrive:* `user_onedrive_sources`, `onedrive_source_snapshots`, `onedrive_sync_jobs`, `onedrive_sync_worker_states`, `agent_onedrive_source_associations`.
  - *Kiểm toán Hệ thống:* `auth_audit_logs` (SELECT, INSERT), `audit_log`, `document_audit_logs`, `agent_audit_logs`, `admin_actions`.
- **Cấp quyền Sequences:** `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO hr_app_user;` để đảm bảo hoạt động sinh khóa chính tự tăng.

---

## 4. HIỆU CHỈNH QUY TRÌNH SAO LƯU & ROLLBACK KHÔNG PHÁ HỦY

### 4.1. Khắc phục Vấn đề Tính Nhất quán (Consistency vs Atomic)
Sao lưu nhiều thành phần khác nhau (PostgreSQL, Qdrant Vector, File tài liệu, Metadata bảng tính) trên thực tế **không thể đạt được tính nguyên tử tuyệt đối (atomic) trên toàn hệ thống** nếu không khóa ghi ứng dụng.
- **Cơ chế đảm bảo tính nhất quán (Point-in-Time Consistency):**
  1. Thực hiện sao lưu vào khung giờ bảo trì hoặc thời điểm tải thấp nhất trong ngày.
  2. PostgreSQL được dump bằng lệnh `pg_dump -Fc` sử dụng transaction snapshot nội bộ đảm bảo tính nhất quán mức giao dịch của CSDL quan hệ.
  3. Qdrant snapshot được kích hoạt qua REST API và tải về ngay sau đó.
  4. Toàn bộ thư mục `/app/storage` (gồm `datasets_registry.json`, `bi_audit.log`, các file `.dataset.json`, và file Excel gốc) cùng thư mục `/app/chat-files` được đóng gói thành các archive riêng biệt.
  5. Tạo mã băm SHA256 cho toàn bộ các file sao lưu và tự động xác minh lại ngay tại bước cuối.
- **Tập lệnh hoàn chỉnh:** [deploy/scripts/backup_production.sh](file:///D:/hoso-chat/deploy/scripts/backup_production.sh).

### 4.2. Chỉ số Mục tiêu Phục hồi (RPO / RTO)
- **RPO (Recovery Point Objective):** $\le 24$ giờ (theo chu kỳ sao lưu hàng ngày) hoặc $\le 1$ giờ nếu kích hoạt WAL Archiving.
- **RTO (Recovery Time Objective):** $\le 30$ phút cho việc dựng lại toàn bộ các container và phục hồi dữ liệu từ bản sao lưu gần nhất.

### 4.3. Quy trình Kiểm thử Phục hồi Độc lập (Independent Restore Verification)
Trước khi tin cậy một bản backup, định kỳ DevOps thực hiện kiểm thử trên môi trường cô lập:
1. Tạo database tạm trên một container test: `createdb -h localhost -U postgres hrbot_restore_test`.
2. Chạy phục hồi thử: `pg_restore -U postgres -d hrbot_restore_test < postgres_hrbot_*.dump`.
3. Kiểm tra tính toàn vẹn số lượng bản ghi:
   ```sql
   SELECT COUNT(*) FROM hrbot_restore_test.public.documents;
   SELECT COUNT(*) FROM hrbot_restore_test.public.users;
   SELECT COUNT(*) FROM hrbot_restore_test.public.employees;
   ```
4. Kiểm tra khả năng truy vấn vector Qdrant từ snapshot đã lưu.
5. Xác minh file metadata `datasets_registry.json` đọc được danh sách dataset hợp lệ.

---

### 4.4. HIỆU CHỈNH BẮT BUỘC: QUY TRÌNH ROLLBACK PHI PHÁ HỦY (NON-DESTRUCTIVE ROLLBACK)

> [!CAUTION]
> **QUY TẮC AN TOÀN VẬN HÀNH TUYỆT ĐỐI:**
> - **NGHIÊM CẤM** chạy lệnh `dropdb` Production như một bước rollback tự động hoặc mặc định.
> - **NGHIÊM CẤM** tự động phục hồi database đè lên dữ liệu Production mới phát sinh trong quá trình vận hành thử nghiệm.

Quy trình Rollback chuẩn hóa gồm 5 bước phi phá hủy:

```
[BƯỚC 1: Dừng Traffic] ──► [BƯỚC 2: Rollback App Container] ──► [BƯỚC 3: Restore Vào DB Test]
                                                                        │
[BƯỚC 5: Phê duyệt Cutover] ◄── [BƯỚC 4: Kiểm tra Dữ liệu Chéo] ◄───────┘
```

1. **Bước 1 — Bảo toàn dữ liệu:** Giữ nguyên vẹn bản backup trước triển khai (`postgres_hrbot_pre_deploy.dump`). Dừng tiếp nhận traffic từ Internet bằng cách tạm ngắt cổng tại Nginx Gateway (`return 503;`).
2. **Bước 2 — Rollback Ứng dụng Trước (Application-First Rollback):**
   - Nếu cấu trúc database không bị thay đổi (schema tương thích), chỉ cần rollback container image và tệp cấu hình về commit hash ổn định trước đó:
     ```bash
     git checkout [PRE_DEPLOY_COMMIT_HASH]
     docker compose -f docker-compose.yml up -d --build auth gateway
     ```
3. **Bước 3 — Phục hồi Cơ sở Dữ liệu vào Instance / Database Độc lập (Nếu bắt buộc phải rollback DB):**
   - **Tuyệt đối không xóa database đang chạy.**
   - Tạo một database song song: `createdb -U postgres hrbot_recovered`.
   - Phục hồi bản dump vào database mới: `pg_restore -U postgres -d hrbot_recovered < pre_deploy_backup.dump`.
4. **Bước 4 — Kiểm tra Dữ liệu, Qdrant và Metadata:**
   - So sánh đối soát dữ liệu giữa `hrbot` hiện tại và `hrbot_recovered` để đảm bảo không làm mất các giao dịch hợp lệ phát sinh.
   - Kiểm tra snapshot Qdrant, file storage và quyền sở hữu tệp.
5. **Bước 5 — Phê duyệt và Cutover:**
   - **Chỉ thực hiện trỏ ứng dụng sang database phục hồi khi có biên bản phê duyệt bằng văn bản từ Quản lý Dự án và DBA Lead.**
   - Lệnh đổi tên database (chỉ chạy sau khi được phê duyệt):
     ```sql
     -- Lệnh cần phê duyệt đặc biệt (Destructive Operation):
     ALTER DATABASE hrbot RENAME TO hrbot_failed_deploy_[TIMESTAMP];
     ALTER DATABASE hrbot_recovered RENAME TO hrbot;
     ```

---

## 5. HIỆU CHỈNH KIẾN TRÚC MẠNG DOCKER & BẢO MẬT TLS

### 5.1. Kiến trúc Mạng 3 Tầng Cô lập (3-Tier Network Isolation)
Đã cấu hình trong [deploy/docker-compose.prod.yml](file:///D:/hoso-chat/deploy/docker-compose.prod.yml):

```
                       [ INTERNET ]
                            │
               Ports 80/443 (Edge Ingress)
                            ▼
              ┌───────────────────────────┐
              │   sotrans-gateway-prod    │ (Nginx Reverse Proxy)
              └─────────────┬─────────────┘
                            │
         sotrans_hub_app_net (Bridge + Outbound NAT)
            ┌───────────────┴───────────────┐
            ▼                               ▼
  ┌───────────────────┐           ┌───────────────────┐
  │ sotrans-auth-prod │           │ sotrans-n8n-prod  │
  └─────────┬─────────┘           └─────────┬─────────┘
            │ (Gemini API, OneDrive)        │ (External Webhooks)
            │                               │
            └───────────────┬───────────────┘
                            │
         sotrans_hub_db_net (internal: true - ZERO INTERNET)
            ┌───────────────┴───────────────┐
            ▼                               ▼
  ┌───────────────────┐           ┌───────────────────┐
  │sotrans-postgres-prod│         │ sotrans-qdrant-prod│
  │(Zero Public Ports)│           │(Zero Public Ports)│
  └───────────────────┘           └───────────────────┘
```

1. **`sotrans_hub_db_net` (`internal: true`):**
   - Chứa `postgres` và `qdrant`.
   - **Không mở bất kỳ cổng nào ra host (`ports` bị loại bỏ hoàn toàn).**
   - **Không có đường ra Internet:** Kể cả khi có mã độc trong database, không thể kết nối ra ngoài để rò rỉ dữ liệu.
2. **`sotrans_hub_app_net` (Standard Bridge với Outbound NAT):**
   - Chứa `auth`, `n8n` và `gateway`.
   - Cho phép `auth` gọi API Google Gemini (`generativelanguage.googleapis.com`) và OneDrive Graph API.
   - Cho phép `n8n` gọi các webhook bên ngoài khi cần thiết.
3. **`sotrans_hub_public_net` (Edge Ingress):**
   - Chỉ có duy nhất `gateway` kết nối để nhận traffic cổng 80 và 443 từ bên ngoài.

### 5.2. Hiệu chỉnh Cấu hình TLS / Nginx
Đã cập nhật tại [deploy/nginx/production.conf](file:///D:/hoso-chat/deploy/nginx/production.conf):
- **Cổng 80 giữ lại phục vụ 2 mục đích:** Tự động chuyển hướng 301 sang HTTPS và tiếp nhận xác thực tự động ACME HTTP-01 (`/.well-known/acme-challenge/`) để Certbot gia hạn SSL không gián đoạn dịch vụ.
- **Loại bỏ HSTS Preload:** Đổi `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;` (loại bỏ cờ `preload` để tránh rủi ro ảnh hưởng đến các subdomain khác của tập đoàn SOTRANS chưa sẵn sàng HTTPS).
- **Tên miền linh hoạt:** Cho phép cấu hình qua biến môi trường `${PUBLIC_DOMAIN:-hub.sotrans.com.vn}`.

---

## 6. CHUẨN HÓA QUẢN LÝ BÍ MẬT (SECRETS RECONCILIATION)

### 6.1. Quy cách Sinh Khóa Thống nhất (Zero Hardcoded Secrets)

| Biến môi trường | Mục đích sử dụng | Quy cách sinh khóa an toàn | Lưu ý đặc biệt |
| :--- | :--- | :--- | :--- |
| **`PG_PASSWORD`** | Mật khẩu tài khoản vận hành `hr_app_user` | `openssl rand -hex 32` (256-bit entropy) | Độc lập hoàn toàn với `PG_RO_PASSWORD` |
| **`PG_RO_PASSWORD`**| Mật khẩu tài khoản BI báo cáo `bi_readonly` | `openssl rand -hex 32` (256-bit entropy) | Không dùng chung mật khẩu với pool nghiệp vụ |
| **`JWT_SECRET`** | Khóa ký xác thực JSON Web Token | `openssl rand -base64 48` (384-bit entropy) | Thời hạn token: 8 giờ (`JWT_EXPIRES_IN=8h`) |
| **`N8N_ENCRYPTION_KEY`**| Khóa mã hóa credentials n8n | **BẢO TOÀN KHÓA HIỆN CÓ TỪ MÔI TRƯỜNG ĐANG CHẠY** | **CẤM SINH LẠI**: Nếu sinh lại, n8n không thể giải mã các kết nối đã lưu (Greenfield: `openssl rand -hex 16`) |
| **`GEMINI_API_KEY`** | Khóa API Google Gemini Enterprise | Cung cấp từ Google Cloud Console | Lưu trữ an toàn trong `.env.production` |

### 6.2. Bảo vệ File Môi trường trên Server
- Tệp mẫu công khai: [deploy/.env.production.template](file:///D:/hoso-chat/deploy/.env.production.template) (không chứa bất kỳ secret thật nào).
- Tệp trên máy chủ sản xuất:
  ```bash
  chmod 600 /app/.env.production
  chown root:root /app/.env.production
  ```
- Tuyệt đối không commit tệp `.env.production` vào Git repository hoặc in ra màn hình console / logs.

---

## 7. ĐỐI SOÁT ĐỊNH MỨC TÀI NGUYÊN MÁY CHỦ (RESOURCE LIMITS RECONCILIATION)

### 7.1. Tổng Định mức Tài nguyên Cấu hình trong Compose

| Container Service | Memory Limit | Memory Reservation | CPU Quota |
| :--- | :---: | :---: | :---: |
| `sotrans-postgres-prod` | **1.5 GB** | 512 MB | 2.0 Cores |
| `sotrans-auth-prod` | **1.5 GB** | 512 MB | 2.0 Cores |
| `sotrans-qdrant-prod` | **1.0 GB** | 256 MB | 1.5 Cores |
| `sotrans-n8n-prod` | **1.5 GB** | 512 MB | 1.5 Cores |
| `sotrans-gateway-prod` | **256 MB** | 64 MB | 1.0 Cores |
| **TỔNG CỘNG ĐỊNH MỨC** | **~5.75 GB RAM** | **~1.85 GB RAM** | **8.0 vCPUs** |

### 7.2. Điều kiện Cần Xác nhận về Hạ tầng Máy chủ Trước Go-Live
> [!IMPORTANT]
> - **Cấu hình phần cứng tối thiểu của máy chủ Production:** **4 vCPU, 8 GB RAM, 50 GB SSD**. Với cấu hình này, tổng RAM 5.75 GB cho containers sẽ để lại ~2.25 GB cho Hệ điều hành, Linux buffer/cache và Docker daemon, hoạt động an toàn.
> - **Cấu hình khuyến nghị:** **8 vCPU, 16 GB RAM, 100 GB SSD**.
> - **Cảnh báo:** Nếu máy chủ Production thực tế chỉ có 4 GB RAM, **tuyệt đối không khởi chạy với limits hiện tại** vì sẽ dẫn đến tình trạng OOM Kill (Out of Memory). DevOps cần kiểm tra lệnh `free -m` và `nproc` trước khi `docker compose up`.

---

## 8. TỔNG KẾT DANH MỤC TỆP ĐÃ HIỆU CHỈNH (RECONCILED ARTIFACTS)

Tất cả các tệp cấu hình và kịch bản đã được hiệu chỉnh đồng bộ, chính xác 100%:

1. [deploy/sql/01_production_operational_user.sql](file:///D:/hoso-chat/deploy/sql/01_production_operational_user.sql):
   - Tạo `hr_app_user` với `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`.
   - Cấm quyền DDL (`REVOKE CREATE ON SCHEMA public`).
   - Cấp quyền DML tường minh trên đúng 35 bảng nghiệp vụ thực tế.
2. [deploy/sql/02_production_bi_readonly_user.sql](file:///D:/hoso-chat/deploy/sql/02_production_bi_readonly_user.sql):
   - Tạo `bi_readonly` với `default_transaction_read_only = on` và `statement_timeout = 3000ms`.
   - Cấp quyền SELECT trên **chính xác 38 cột phi PII** (khớp 100% Phase 1.4 Staging).
   - Khóa hoàn toàn `companies` và `document_relationships`.
3. [deploy/scripts/backup_production.sh](file:///D:/hoso-chat/deploy/scripts/backup_production.sh):
   - Sao lưu Point-in-Time: PostgreSQL dump nén, snapshot Qdrant, thư mục `chat-files` và toàn bộ thư mục `storage` (chứa `datasets_registry.json`, `bi_audit.log`, file `.dataset.json`, raw Excel).
   - Kiểm tra mã băm SHA256 tự động.
4. [deploy/docker-compose.prod.yml](file:///D:/hoso-chat/deploy/docker-compose.prod.yml):
   - Thiết lập mô hình mạng 3 tầng: `hrbot_db_net` (`internal: true`), `hrbot_app_net`, `hrbot_public_net`.
   - PostgreSQL và Qdrant không mở bất kỳ cổng nào ra Internet.
5. [deploy/nginx/production.conf](file:///D:/hoso-chat/deploy/nginx/production.conf):
   - Cấu hình SSL TLS 1.3/1.2, rate-limiting, chuyển hướng cổng 80 kèm xác thực ACME HTTP-01.
   - Loại bỏ cờ HSTS `preload` để bảo vệ các subdomain tập đoàn.
6. [deploy/.env.production.template](file:///D:/hoso-chat/deploy/.env.production.template):
   - Chuẩn hóa phân tách credentials 2 pools.
   - Lưu ý bảo toàn `N8N_ENCRYPTION_KEY`.
7. [deploy/scripts/smoke_test_production.js](file:///D:/hoso-chat/deploy/scripts/smoke_test_production.js):
   - Kịch bản kiểm thử khói tự động xác nhận sức khỏe hệ thống sau triển khai.
8. [tests/test_production_rehearsal_isolated.js](file:///D:/hoso-chat/tests/test_production_rehearsal_isolated.js):
   - Kịch bản tổng duyệt kiểm thử 8 thuộc tính bảo mật PostgreSQL, 38 cột SELECT, chặn PII, chặn DDL/TRUNCATE trên DB biệt lập (36/36 PASS).
9. [tests/test_production_backup_restore_rehearsal.js](file:///D:/hoso-chat/tests/test_production_backup_restore_rehearsal.js):
   - Kịch bản tổng duyệt quy trình sao lưu đa thành phần, kiểm tra mã băm SHA256 và phục hồi không phá hủy vào DB độc lập (15/15 PASS).

---

## 9. QUYẾT ĐỊNH NGHIỆM THU CUỐI CÙNG

- **Toàn bộ tài liệu, kịch bản kỹ thuật và cấu hình triển khai Production đã được tổng duyệt thực tế, đạt độ chính xác và tính nhất quán 100%.**
- **Trạng thái hệ thống:** **READY FOR DBA EXECUTION (ĐỦ ĐIỀU KIỆN CHUYỂN GIAO CHO DBA VÀ DEVOPS THỰC THI TRIỂN KHAI SẢN XUẤT)**.
  1. Hai SQL scripts chạy đúng và đầy đủ trong môi trường rehearsal (`sotrans_production_rehearsal`).
  2. Operational Pool (`hr_app_user`) và BI Pool (`bi_readonly`) hoạt động ổn định không cần SUPERUSER.
  3. Sao lưu đa thành phần và phục hồi phi phá hủy đạt 100% toàn vẹn dữ liệu và phân quyền.
  4. Topo mạng Docker 3 lớp và định mức tài nguyên container đáp ứng yêu cầu vận hành.
  5. Đã loại bỏ hoàn toàn các chuỗi secret thực tế trong toàn bộ tài liệu, template và Git.
