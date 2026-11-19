# KẾ HOẠCH KHÔI PHỤC VÀ HOÀN NGUYÊN HỆ THỐNG SOTRANS HUB
## SOTRANS HUB — MASTER REMEDIATION ROLLBACK PLAN (SRRP-20261029)

> **Tài liệu:** Kế hoạch Khôi phục và Hoàn nguyên Chi tiết theo Từng Đợt SOTRANS Hub  
> **Phiên bản:** 2.0 (Disaster Recovery & Rollback Standard)  
> **Ngày lập:** 29/10/2026  
> **Mục đích:** Cung cấp quy trình hoàn nguyên chuẩn xác từng bước cho từng đợt triển khai, đảm bảo đưa hệ thống về trạng thái ổn định gần nhất trong thời gian ngắn nhất (RTO < 5 phút, RPO = 0).

---

### MỤC LỤC
1. [Nguyên tắc Hoàn nguyên và Ranh giới An toàn](#1-nguyên-tắc-hoàn-nguyên-và-ranh-giới-an-toàn)
2. [Chiến lược Rollback Đợt 1: Bảo mật và Kiểm soát truy cập](#2-chiến-lược-rollback-đợt-1-bảo-mật-và-kiểm-soát-truy-cập)
3. [Chiến lược Rollback Đợt 2: Tính toàn vẹn Dữ liệu và Nghiệp vụ Nhân sự](#3-chiến-lược-rollback-đợt-2-tính-toàn-vẹn-dữ-liệu-và-nghiệp-vụ-nhân-sự)
4. [Chiến lược Rollback Đợt 3: AI Router, Token Quota và OCR](#4-chiến-lược-rollback-đợt-3-ai-router-token-quota-và-ocr)
5. [Chiến lược Rollback Đợt 4: Tích hợp Google SA, OneDrive và n8n](#5-chiến-lược-rollback-đợt-4-tích-hợp-google-sa-onedrive-và-n8n)
6. [Chiến lược Rollback Đợt 5: Hiệu năng, Sao lưu và Giao diện Quản trị](#6-chiến-lược-rollback-đợt-5-hiệu-năng-sao-lưu-và-giao-diện-quản-trị)
7. [Bảng Ma trận Tham số RTO / RPO và Phân công Trách nhiệm](#7-bảng-ma-trận-tham-số-rto--rpo-và-phân-công-trách-nhiệm)

---

### 1. NGUYÊN TẮC HOÀN NGUYÊN VÀ RANH GIỚI AN TOÀN

Mọi đợt triển khai sửa lỗi đều phải tuân thủ 4 nguyên tắc rollback bắt buộc:
1. **Sao lưu trước khi can thiệp (Pre-change Backup):** Bất kỳ thao tác sửa file, sửa cấu hình hoặc chạy lệnh SQL nào đều phải có bản sao lưu trước đó (file `.bak`, file `.sql` hoặc git commit snapshot).
2. **Kịch bản hoàn nguyên có thể đảo ngược 100% (Bidirectional Reversibility):** Mỗi lệnh thay đổi (Forward Migration) bắt buộc phải có lệnh đảo ngược tương ứng (Reverse Migration / Down script).
3. **Không phá hủy dữ liệu trong quá trình rollback (Non-destructive Revert):** Rollback tuyệt đối không được làm mất thêm dữ liệu của người dùng hay làm sập thêm dịch vụ khác.
4. **Xác minh độc lập sau rollback (Post-revert Verification):** Sau khi hoàn nguyên, phải chạy lại bộ kiểm tra healthcheck và kịch bản acceptance để khẳng định hệ thống đã trở về đúng trạng thái ban đầu.

---

### 2. CHIẾN LƯỢC ROLLBACK ĐỢT 1: BẢO MẬT VÀ KIỂM SOÁT TRUY CẬP
*(Áp dụng cho DEF-002, DEF-011, DEF-013)*

#### 2.1 Điểm kiểm tra an toàn (Safety Checkpoints)
- Lưu trữ bản sao lưu của:
  - `D:\hoso-chat\docker-compose.yml` -> `docker-compose.yml.bak_dot1`
  - `D:\hoso-chat\.env` -> `.env.bak_dot1`
  - `D:\hoso-chat\nginx\default.conf` -> `nginx/default.conf.bak_dot1`
  - `D:\hoso-chat\auth-service\server.js` -> `auth-service/server.js.bak_dot1`

#### 2.2 Dấu hiệu nhận biết cần Rollback (Triggers)
- Container `hr-auth` bị crash loop sau khi nạp biến môi trường mới (Exit code 1 hoặc Error: `secretOrPrivateKey must have a value`).
- Người dùng quản trị không thể đăng nhập được vào hệ thống (bị lỗi 500 khi gọi `/api/auth/login`).
- Nginx không thể khởi động do lỗi cú pháp file cấu hình sau khi xóa block WebDAV.

#### 2.3 Quy trình thực hiện Rollback từng bước
1. **Bước 1 (Dừng dịch vụ bị lỗi):**  
   Không dừng toàn bộ hệ thống; chỉ tác động đến service bị ảnh hưởng:
   ```powershell
   docker compose stop hr-auth
   ```
2. **Bước 2 (Khôi phục file cấu hình gốc):**
   ```powershell
   Copy-Item "D:\hoso-chat\docker-compose.yml.bak_dot1" "D:\hoso-chat\docker-compose.yml" -Force
   Copy-Item "D:\hoso-chat\.env.bak_dot1" "D:\hoso-chat\.env" -Force
   Copy-Item "D:\hoso-chat\nginx\default.conf.bak_dot1" "D:\hoso-chat\nginx\default.conf" -Force
   Copy-Item "D:\hoso-chat\auth-service\server.js.bak_dot1" "D:\hoso-chat\auth-service\server.js" -Force
   ```
3. **Bước 3 (Khởi động lại dịch vụ với cấu hình gốc):**
   ```powershell
   docker compose up -d hr-auth
   docker exec hr-gateway nginx -s reload
   ```
4. **Bước 4 (Xác minh sau hoàn nguyên):**
   - Gọi `GET http://127.0.0.1:8082/api/health` -> Nhận HTTP 200 OK.
   - Thử đăng nhập lại bằng tài khoản admin hiện tại -> Nhận token thành công.

---

### 3. CHIẾN LƯỢC ROLLBACK ĐỢT 2: TÍNH TOÀN VẸN DỮ LIỆU VÀ NGHIỆP VỤ NHÂN SỰ
*(Áp dụng cho DEF-003, DEF-004)*

#### 3.1 Điểm kiểm tra an toàn (Safety Checkpoints)
- Trước khi chạy bất kỳ lệnh SQL nào:
  1. Xuất file backup toàn bộ CSDL `hr_auth`:
     ```powershell
     docker exec hrbot-postgres-1 pg_dump -U postgres hr_auth > "D:\hoso-chat\backups\pre_dot2_full_backup.sql"
     ```
  2. Xuất riêng dữ liệu 4 hồ sơ nhân sự cần xóa:
     ```powershell
     docker exec hrbot-postgres-1 psql -U postgres -d hr_auth -c "COPY (SELECT * FROM employees WHERE id_card IN ('062095000277', '079204001284', '079205001589', '080087002353')) TO STDOUT WITH CSV HEADER;" > "D:\hoso-chat\backups\pre_dot2_4_employees.csv"
     ```

#### 3.2 Dấu hiệu nhận biết cần Rollback (Triggers)
- Lệnh `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY` báo lỗi thất bại do dữ liệu mồ côi hoặc làm khóa bảng kéo dài quá 5 giây.
- Sau khi xóa 4 hồ sơ, số lượng bản ghi của 12 nhân viên còn lại bị suy giảm bất thường.
- Giao diện Admin Console hoặc Chatbot báo lỗi database exception (`error: update or delete on table violates foreign key constraint`).

#### 3.3 Quy trình thực hiện Rollback từng bước
1. **Trường hợp A: Rollback Ràng buộc Khóa Ngoại (DEF-004):**
   Chỉ cần gỡ bỏ ràng buộc bằng 1 lệnh SQL duy nhất:
   ```sql
   ALTER TABLE hr_employee_profiles DROP CONSTRAINT IF EXISTS fk_hr_employee_profiles_employee_code;
   DROP INDEX IF EXISTS idx_employees_employee_code;
   ```
2. **Trường hợp B: Rollback Dữ liệu 4 Hồ sơ Nhân sự (DEF-003):**
   Nếu cần khôi phục lại 4 hồ sơ:
   ```powershell
   docker exec -i hrbot-postgres-1 psql -U postgres -d hr_auth < "D:\hoso-chat\backups\pre_dot2_full_backup.sql"
   ```
   Sau đó kích hoạt reconcile Qdrant vector database:
   ```powershell
   node -e "require('./auth-service/services/qdrantSyncService').reconcile()"
   ```
3. **Bước xác minh sau hoàn nguyên:**
   - Chạy query đếm số lượng: `SELECT count(*) FROM employees;` -> Đạt đúng 16 bản ghi.
   - Kiểm tra Chatbot tra cứu lại bình thường 4 hồ sơ trên.

---

### 4. CHIẾN LƯỢC ROLLBACK ĐỢT 3: AI ROUTER, TOKEN QUOTA VÀ OCR
*(Áp dụng cho DEF-005, DEF-008)*

#### 4.1 Điểm kiểm tra an toàn
- Sao lưu file `auth-service/services/aiRouter.js` -> `aiRouter.js.bak_dot3`.
- Sao lưu file `auth-service/services/fileProcessor.js` -> `fileProcessor.js.bak_dot3`.

#### 4.2 Dấu hiệu nhận biết cần Rollback
- Logic Dynamic Token Budget Truncation cắt xén quá nhiều ngữ cảnh làm Chatbot trả lời sai lệch, ảo giác (hallucination) hoặc trả về thiếu căn cứ.
- Thư viện OCR sau khi cấu hình lại bị lỗi crash tiến trình Node.js khi gặp định dạng file scan lạ.

#### 4.3 Quy trình thực hiện Rollback
1. Khôi phục file mã nguồn cũ:
   ```powershell
   Copy-Item "D:\hoso-chat\auth-service\services\aiRouter.js.bak_dot3" "D:\hoso-chat\auth-service\services\aiRouter.js" -Force
   Copy-Item "D:\hoso-chat\auth-service\services\fileProcessor.js.bak_dot3" "D:\hoso-chat\auth-service\services\fileProcessor.js" -Force
   ```
2. Khởi động lại container `hr-auth`:
   ```powershell
   docker compose restart hr-auth
   ```
3. Chạy test suite đối soát: `node tests/audit_scenario_a.js` để đảm bảo chất lượng câu trả lời trở lại mức tiêu chuẩn.

---

### 5. CHIẾN LƯỢC ROLLBACK ĐỢT 4: TÍCH HỢP GOOGLE SA, ONEDRIVE VÀ N8N
*(Áp dụng cho DEF-001, DEF-007, DEF-012, DEF-014)*

#### 5.1 Điểm kiểm tra an toàn
- **KHÔNG XÓA KHÓA GOOGLE SERVICE ACCOUNT CŨ NGAY:** Trên Google Cloud Console, giữ khóa cũ tồn tại song song trong ít nhất 24 giờ.
- Xuất bản backup bảng `user_onedrive_sources` ra file SQL:
  ```powershell
  docker exec hrbot-postgres-1 pg_dump -U postgres -d hr_auth -t user_onedrive_sources > "D:\hoso-chat\backups\pre_dot4_onedrive_sources.sql"
  ```
- Sao lưu file `auth-service/services/syncWorker.js` -> `syncWorker.js.bak_dot4`.

#### 5.2 Dấu hiệu nhận biết cần Rollback
- Tiến trình đồng bộ Google Sheets báo lỗi xác thực liên tục (HTTP 401/403) và không tự phục hồi được.
- Đồng bộ OneDrive bị lỗi đường dẫn không tìm thấy file sau khi chuẩn hóa dạng relative path.
- Proxy n8n webhook chặn nhầm các request hợp lệ do cấu hình rate limit quá khắt khe.

#### 5.3 Quy trình thực hiện Rollback
1. **Rollback Google SA Key:**
   Khôi phục lại file `syncWorker.js.bak_dot4` chứa khóa cũ (hoặc trỏ lại key cũ) và reload container `hr-auth`.
2. **Rollback Đường dẫn OneDrive:**
   Khôi phục lại dữ liệu bảng:
   ```powershell
   docker exec -i hrbot-postgres-1 psql -U postgres -d hr_auth < "D:\hoso-chat\backups\pre_dot4_onedrive_sources.sql"
   ```
3. **Rollback Nginx Webhook Rate Limit:**
   Khôi phục file cấu hình Nginx gốc và reload:
   ```powershell
   docker exec hr-gateway nginx -s reload
   ```

---

### 6. CHIẾN LƯỢC ROLLBACK ĐỢT 5: HIỆU NĂNG, SAO LƯU VÀ GIAO DIỆN QUẢN TRỊ
*(Áp dụng cho DEF-006, DEF-009, DEF-010)*

#### 6.1 Điểm kiểm tra an toàn
- Lưu trữ bản sao của `chat/hr-admin.html` -> `hr-admin.html.bak_dot5`.
- Lưu trữ bản sao của `auth-service/routes/employees.js` -> `employees.js.bak_dot5`.

#### 6.2 Dấu hiệu nhận biết cần Rollback
- Giao diện Admin Console bị trắng trang, không hiển thị danh sách nhân viên sau khi áp dụng phân trang server-side.
- Task Scheduler sao lưu CSDL hàng ngày chiếm dụng quá nhiều CPU/RAM hoặc gây nghẽn I/O ổ đĩa lúc nửa đêm.

#### 6.3 Quy trình thực hiện Rollback
1. **Rollback Phân trang Admin:**
   ```powershell
   Copy-Item "D:\hoso-chat\chat\hr-admin.html.bak_dot5" "D:\hoso-chat\chat\hr-admin.html" -Force
   Copy-Item "D:\hoso-chat\auth-service\routes\employees.js.bak_dot5" "D:\hoso-chat\auth-service\routes\employees.js" -Force
   docker compose restart hr-auth
   ```
2. **Rollback Schema Archive (Chuyển ngược lại Schema public):**
   ```sql
   ALTER TABLE archive.chat_log_backup_20261018 SET SCHEMA public;
   ALTER TABLE archive.chat_log_archive_legacy SET SCHEMA public;
   DROP SCHEMA IF EXISTS archive RESTRICT;
   ```
3. **Rollback Task Scheduler:**
   ```powershell
   Unregister-ScheduledTask -TaskName "SotransHub_Daily_Postgres_Backup" -Confirm:$false
   ```

---

### 7. BẢNG MA TRẬN THAM SỐ RTO / RPO VÀ PHÂN CÔNG TRÁCH NHIỆM

| Đợt sửa | Thao tác Rollback chính | RTO tối đa (Thời gian khôi phục) | RPO tối đa (Mức độ mất mát dữ liệu) | Người chịu trách nhiệm |
| :--- | :--- | :---: | :---: | :--- |
| **Đợt 1** | Khôi phục compose & .env, reload Nginx | **< 2 phút** | **0 giây (Không mất dữ liệu)** | Kỹ sư Vận hành / DevOps |
| **Đợt 2** | Import bản backup SQL pre_dot2 | **< 3 phút** | **0 giây** | Database Architect / Lead Dev |
| **Đợt 3** | Khôi phục code aiRouter & restart auth | **< 1 phút** | **0 giây** | AI Engineer |
| **Đợt 4** | Khôi phục syncWorker & bảng OneDrive | **< 3 phút** | **0 giây** | Integration Specialist |
| **Đợt 5** | Revert HTML/JS và chuyển lại schema | **< 1 phút** | **0 giây** | Frontend / Backend Dev |

---
*Kế hoạch Hoàn nguyên này là cam kết an toàn vận hành cao nhất, bảo đảm hệ thống SOTRANS Hub luôn có đường lui an toàn trong mọi tình huống phát sinh.*
