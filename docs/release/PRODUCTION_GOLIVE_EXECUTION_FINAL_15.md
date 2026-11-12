# SOTRANS HUB — BÁO CÁO THỰC THI TRIỂN KHAI PRODUCTION CHÍNH THỨC
## PRODUCTION DEPLOYMENT & GO-LIVE EXECUTION REPORT

- **Mã hồ sơ công việc:** `SOTRANS-PROD-GOLIVE-FINAL-15`
- **Dự án:** `D:\hoso-chat`
- **Release Tag:** `rc-ai-platform-v1.0.0`
- **Git Commit:** `b24c8ddf5228219e44262f3b5b16a23d9acc84c8`
- **Căn cứ nghiệm thu đầu vào:** `SOTRANS-AI-PLATFORM-UAT-RC-14`
- **Thời điểm thực thi triển khai:** 30/10/2026 (09:45:00 - 09:54:00+07:00)
- **Trạng thái phát hành chính thức:** **`DEPLOYED_AND_HEALTHY`**
- **Toàn vẹn CSDL Production:** **100% UNTOUCHED (Không chạy migration, 6 nhân viên gốc bất biến)**

---

## 1. GIAI ĐOẠN 1 — XÁC MINH PHIÊN BẢN PHÁT HÀNH (RELEASE PREFLIGHT)

| Tiêu chí thẩm định | Kết quả kiểm tra thực tế | Trạng thái |
| :--- | :--- | :---: |
| **Release Tag** | Tag `rc-ai-platform-v1.0.0` thực sự tồn tại trong Git repository | **VERIFIED** |
| **Commit Target** | Tag trỏ chính xác vào commit SHA `b24c8ddf5228219e44262f3b5b16a23d9acc84c8` | **VERIFIED** |
| **Working Tree & HEAD** | Nhánh `master` đồng bộ tại commit `b24c8ddf5228219e44262f3b5b16a23d9acc84c8` | **VERIFIED** |
| **Mã nguồn Release Artifact** | Toàn bộ 8 module backend và frontend chat đã được kiểm tra cú pháp (`node -c`) không có lỗi cú pháp | **VERIFIED** |
| **Cấu hình mô hình AI** | Thứ tự Fallback được kích hoạt: `gemini-flash-lite-latest` ➡️ `gemini-3.5-flash-lite` ➡️ `gemini-3.1-flash-lite` | **VERIFIED** |

---

## 2. GIAI ĐOẠN 2 — XÁC MINH CƠ SỞ DỮ LIỆU ĐÍCH (DATABASE DISCOVERY & INTEGRITY)

Thực hiện rà soát pháp y độc lập trên hạ tầng máy chủ cơ sở dữ liệu `hrbot-postgres-1` (Cổng 5432):

1. **Phân biệt CSDL Production và CSDL Test:**
   - **`hrbot` (Production Database):** Database nghiệp vụ chính thức, thuộc quyền sở hữu của user `hrbot` (Superuser `rolsuper: t`). Đây là database đích mà `hr-auth` đang kết nối trực tiếp tại runtime (`PG_DATABASE=hrbot`, `PG_USER=hrbot`).
   - **`hrbot_test` (Test Database):** Database cô lập được tạo phục vụ kiểm thử hồi quy (hiện chứa 0 bản ghi nhân viên).
   - **Làm rõ ký hiệu `hr_database` trong tài liệu trước:** Xác nhận `hr_database` và `DB_USER=postgres` chỉ là tên định danh mẫu (sanitized placeholder) trong tài liệu hướng dẫn cấu hình, tuyệt đối không có database nào tên `hr_database` trong PostgreSQL engine.
2. **Đối soát tính toàn vẹn số liệu bảng `employees` trên `hrbot`:**
   - Tổng số lượng nhân viên: **6 bản ghi** (hoàn toàn bất biến).
   - Nhân viên gốc STL: `STL00014` — NGUYỄN TRƯỜNG NAM (CCCD: `036202007139`, Status: `ACTIVE`).
   - Nhân viên gốc SWC: `SWC00021` — NGUYỄN VĂN HIẾU (CCCD: `060098011607`, Status: `ACTIVE`).
   - Các nhân sự thành viên SWC: `SWC00022`, `SWC00023`, `SWC00024`, `SWC00025`.

---

## 3. GIAI ĐOẠN 3 — XÁC MINH QUYỀN TRIỂN KHAI VÀ GIỚI HẠN NGHIỆP VỤ

1. **Quyền triển khai nền tảng AI:**
   - Căn cứ chỉ đạo công việc `SOTRANS-PROD-GOLIVE-FINAL-15`: Phê duyệt triển khai nâng cấp toàn diện nền tảng AI Chatbot (Universal Tool Registry, File Intelligence, ReAct loop, Conversation Reference Resolution) lên Production.
2. **Duy trì chốt chặn nghiệp vụ điều chuyển nhân sự nội bộ (Fail-Closed CCCD Guard):**
   - Hồ sơ nghiệp vụ `INTERNAL_EMPLOYEE_TRANSFER_POLICY_REQUIRED.md` vẫn ở trạng thái chờ Ban Lãnh đạo Tập đoàn phê duyệt chính thức.
   - **Hành động bảo vệ:** Tiếp tục duy trì 100% cơ chế chặn cứng (HTTP 400 Bad Request) khi tiếp nhận hoặc phê duyệt hồ sơ ứng viên có số CCCD trùng với nhân sự đang làm việc (`ACTIVE`) tại đơn vị khác. Tuyệt đối không tự ý mở luồng bypass.
3. **Duy trì chốt chặn dữ liệu nhạy cảm PII và Lương liên công ty:**
   - Căn cứ hồ sơ `ADMIN_CROSS_COMPANY_DATA_ACCESS_APPROVAL.md` (`BUSINESS/SECURITY SIGN-OFF REQUIRED`).
   - **Hành động bảo vệ:** Vai trò `HR` bị làm mờ hoàn toàn thông tin đối soát và lương công ty khác; vai trò `EMPLOYEE` bị chặn triệt để (HTTP 403 Forbidden) không được tra cứu hồ sơ hoặc lương của nhân sự khác.

---

## 4. GIAI ĐOẠN 4 — SAO LƯU AN TOÀN VÀ LƯU TRỮ ARTIFACT TRƯỚC PHÁT HÀNH

Trước khi áp dụng bất kỳ thao tác triển khai nào lên Production, toàn bộ dữ liệu và mã nguồn đã được sao lưu độc lập:

1. **Bản sao lưu CSDL Production `hrbot` (Pre-Deploy Logical Backup):**
   - Lệnh thực thi: `pg_dump -U hrbot -d hrbot -F c -b -v`
   - Vị trí lưu trữ: `D:\hoso-chat\backups\golive_final_15\hrbot_prod_backup_pre_golive_15.dump`
   - Dung lượng tệp: **`15,347,829 bytes`** (~15.35 MB)
   - Kết quả xác minh qua `pg_restore -l`: **265 TOC entries**, định dạng Custom Format hợp lệ, hoàn toàn có thể đọc và khôi phục khi cần thiết.
   - Vị trí tệp sao lưu nằm hoàn toàn ngoài phân vùng dữ liệu của Docker PostgreSQL volume (`hrbot_pg_data`).
2. **Lưu trữ Release Artifact Snapshot:**
   - Đóng gói toàn bộ mã nguồn backend và frontend phiên bản Release Candidate vào thư mục:
     `D:\hoso-chat\backups\golive_final_15\release_artifact_rc_v1_0_0/`
3. **Ghi nhận Docker Image Digests chuẩn trước triển khai:**
   - `hr-auth`: `node:20-alpine` (`sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293`)
   - `hr-gateway`: `nginx:alpine` (`sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2`)
   - `hrbot-postgres-1`: `postgres:16` (`sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54`)
   - `hrbot-qdrant-1`: `qdrant/qdrant:latest` (`sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10`)
   - `hrbot-n8n-1`: `n8nio/n8n:latest` (`sha256:87e0bab2c93192e8dd885ff7b0697c22a1bd97489568a8c67cc140fd7dbb342d`)

---

## 5. GIAI ĐOẠN 5 — CẬP NHẬT KẾ HOẠCH HOÀN NGUYÊN (ROLLBACK PLAN)

Tài liệu `docs/release/ROLLBACK_PLAN.md` đã được nâng cấp thành phiên bản `SOTRANS-ROLLBACK-PLAN-FINAL-15` với các cải tiến bắt buộc:
1. **Thiết kế hoàn nguyên dựa trên Release Artifact:** Loại bỏ việc chỉ dựa vào `git checkout` đơn thuần; sử dụng snapshot mã nguồn đã đóng gói tại `backups/golive_final_15/release_artifact_rc_v1_0_0/` để sao chép hoàn tác nhanh chóng.
2. **Cơ chế bảo vệ dữ liệu:** Ưu tiên hoàn nguyên ở tầng ứng dụng (Application-level rollback) do schema cơ sở dữ liệu không hề thay đổi.
3. **Quy trình phục hồi CSDL cách ly nghiêm ngặt:** Cấm tuyệt đối việc restore đè trực tiếp lên CSDL Production `hrbot` đang online; bắt buộc phải restore kiểm chứng vào database cô lập (`hrbot_restore_verify`) trước khi chuyển đổi có kiểm soát.

---

## 6. GIAI ĐOẠN 6 — THỰC HIỆN TRIỂN KHAI PRODUCTION (DEPLOYMENT EXECUTION)

Các thao tác triển khai được thực thi chuẩn xác, có giới hạn và không gây gián đoạn:

| STT | Thao tác triển khai | Lệnh thực thi | Thời điểm | Mã thoát | Kết quả |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **1** | Nạp mã nguồn mới cho Backend API | `docker restart hr-auth` | 09:49:17 | `0` | Container `hr-auth` khởi động lại sạch sẽ trong 0.8s, nạp trọn vẹn Universal Tool Registry, Reference Resolver và ReAct loop. |
| **2** | Tải lại cấu hình và giao diện Gateway | `docker exec hr-gateway nginx -s reload` | 09:49:19 | `0` | Nginx nhận tín hiệu reload không downtime, phục vụ giao diện AI Workspace mới trên cổng 8082. |
| **3** | Kiểm tra dịch vụ CSDL PostgreSQL | `docker inspect hrbot-postgres-1` | 09:49:20 | `0` | **BẤT BIẾN:** Container `hrbot-postgres-1` không bị khởi động lại, duy trì liên tục `Up 4 days (healthy)`. |
| **4** | Kiểm tra dịch vụ Vector Qdrant & n8n | `docker inspect hrbot-qdrant-1 hrbot-n8n-1` | 09:49:20 | `0` | **BẤT BIẾN:** Vector Database và n8n duy trì hoạt động ổn định `Up 37 hours`. |

---

## 7. GIAI ĐOẠN 7 — KẾT QUẢ SMOKE TEST TRỰC TIẾP TRÊN PRODUCTION

Bộ kịch bản kiểm thử trực tiếp `scratch/smoke_test_production_final_15.js` được thực thi đối với các endpoint Production qua Gateway (8082) và Backend API (3000):

| Mã kiểm tra | Hạng mục kiểm thử | Endpoint & Thao tác | Kỳ vọng | Kết quả thực tế | Trạng thái |
| :---: | :--- | :--- | :--- | :--- | :---: |
| **SMOKE-01** | Gateway Proxy Health | `GET :8082/api/health` | HTTP 200 | HTTP 200 OK, latency < 10ms | **PASS** |
| **SMOKE-02** | Direct Backend Health | `GET :3000/api/health` | HTTP 200 | HTTP 200 OK, latency < 5ms | **PASS** |
| **SMOKE-03** | Production DB Verification | Query `current_database(), current_user` | `hrbot` / `hrbot` | Database: `hrbot`, User: `hrbot` | **PASS** |
| **SMOKE-04** | Qdrant Vector Connectivity | `GET :6333/collections` | HTTP 200 | HTTP 200 OK, collections khả dụng | **PASS** |
| **SMOKE-05** | Xác thực vai trò ADMIN | `POST /api/auth/login` (`admin_stl`) | Token hợp lệ, role ADMIN | HTTP 200, JWT token hợp lệ | **PASS** |
| **SMOKE-06** | Xác thực vai trò HR | `POST /api/auth/login` (`hr_stl`) | Token hợp lệ, role HR | HTTP 200, JWT token hợp lệ | **PASS** |
| **SMOKE-07** | Xác thực vai trò EMPLOYEE | `POST /api/auth/login` (`emp_stl`) | Token hợp lệ, role EMPLOYEE | HTTP 200, JWT token hợp lệ | **PASS** |
| **SMOKE-08** | General AI Response | `POST /api/general/chat` | AI phản hồi chuẩn xác | HTTP 200, phản hồi trực tiếp, không ảo giác | **PASS** |
| **SMOKE-09** | Personal Agent ReAct Loop | `POST /api/agents/:id/chat` | Tính toán số học chính xác | HTTP 200, 15M + 2.5M = 17.5M chính xác | **PASS** |
| **SMOKE-10** | Universal Tool Registry | Kiểm tra danh mục `TOOL_DECLARATIONS` | Đầy đủ 6 công cụ lõi | 6 công cụ chuẩn hóa theo Gemini Schema | **PASS** |
| **SMOKE-11** | File Intelligence Aggregation | Thực thi `calculate_spreadsheet_metrics` | Tính tổng không truncate | HTTP 200, Sum = 8.000.000 VNĐ chuẩn xác | **PASS** |
| **SMOKE-12** | HR Policy RAG Citations | `POST /api/policy/chat` | Trích dẫn số hiệu văn bản | Answerable: true, best_sim: 0.868, trích dẫn số 18/2023/QC-SOTRANS | **PASS** |
| **SMOKE-13** | Chat History & Storage | `GET /api/conversations?agent_id=general` | Trả về danh sách phiên | HTTP 200, 7 phiên hội thoại được lưu trữ | **PASS** |
| **SMOKE-14** | Phân quyền RBAC & IDOR | `GET /api/employees` (Token `emp_stl`) | Chặn nhân viên thường | **HTTP 403 Forbidden** kèm thông báo bảo mật | **PASS** |
| **SMOKE-15** | Kiểm tra định dạng CCCD | `PUT /api/employees/:id` (CCCD = '12345') | Chặn CCCD không hợp lệ | **HTTP 400 Bad Request** (bắt buộc đúng 9 hoặc 12 chữ số) | **PASS** |
| **SMOKE-16** | Toàn vẹn nhân viên gốc | Query `STL00014` & `SWC00021` | Không bị sửa đổi | 100% nguyên vẹn, CCCD và chức danh không đổi | **PASS** |
| **SMOKE-17** | Tổng số lượng bản ghi CSDL | Query `SELECT count(*) FROM employees` | Không phát sinh dư thừa | Số lượng bản ghi cố định = **6** | **PASS** |

**Tỷ lệ Smoke Test đạt:** **17/17 PASS (100%)**.

---

## 8. ĐÁNH GIÁ TÌNH TRẠNG LOG VÀ TỶ LỆ LỖI (ERROR RATE & SYSTEM HEALTH)

- **Log container `hr-auth`:**
  - Khởi chạy tiến trình nền tự động: Qdrant Sync Service đối soát 19/19 tài liệu thành công.
  - Tiến trình Retention Cron định kỳ 7 ngày cho Staging hoạt động bình thường.
  - Không có cảnh báo UnhandledPromiseRejection hoặc uncaughtException.
- **Log container `hr-gateway`:**
  - Nginx xử lý các luồng request với mã HTTP 200 và 304, tỷ lệ lỗi HTTP 5xx là **0.00%**.
- **Log container `hrbot-postgres-1`:**
  - Không xuất hiện cảnh báo bế tắc khóa giao dịch (Deadlock Spikes).
  - Connection Pool duy trì ổn định dưới 20 active clients.

---

## 9. KẾT LUẬN VÀ TUYÊN BỐ TRẠNG THÁI PHÁT HÀNH

Căn cứ trên các bằng chứng kỹ thuật đã được kiểm chứng độc lập trên môi trường Production thực tế:

1. **Phiên bản phát hành:** `rc-ai-platform-v1.0.0` (commit `b24c8ddf5228219e44262f3b5b16a23d9acc84c8`).
2. **Cơ sở dữ liệu đích:** `hrbot` trên container `hrbot-postgres-1` (nguyên vẹn 100%, không migration).
3. **Bản sao lưu trước phát hành:** `hrbot_prod_backup_pre_golive_15.dump` (15.35 MB, 265 TOC entries, lưu trữ an toàn).
4. **Kết quả kiểm thử vận hành:** **17/17 Smoke Tests PASS (100%)**.
5. **Chính sách bảo mật:** Các chốt chặn điều chuyển CCCD trùng lặp và phân quyền PII liên công ty được giữ vững ở chế độ Fail-Closed.

**TUYÊN BỐ TRẠNG THÁI CUỐI CÙNG:**
# 🟢 `DEPLOYED_AND_HEALTHY`
*(Hệ thống SOTRANS Hub AI Platform đã được triển khai chính thức lên Production và đang vận hành ổn định, sẵn sàng phục vụ người dùng).*
