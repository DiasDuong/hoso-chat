# SỔ QUẢN TRỊ VÀ CHI TIẾT TỒN ĐỌNG KỸ THUẬT SOTRANS HUB
## SOTRANS HUB — MASTER REMEDIATION BACKLOG (SRB-20261029)

> **Tài liệu:** Sổ Backlog Chi tiết Quản trị và Khắc phục Hệ thống SOTRANS Hub  
> **Phiên bản:** 2.0 (Post-Testing Backlog Baseline)  
> **Ngày lập:** 29/10/2026  
> **Chế độ:** CHỈ PHÂN TÍCH & QUẢN TRỊ — CHƯA THỰC HIỆN SỬA CODE  
> **Quy chuẩn bảo mật:** Tuyệt đối không đưa private key, mật khẩu, JWT secret hoặc thông tin định danh cá nhân nhạy cảm vào tài liệu.

---

### MỤC LỤC
1. [Bảng chỉ mục Backlog theo Mức độ ưu tiên](#1-bảng-chỉ-mục-backlog-theo-mức-độ-ưu-tiên)
2. [Phiếu xử lý Chi tiết Mức độ P0 (Critical)](#2-phiếu-xử-lý-chi-tiết-mức-độ-p0-critical)
3. [Phiếu xử lý Chi tiết Mức độ P1 (High)](#3-phiếu-xử-lý-chi-tiết-mức-độ-p1-high)
4. [Phiếu xử lý Chi tiết Mức độ P2 (Medium)](#4-phiếu-xử-lý-chi-tiết-mức-độ-p2-medium)
5. [Phiếu xử lý Chi tiết Mức độ P3 (Low)](#5-phiếu-xử-lý-chi-tiết-mức-độ-p3-low)
6. [Phiếu xử lý Chi tiết Mức độ P4 (Improvement / Technical Debt)](#6-phiếu-xử-lý-chi-tiết-mức-độ-p4-improvement--technical-debt)

---

### 1. BẢNG CHỈ MỤC BACKLOG THEO MỨC ĐỘ ƯU TIÊN

```
+------------------------------------------------------------------------------------------------------------------------+
| MÃ LỖI  | ƯU TIÊN | TRẠNG THÁI     | LĨNH VỰC BỊ TÁC ĐỘNG    | TÊN VẤN ĐỀ KỸ THUẬT                | ĐỢT XỬ LÝ DỰ KIẾN  |
+------------------------------------------------------------------------------------------------------------------------+
| DEF-001 | P0      | Đã xác minh    | Tích hợp / Bảo mật      | Lộ Google SA RSA Private Key       | Đợt 4 (Tích hợp)   |
| DEF-002 | P1      | Đã xác minh    | Xác thực / Hạ tầng      | Lộ JWT_SECRET & GEMINI_KEY trong YML| Đợt 1 (Bảo mật)   |
| DEF-003 | P2      | Chờ phê duyệt  | Nghiệp vụ Nhân sự       | 4 Hồ sơ yêu cầu xóa vẫn ACTIVE     | Đợt 2 (Dữ liệu)    |
| DEF-004 | P2      | Đã xác minh    | Cơ sở Dữ liệu           | Thiếu Foreign Key giữa 2 bảng NS   | Đợt 2 (Dữ liệu)    |
| DEF-005 | P2      | Đã xác minh    | AI Router & Quota       | Giới hạn Token Gemini Free Tier 429| Đợt 3 (AI/Token)   |
| DEF-006 | P2      | Đã xác minh    | Sao lưu / Khôi phục     | Thiếu script sao lưu CSDL hàng ngày| Đợt 5 (Vận hành)   |
| DEF-007 | P2      | Đã xác minh    | Tích hợp OneDrive       | Đường dẫn Windows tuyệt đối trong DB| Đợt 4 (Tích hợp)  |
| DEF-008 | P2      | Lỗi môi trường | Intake / OCR            | Thiếu canvas binding trên Win host | Đợt 3 (AI/OCR)     |
| DEF-009 | P3      | Đã xác minh    | Cơ sở Dữ liệu           | 2 Bảng backup tàn dư trong public  | Đợt 5 (Dọn dẹp)    |
| DEF-010 | P3      | Đã xác minh    | Frontend / Hiệu năng    | Phân trang Admin tải 100% vào RAM  | Đợt 5 (Hiệu năng)  |
| DEF-011 | P3      | Đã xác minh    | Nginx Gateway           | Location WebDAV /chat/history cũ   | Đợt 1 (Bảo mật)    |
| DEF-012 | P4      | Cải tiến       | Nợ kỹ thuật Codebase    | Dead code nocodb_helper.js (8084)  | Đợt 4 (Dọn dẹp)    |
| DEF-013 | P4      | Cải tiến       | An ninh Backend         | CORS mở (*) & X-Powered-By rò rỉ   | Đợt 1 (Bảo mật)    |
| DEF-014 | P4      | Cải tiến       | Nginx & Vận hành        | Proxy /webhook/ thiếu Rate Limiting| Đợt 4 (Vận hành)   |
+------------------------------------------------------------------------------------------------------------------------+
```

---

### 2. PHIẾU XỬ LÝ CHI TIẾT MỨC ĐỘ P0 (CRITICAL)

#### PHIẾU XỬ LÝ: DEF-001
1. **ID lỗi và tên lỗi:** `DEF-001` — Lộ Google Service Account RSA Private Key trong mã nguồn.
2. **Mức độ ưu tiên:** **P0 — Critical** (Nguy cơ rò rỉ dữ liệu bảng tính Google Sheets toàn tập đoàn).
3. **Trạng thái xác minh:** Đã xác minh (Verified / Code Inspection confirmed).
4. **Bằng chứng và vị trí phát sinh:** Tệp `auth-service/services/syncWorker.js`, dòng 7 đến dòng 27:
   ```javascript
   const serviceAccount = {
     client_email: "sotrans-sheets-sync@...iam.gserviceaccount.com",
     private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkq...[REDACTED]...\n-----END PRIVATE KEY-----\n"
   };
   ```
5. **Nguyên nhân gốc rễ:** Hardcode thông tin chứng thực trong giai đoạn phát triển ban đầu (Proof of Concept), chưa chuyển sang cơ chế quản lý secret an toàn.
6. **Hành vi hiện tại vs Hành vi mong đợi:**
   - *Hiện tại:* Khóa RSA Private Key nằm trực tiếp trong file mã nguồn.
   - *Mong đợi:* Mã nguồn nạp credentials từ file `credentials/google_service_account.json` (được `.gitignore` bảo vệ) hoặc đọc từ biến môi trường `GOOGLE_SA_PRIVATE_KEY`.
7. **Phạm vi chức năng bị ảnh hưởng:** Toàn bộ tiến trình đồng bộ dữ liệu hai chiều giữa Google Sheets và hệ thống quản lý nhân sự.
8. **Phương án sửa khuyến nghị:**
   - Tạo cặp khóa mới trên Google Cloud Console IAM.
   - Lưu trữ file JSON chứng thực tại thư mục ngoài Git `credentials/google_service_account.json`.
   - Cập nhật `syncWorker.js` kiểm tra và nạp credentials linh hoạt.
   - Thu hồi và xóa khóa cũ trên GCP Console.
9. **Phương án thay thế và nhược điểm:**
   - *Thay thế:* Đưa toàn bộ chuỗi private key vào file `.env`.
   - *Nhược điểm:* Chuỗi RSA key nhiều dòng chứa ký tự xuống dòng `\n`, dễ bị lỗi parse khi nạp qua docker compose env parser.
10. **Danh sách tệp, hàm, dịch vụ tác động:**
    - File: `auth-service/services/syncWorker.js` (Hàm `initSheetsSync`, `authorizeGoogle`).
    - File: `.gitignore`, `.env.example`.
    - Dịch vụ: Container `hr-auth`.
11. **Thành phần phụ thuộc & Nguy cơ dây chuyền:**
    - Tiến trình cron sync Google Sheets. Nếu khóa mới không được chia sẻ quyền Editor trên Sheet, tiến trình sync sẽ báo lỗi `The caller does not have permission` (HTTP 403).
12. **Thay đổi schema/dữ liệu:** Không có.
13. **Kế hoạch sao lưu & Rollback:**
    - Sao lưu file `syncWorker.js` trước khi sửa.
    - Không xóa khóa cũ trên GCP Console ngay lập tức mà giữ lại 24 giờ sau khi kiểm tra khóa mới thành công.
14. **Test case trước và sau khi sửa:**
    - *Trước sửa:* Tìm kiếm regex `BEGIN PRIVATE KEY` trong git tree -> Phát hiện chuỗi key.
    - *Sau sửa:* Tìm kiếm regex -> Không tìm thấy. Gọi thử hàm đồng bộ -> Kết nối thành công, đọc ghi bảng tính bình thường.
15. **Tiêu chí nghiệm thu đo lường được:**
    - 0 kết quả tìm kiếm chuỗi secret trong toàn bộ codebase.
    - Log container ghi nhận: `[Google Sheets Sync] Successfully authenticated via credentials file`.
16. **Điều kiện cần phê duyệt riêng:** Cần quyền truy cập Google Cloud Console của dự án để tạo key mới và xóa key cũ.

---

### 3. PHIẾU XỬ LÝ CHI TIẾT MỨC ĐỘ P1 (HIGH)

#### PHIẾU XỬ LÝ: DEF-002
1. **ID lỗi và tên lỗi:** `DEF-002` — Lộ `JWT_SECRET` và `GEMINI_API_KEY` dạng Plaintext trong `docker-compose.yml`.
2. **Mức độ ưu tiên:** **P1 — High** (Nguy cơ giả mạo token quản trị và lạm dụng tài nguyên AI).
3. **Trạng thái xác minh:** Đã xác minh (Verified / Yaml Inspection confirmed).
4. **Bằng chứng và vị trí phát sinh:** Tệp `docker-compose.yml`, dòng 92 và 94 dưới service `hr-auth`:
   ```yaml
   environment:
     - JWT_SECRET=sotrans_secret_jwt_key_...[REDACTED]
     - GEMINI_API_KEY=AIzaSy...[REDACTED]
   ```
5. **Nguyên nhân gốc rễ:** Cấu hình Docker compose chưa tận dụng cơ chế nạp biến môi trường tự động từ file `.env` của Docker.
6. **Hành vi hiện tại vs Hành vi mong đợi:**
   - *Hiện tại:* Bất kỳ ai mở file `docker-compose.yml` đều nhìn thấy secret.
   - *Mong đợi:* Cấu hình sử dụng cú pháp `${JWT_SECRET}` và `${GEMINI_API_KEY}`, giá trị thực tế lưu riêng trong file `.env` được bảo mật bằng phân quyền file OS (chmod 600 / NTFS ACL).
7. **Phạm vi chức năng bị ảnh hưởng:** Toàn bộ hệ thống xác thực người dùng (Login, Verify Token, RBAC) và kết nối API Gemini.
8. **Phương án sửa khuyến nghị:**
   - Sinh chuỗi `JWT_SECRET` mới 64 bytes (sử dụng `crypto.randomBytes(48).toString('base64')`).
   - Cập nhật file `.env` tại thư mục gốc với các giá trị mới.
   - Thay thế chuỗi plaintext trong `docker-compose.yml` thành biến nội suy.
   - Khởi động lại container `hr-auth` ngoài giờ hành chính.
9. **Phương án thay thế và nhược điểm:**
   - *Thay thế:* Dùng Docker Swarm Secrets hoặc HashiCorp Vault.
   - *Nhược điểm:* Quá phức tạp và vượt quá nhu cầu triển khai Docker Compose đơn máy chủ hiện tại.
10. **Danh sách tệp, hàm, dịch vụ tác động:**
    - File: `docker-compose.yml`, `.env`, `.env.example`.
    - Dịch vụ: Container `hr-auth`.
11. **Thành phần phụ thuộc & Nguy cơ dây chuyền:**
    - Toàn bộ token JWT đã cấp cho người dùng trước thời điểm xoay khóa sẽ lập tức mất hiệu lực (Token Expired/Invalid Signature). Người dùng phải đăng nhập lại.
12. **Thay đổi schema/dữ liệu:** Không có.
13. **Kế hoạch sao lưu & Rollback:**
    - Lưu lại giá trị `JWT_SECRET` cũ vào file ghi chú bảo mật nội bộ.
    - Nếu xảy ra sự cố không đăng nhập được: Ghi lại secret cũ vào `.env` và reload container.
14. **Test case trước và sau khi sửa:**
    - *Trước sửa:* `docker compose config` hiển thị plaintext secret trong output.
    - *Sau sửa:* Biến môi trường được nạp chính xác từ `.env`; token ký bằng secret mới xác thực thành công (HTTP 200); token ký bằng secret cũ bị từ chối (HTTP 401).
15. **Tiêu chí nghiệm thu đo lường được:**
    - File `docker-compose.yml` sạch 100% không còn chuỗi secret.
    - Đăng nhập lấy token mới thành công, truy xuất danh sách nhân viên trả về HTTP 200.
16. **Điều kiện cần phê duyệt riêng:** Phê duyệt khung giờ bảo trì để restart container `hr-auth` (dự kiến mất 3-5 giây gián đoạn xác thực).

---

### 4. PHIẾU XỬ LÝ CHI TIẾT MỨC ĐỘ P2 (MEDIUM)

#### PHIẾU XỬ LÝ: DEF-003
1. **ID lỗi và tên lỗi:** `DEF-003` — 4 Hồ sơ nhân sự yêu cầu xóa hoàn toàn (Hard Delete) vẫn tồn tại ACTIVE.
2. **Mức độ ưu tiên:** **P2 — Medium** (Sai lệch dữ liệu thực tế và rò rỉ hồ sơ nhân viên thử nghiệm).
3. **Trạng thái xác minh:** Đã xác minh hiện trạng / Chờ phê duyệt chính thức từ Chủ sở hữu dữ liệu.
4. **Bằng chứng và vị trí phát sinh:** Bảng `employees`, `hr_employee_profiles`, `hr_employee_staging`:
   - Ngô Đặng Tuấn Uyên (CCCD: `062095000277`)
   - Phan Dương Thanh Bình (CCCD: `079204001284`)
   - Nguyễn Trần Thiện Nhân (CCCD: `079205001589`)
   - Lê Thành Nhân (CCCD: `080087002353`)
5. **Nguyên nhân gốc rễ:** Tuân thủ nguyên tắc an toàn dữ liệu: Không tự ý xóa hồ sơ thật khi chưa có văn bản/quyết định phê duyệt rõ ràng từ người dùng.
6. **Hành vi hiện tại vs Hành vi mong đợi:**
   - *Hiện tại:* 4 hồ sơ vẫn đang ở trạng thái `ACTIVE`, hiển thị trong danh sách tìm kiếm và Chatbot.
   - *Mong đợi:* Loại bỏ hoàn toàn (hoặc lưu trữ vào bảng riêng biệt) theo đúng quyết định của Ban Quản Trị.
7. **Phạm vi chức năng bị ảnh hưởng:** Báo cáo nhân sự, tìm kiếm Chatbot, danh sách trên Admin Console.
8. **Phương án sửa khuyến nghị:**
   - Xuất dữ liệu 4 hồ sơ ra file sao lưu `backups/purge_4_employees_backup_20261029.sql`.
   - Chạy transaction SQL xóa liên hoàn: `hr_employee_staging` -> `hr_employee_profiles` -> `employees`.
   - Kích hoạt hàm đồng bộ Qdrant để xóa vector embeddings tương ứng.
9. **Phương án thay thế và nhược điểm:**
   - *Thay thế:* Đổi trạng thái sang `DELETED` (Soft delete) thay vì xóa thật (Hard delete).
   - *Nhược điểm:* Hồ sơ vẫn tồn tại trong database, có thể bị vô tình kích hoạt lại nếu logic kiểm tra không chặt chẽ.
10. **Danh sách tệp, bảng, dịch vụ tác động:**
    - Bảng: `employees`, `hr_employee_profiles`, `hr_employee_staging`.
    - Dịch vụ: PostgreSQL, Qdrant Vector Collection `hr_docs`.
11. **Thành phần phụ thuộc & Nguy cơ dây chuyền:** Bảng audit log hoặc các khóa ngoại phụ (nếu có). Cần đảm bảo không vi phạm ràng buộc dữ liệu.
12. **Thay đổi schema/dữ liệu:** Giảm 4 bản ghi trên mỗi bảng liên quan.
13. **Kế hoạch sao lưu & Rollback:**
    - Đã có file backup SQL trước khi xóa.
    - Rollback bằng lệnh: `psql -U postgres -d hr_auth -f backups/purge_4_employees_backup_20261029.sql`.
14. **Test case trước và sau khi sửa:**
    - *Trước:* `SELECT count(*) FROM employees WHERE id_card IN (...)` trả về 4.
    - *Sau:* Câu truy vấn trả về 0. Chatbot hỏi về 4 người này trả lời không tìm thấy hồ sơ.
15. **Tiêu chí nghiệm thu đo lường được:** Cả 3 bảng chính và Qdrant hoàn toàn sạch bóng 4 hồ sơ trên.
16. **Điều kiện cần phê duyệt riêng:** **BẮT BUỘC PHÊ DUYỆT RÕ RÀNG BẰNG VĂN BẢN TRƯỚC KHI THỰC HIỆN.**

---

#### PHIẾU XỬ LÝ: DEF-004
1. **ID lỗi và tên lỗi:** `DEF-004` — Thiếu ràng buộc Foreign Key cứng giữa 2 bảng nhân sự cốt lõi.
2. **Mức độ ưu tiên:** **P2 — Medium** (Nguy cơ phát sinh bản ghi mồ côi khi mở rộng hệ thống).
3. **Trạng thái xác minh:** Đã xác minh (Verified / Schema Inspection).
4. **Bằng chứng và vị trí phát sinh:** Bảng `employees` (cột `employee_code`) và bảng `hr_employee_profiles` (cột `employee_id`). Không tồn tại ràng buộc trong `information_schema.table_constraints`.
5. **Nguyên nhân gốc rễ:** Phát triển hai bảng ở hai giai đoạn khác nhau mà không áp dụng database migration quy chuẩn.
6. **Hành vi hiện tại vs Hành vi mong đợi:**
   - *Hiện tại:* Ràng buộc phụ thuộc 100% vào code Express. Nếu có lệnh SQL ngoài code can thiệp, dữ liệu có thể bị lệch.
   - *Mong đợi:* Ràng buộc cấp độ CSDL: Xóa hoặc cập nhật mã ở `employees` sẽ cascade hoặc chặn đúng chuẩn.
7. **Phạm vi chức năng bị ảnh hưởng:** Toàn bộ luồng tạo, cập nhật, xóa nhân sự.
8. **Phương án sửa khuyến nghị:**
   - Sau khi thực hiện xong `DEF-003` (đảm bảo 100% khớp dữ liệu 1:1).
   - Thêm Unique Constraint cho `employees(employee_code)`.
   - Thêm Foreign Key:
     ```sql
     ALTER TABLE hr_employee_profiles 
     ADD CONSTRAINT fk_hr_employee_profiles_employee_code 
     FOREIGN KEY (employee_id) REFERENCES employees(employee_code) 
     ON UPDATE CASCADE ON DELETE CASCADE;
     ```
9. **Phương án thay thế:** Dùng trigger PostgreSQL đồng bộ. Nhược điểm: Phức tạp, khó bảo trì hơn Foreign Key chuẩn.
10. **Danh sách tệp, bảng tác động:** Bảng `hr_employee_profiles`, `employees`.
11. **Thành phần phụ thuộc:** Phải làm sạch dữ liệu trước (`DEF-003`), nếu không lệnh `ALTER TABLE` sẽ bị lỗi.
12. **Thay đổi schema/dữ liệu:** Bổ sung 1 Unique Index và 1 Foreign Key Constraint.
13. **Kế hoạch Rollback:** `ALTER TABLE hr_employee_profiles DROP CONSTRAINT fk_hr_employee_profiles_employee_code;`.
14. **Test case:**
    - Thử chèn bản ghi vào `hr_employee_profiles` với `employee_id` không tồn tại -> Database chặn với lỗi `23503 foreign_key_violation`.
15. **Tiêu chí nghiệm thu:** Ràng buộc hiển thị trong `\d hr_employee_profiles` trên PostgreSQL.
16. **Điều kiện cần phê duyệt riêng:** Phê duyệt chạy script migration thay đổi schema database.

---

#### PHIẾU XỬ LÝ: DEF-005
1. **ID lỗi và tên lỗi:** `DEF-005` — Hạn ngạch Gemini Free Tier Token gây lỗi cạn kiệt 429.
2. **Mức độ ưu tiên:** **P2 — Medium** (Ảnh hưởng độ sẵn sàng và trải nghiệm chatbot).
3. **Trạng thái xác minh:** Đã xác minh (Verified / Quota limits documented).
4. **Bằng chứng và vị trí phát sinh:** `auth-service/services/aiRouter.js` và `geminiService.js`. Gói Free Tier giới hạn 250,000 input tokens/ngày.
5. **Nguyên nhân gốc rễ:** Chưa đăng ký Billing Account cho dự án Google AI Studio doanh nghiệp.
6. **Hành vi hiện tại vs Hành vi mong đợi:**
   - *Hiện tại:* Bị gián đoạn hoặc fallback sang model nhỏ hơn khi người dùng tra cứu tài liệu dài.
   - *Mong đợi:* Chatbot phản hồi liên tục, ổn định không giới hạn 250k token/ngày.
7. **Phạm vi chức năng bị ảnh hưởng:** Chatbot tra cứu quy chế, chính sách và tài liệu nhân sự.
8. **Phương án sửa khuyến nghị:**
   - Đăng ký Pay-as-you-go trên Google AI Studio.
   - Bổ sung thuật toán Dynamic Token Budget Truncation trong `aiRouter.js` để tự động tóm tắt ngữ cảnh RAG trước khi gửi lên API, tiết kiệm 40% chi phí token.
9. **Phương án thay thế:** Thiết lập pool xoay vòng 3 API key miễn phí khác nhau. Nhược điểm: Vi phạm điều khoản sử dụng của Google, không ổn định lâu dài.
10. **Danh sách tệp tác động:** `auth-service/services/aiRouter.js`.
11. **Thành phần phụ thuộc:** Thẻ thanh toán quốc tế của doanh nghiệp trên GCP.
12. **Thay đổi schema/dữ liệu:** Không có.
13. **Kế hoạch Rollback:** Khôi phục file `aiRouter.js` gốc nếu logic cắt giảm token gây thiếu thông tin trả lời.
14. **Test case:** Gửi prompt dài 20,000 từ -> Chatbot xử lý mượt mà, không gặp lỗi 429.
15. **Tiêu chí nghiệm thu:** Tỷ lệ lỗi HTTP 429 đạt 0% trong 7 ngày theo dõi liên tục.
16. **Điều kiện cần phê duyệt riêng:** Phê duyệt gắn thẻ thanh toán chi phí API Google Cloud.

---

#### PHIẾU XỬ LÝ: DEF-006
1. **ID lỗi và tên lỗi:** `DEF-006` — Thiếu cơ chế sao lưu CSDL tự động định kỳ hàng ngày (`pg_dump`).
2. **Mức độ ưu tiên:** **P2 — Medium** (Rủi ro mất dữ liệu khi gặp sự cố phần cứng máy chủ).
3. **Trạng thái xác minh:** Đã xác minh (Verified / Scheduler check).
4. **Bằng chứng và vị trí phát sinh:** Không có cron job hoặc Task Scheduler sao lưu tự động cho container `hrbot-postgres-1`.
5. **Nguyên nhân gốc rễ:** Chưa hoàn thiện quy trình vận hành và quản trị sau thảm họa (Disaster Recovery).
6. **Hành vi hiện tại vs Hành vi mong đợi:**
   - *Hiện tại:* Dữ liệu chỉ nằm trong volume Docker. Nếu volume bị hỏng, dữ liệu mất hoàn toàn.
   - *Mong đợi:* 01:00 AM hàng ngày, script tự động chạy `pg_dump`, nén gzip và lưu vào thư mục `D:\hoso-chat\backups\`, tự động dọn dẹp file cũ quá 30 ngày.
7. **Phạm vi chức năng bị ảnh hưởng:** An toàn và khả năng phục hồi dữ liệu hệ thống.
8. **Phương án sửa khuyến nghị:**
   - Tạo script `scripts/backup_database_daily.ps1`.
   - Đăng ký tác vụ trên Windows Task Scheduler: `SotransHub_Daily_Postgres_Backup`.
9. **Phương án thay thế:** Viết cron chạy bên trong container Postgres. Nhược điểm: Phụ thuộc vào vòng đời của container, nếu container bị recreate thì cron trong container bị mất.
10. **Danh sách tệp tác động:** `scripts/backup_database_daily.ps1`, thư mục `backups/`.
11. **Thành phần phụ thuộc:** Dung lượng ổ đĩa `D:` (mỗi bản backup nén ~5-10MB).
12. **Thay đổi schema/dữ liệu:** Không có.
13. **Kế hoạch Rollback:** Hủy đăng ký tác vụ: `Unregister-ScheduledTask -TaskName "SotransHub_Daily_Postgres_Backup"`.
14. **Test case:** Chạy thử thủ công script PowerShell -> Sinh ra file `backup_hr_auth_20261029.sql.gz` có kích thước > 0 và giải nén kiểm tra toàn vẹn thành công.
15. **Tiêu chí nghiệm thu:** File backup mới xuất hiện đều đặn mỗi sáng và log ghi nhận thành công.
16. **Điều kiện cần phê duyệt riêng:** Phê duyệt tạo Task Scheduler trên máy chủ Windows.

---

#### PHIẾU XỬ LÝ: DEF-007
1. **ID lỗi và tên lỗi:** `DEF-007` — Đường dẫn Windows tuyệt đối trong bảng `user_onedrive_sources.storage_path`.
2. **Mức độ ưu tiên:** **P2 — Medium** (Khó khăn khi di trú hệ thống sang Linux Container).
3. **Trạng thái xác minh:** Đã xác minh (Verified / DB Query confirmed).
4. **Bằng chứng và vị trí phát sinh:** Cột `storage_path` trong bảng `user_onedrive_sources` lưu đường dẫn dạng: `D:\hoso-chat\staging\onedrive\...`.
5. **Nguyên nhân gốc rễ:** Worker ban đầu chạy trực tiếp từ PowerShell của lập trình viên thay vì chạy trong container Linux.
6. **Hành vi hiện tại vs Hành vi mong đợi:**
   - *Hiện tại:* Đường dẫn chứa ký tự ổ đĩa `D:\` và dấu `\`.
   - *Mong đợi:* Đường dẫn tương đối dạng `./staging/onedrive/...` hoặc POSIX path `/app/staging/onedrive/...`.
7. **Phạm vi chức năng bị ảnh hưởng:** Tiến trình đồng bộ OneDrive khi chạy trên container.
8. **Phương án sửa khuyến nghị:**
   - Chuẩn hóa hàm xử lý đường dẫn trong `onedriveSyncService.js` sử dụng `path.relative()` hoặc `path.posix.join()`.
   - Cập nhật các bản ghi cũ bằng câu lệnh SQL `UPDATE user_onedrive_sources SET storage_path = ...`.
9. **Phương án thay thế:** Không sửa trong CSDL, chỉ convert on-the-fly trong code. Nhược điểm: Dữ liệu CSDL không nhất quán.
10. **Danh sách tệp, bảng tác động:** Bảng `user_onedrive_sources`, file `auth-service/services/onedriveSyncService.js`.
11. **Thành phần phụ thuộc:** File vật lý đã lưu trên đĩa tại `staging/onedrive/`.
12. **Thay đổi dữ liệu:** Chuẩn hóa chuỗi đường dẫn trong bảng.
13. **Kế hoạch Rollback:** Lưu bản backup bảng `user_onedrive_sources` trước khi cập nhật.
14. **Test case:** Đồng bộ tệp OneDrive mới -> Đường dẫn được lưu dạng POSIX/relative, đọc ghi file bình thường trên cả Windows host và Linux container.
15. **Tiêu chí nghiệm thu:** 100% bản ghi không còn chứa tiền tố `D:\`.
16. **Điều kiện cần phê duyệt riêng:** Không (nằm trong đợt sửa Tích hợp).

---

#### PHIẾU XỬ LÝ: DEF-008
1. **ID lỗi và tên lỗi:** `DEF-008` — Thiếu native binding `@napi-rs/canvas` trên Windows host environment.
2. **Mức độ ưu tiên:** **P2 — Medium** (Gây cảnh báo khi chạy script kiểm thử OCR ngoài container).
3. **Trạng thái xác minh:** Lỗi đặc thù môi trường Windows Host (Environment Specific).
4. **Bằng chứng và vị trí phát sinh:** Console warning: `Cannot find module '@napi-rs/canvas-win32-x64-msvc'` khi chạy Node.js test script từ PowerShell máy trạm.
5. **Nguyên nhân gốc rễ:** Thư viện `@napi-rs/canvas` chưa được cài đặt native binary tương thích với kiến trúc Windows x64 trên máy trạm phát triển (trong khi Docker Linux container đã có đầy đủ).
6. **Hành vi hiện tại vs Hành vi mong đợi:**
   - *Hiện tại:* Tự động fallback sang `pdf-parse` dạng text, bỏ qua bóc tách chữ từ hình ảnh khi chạy trên máy trạm.
   - *Mong đợi:* Thư viện nhận diện đầy đủ hoặc test script kiểm tra môi trường và không in warning gây nhầm lẫn.
7. **Phạm vi chức năng bị ảnh hưởng:** Test runner chạy trực tiếp từ Windows Host.
8. **Phương án sửa khuyến nghị:**
   - Giữ nguyên cơ chế fallback an toàn của mã nguồn sản phẩm.
   - Bổ sung tài liệu cấu hình hoặc cài đặt dev dependency `@napi-rs/canvas-win32-x64-msvc` cho môi trường máy trạm.
9. **Phương án thay thế:** Buộc mọi bài test OCR phải chạy bên trong Docker container Linux (`docker exec hr-auth npm test`).
10. **Danh sách tệp tác động:** `tests/test_docx_pdf_runtime.js`.
11. **Thành phần phụ thuộc:** Node.js version trên máy trạm Windows.
12. **Thay đổi schema/dữ liệu:** Không có.
13. **Kế hoạch Rollback:** Không có rủi ro hệ thống.
14. **Test case:** Chạy test OCR trên Windows -> Không xuất hiện cảnh báo lỗi binding.
15. **Tiêu chí nghiệm thu:** Test OCR hoàn thành 100% Pass trên cả máy host và container.
16. **Điều kiện cần phê duyệt riêng:** Phê duyệt cài đặt thêm gói npm dev-dependency trên máy trạm.

---

### 5. PHIẾU XỬ LÝ CHI TIẾT MỨC ĐỘ P3 (LOW)

#### PHIẾU XỬ LÝ: DEF-009
1. **ID lỗi và tên lỗi:** `DEF-009` — Tồn tại 2 bảng sao lưu tàn dư trong schema `public`.
2. **Mức độ ưu tiên:** **P3 — Low** (Dọn dẹp rác cơ sở dữ liệu).
3. **Trạng thái xác minh:** Đã xác minh (Verified / Table count confirmed).
4. **Bằng chứng và vị trí phát sinh:** Schema `public`, bảng `chat_log_backup_20261018` (1,691 rows) và `chat_log_archive_legacy` (395 rows).
5. **Nguyên nhân gốc rễ:** Lập trình viên tạo bảng sao lưu thủ công trong quá trình vá lỗi trước đây mà không chuyển vào schema lưu trữ riêng biệt.
6. **Hành vi hiện tại vs Hành vi mong đợi:**
   - *Hiện tại:* 2 bảng nằm lẫn trong schema chính, gây nhiễu cho các công cụ auto-migration và NocoDB.
   - *Mong đợi:* Schema `public` chỉ chứa các bảng phục vụ ứng dụng; các bảng sao lưu cũ được di chuyển sang schema `archive`.
7. **Phạm vi chức năng bị ảnh hưởng:** Không ảnh hưởng đến người dùng cuối.
8. **Phương án sửa khuyến nghị:**
   ```sql
   CREATE SCHEMA IF NOT EXISTS archive;
   ALTER TABLE public.chat_log_backup_20261018 SET SCHEMA archive;
   ALTER TABLE public.chat_log_archive_legacy SET SCHEMA archive;
   ```
9. **Phương án thay thế:** `DROP TABLE` trực tiếp sau khi xuất file `.sql.gz`.
10. **Danh sách bảng tác động:** 2 bảng sao lưu.
11. **Thành phần phụ thuộc:** Không có.
12. **Thay đổi schema:** Tạo schema `archive` và đổi namespace cho 2 bảng.
13. **Kế hoạch Rollback:** `ALTER TABLE archive.chat_log_backup_20261018 SET SCHEMA public;`.
14. **Test case:** `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%backup%'` -> Trả về 0 dòng.
15. **Tiêu chí nghiệm thu:** Schema `public` sạch sẽ 100%.
16. **Điều kiện cần phê duyệt riêng:** Phê duyệt thay đổi schema database.

---

#### PHIẾU XỬ LÝ: DEF-010
1. **ID lỗi và tên lỗi:** `DEF-010` — Giao diện Quản trị tải toàn bộ hồ sơ vào RAM trình duyệt để phân trang.
2. **Mức độ ưu tiên:** **P3 — Low** (Nợ kỹ thuật hiệu năng Frontend).
3. **Trạng thái xác minh:** Đã xác minh (Verified / Code inspection).
4. **Bằng chứng và vị trí phát sinh:** `chat/hr-admin.html`, hàm `loadEmployees()` gọi `GET /api/employees` nhận mảng toàn bộ nhân viên rồi dùng `.slice()` trên client.
5. **Nguyên nhân gốc rễ:** Thiết kế nhanh trong giai đoạn đầu khi số lượng nhân viên còn ít.
6. **Hành vi hiện tại vs Hành vi mong đợi:**
   - *Hiện tại:* Tải toàn bộ danh sách về máy khách.
   - *Mong đợi:* API hỗ trợ `GET /api/employees?page=1&limit=10`, trả về đúng 10 bản ghi kèm metadata `{ total, page, totalPages }`.
7. **Phạm vi chức năng bị ảnh hưởng:** Trang quản trị `hr-admin.html`.
8. **Phương án sửa khuyến nghị:**
   - Cập nhật backend `auth-service/routes/employees.js`: Kiểm tra nếu có tham số `page` và `limit` thì thực hiện phân trang server-side; nếu không có thì trả về danh sách đầy đủ (để đảm bảo tương thích ngược).
   - Cập nhật `chat/hr-admin.html`: Gửi tham số trang khi bấm nút Next/Previous.
9. **Phương án thay thế:** Giữ nguyên cho đến khi số lượng nhân viên vượt quá 200 người.
10. **Danh sách tệp tác động:** `auth-service/routes/employees.js`, `chat/hr-admin.html`.
11. **Thành phần phụ thuộc:** Các tính năng lọc trạng thái trên giao diện.
12. **Thay đổi schema/dữ liệu:** Không có.
13. **Kế hoạch Rollback:** Git checkout lại phiên bản cũ của 2 file.
14. **Test case:** Mở trang quản trị -> Network tab chỉ nhận đúng 10 bản ghi trên mỗi lượt chuyển trang.
15. **Tiêu chí nghiệm thu:** Thời gian render giao diện < 100ms, dung lượng tải về < 5KB/trang.
16. **Điều kiện cần phê duyệt riêng:** Không.

---

#### PHIẾU XỬ LÝ: DEF-011
1. **ID lỗi và tên lỗi:** `DEF-011` — Location WebDAV `/chat/history` cũ trong `nginx/default.conf` không còn sử dụng.
2. **Mức độ ưu tiên:** **P3 — Low** (Dọn dẹp cấu hình Nginx cũ).
3. **Trạng thái xác minh:** Đã xác minh (Verified / Config inspection).
4. **Bằng chứng và vị trí phát sinh:** `nginx/default.conf`, dòng 48 đến dòng 58:
   ```nginx
   location = /chat/history {
     auth_basic "Ho so nhan su";
     auth_basic_user_file /etc/nginx/.htpasswd;
     alias /usr/share/nginx/chat-files/_history_$remote_user.json;
     dav_methods PUT;
   }
   ```
5. **Nguyên nhân gốc rễ:** Cơ chế lưu lịch sử chat cũ qua WebDAV từ các bản prototype ban đầu, hiện tại lịch sử chat đã được quản lý tập trung qua CSDL PostgreSQL.
6. **Hành vi hiện tại vs Hành vi mong đợi:**
   - *Hiện tại:* Vẫn mở endpoint WebDAV và yêu cầu file `.htpasswd`.
   - *Mong đợi:* Loại bỏ hoàn toàn khối cấu hình này để giảm thiểu bề mặt tấn công.
7. **Phạm vi chức năng bị ảnh hưởng:** Không có (không còn tính năng nào gọi endpoint này).
8. **Phương án sửa khuyến nghị:** Xóa bỏ khối `location = /chat/history` trong `nginx/default.conf` và nạp lại Nginx (`nginx -s reload`).
9. **Phương án thay thế:** Đổi thành `return 404;` hoặc `deny all;`.
10. **Danh sách tệp tác động:** `nginx/default.conf`.
11. **Thành phần phụ thuộc:** Không có.
12. **Thay đổi schema/dữ liệu:** Không có.
13. **Kế hoạch Rollback:** Thêm lại khối cấu hình và reload Nginx.
14. **Test case:** Gọi `curl http://127.0.0.1:8082/chat/history` -> Trả về 404 Not Found thay vì 401 Basic Auth.
15. **Tiêu chí nghiệm thu:** Cấu hình Nginx sạch sẽ, không còn chỉ thị WebDAV thừa.
16. **Điều kiện cần phê duyệt riêng:** Không.

---

### 6. PHIẾU XỬ LÝ CHI TIẾT MỨC ĐỘ P4 (IMPROVEMENT / TECHNICAL DEBT)

#### PHIẾU XỬ LÝ: DEF-012
1. **ID lỗi:** `DEF-012` — Mã nguồn chết `auth-service/nocodb_helper.js` (cổng 8084).
2. **Mức độ:** **P4 — Improvement** (Dọn dẹp mã nguồn rác).
3. **Trạng thái:** Đã xác minh (Verified / No references found).
4. **Bằng chứng:** Tệp `auth-service/nocodb_helper.js` và `auth-service/services/nocodb_helper.js` không được `require` ở bất kỳ đâu trong dự án.
5. **Nguyên nhân:** Thử nghiệm tích hợp NocoDB microservice cũ bị bỏ dở.
6. **Hành vi mong đợi:** Xóa bỏ file để tránh gây hiểu nhầm cho các kỹ sư bảo trì sau này.
7. **Phương án sửa:** Xóa 2 file file chết này khỏi kho lưu trữ.
8. **Rollback:** Khôi phục file từ Git nếu cần.

#### PHIẾU XỬ LÝ: DEF-013
1. **ID lỗi:** `DEF-013` — Cấu hình CORS mở (`*`) và rò rỉ header `X-Powered-By: Express`.
2. **Mức độ:** **P4 — Improvement** (Gia cố an ninh Backend).
3. **Trạng thái:** Đã xác minh (Verified / Code inspection).
4. **Bằng chứng:** Trong `auth-service/server.js`: `app.use(cors())` mở toàn bộ origin và chưa tắt `app.disable('x-powered-by')`.
5. **Nguyên nhân:** Cấu hình mặc định của Express.
6. **Hành vi mong đợi:** Giới hạn Origin theo danh sách whitelist domain nội bộ (`window.location.origin`), ẩn hoàn toàn thông tin framework Node.js/Express.
7. **Phương án sửa:** Bổ sung cấu hình CORS an toàn và gọi `app.disable('x-powered-by')`.
8. **Tiêu chí nghiệm thu:** Response header không còn chứa `X-Powered-By`.

#### PHIẾU XỬ LÝ: DEF-014
1. **ID lỗi:** `DEF-014` — Tuyến proxy Nginx `/webhook/` chuyển tiếp vào n8n thiếu Rate Limiting.
2. **Mức độ:** **P4 — Improvement** (Chống tấn công từ chối dịch vụ DoS/Brute-force).
3. **Trạng thái:** Đã xác minh (Verified / Config inspection).
4. **Bằng chứng:** `nginx/default.conf` forward trực tiếp request `/webhook/` vào container n8n mà không qua `limit_req_zone`.
5. **Nguyên nhân:** Chưa thiết lập cấu hình chống lạm dụng request.
6. **Hành vi mong đợi:** Giới hạn tần suất gọi webhook (ví dụ: tối đa 30 requests/phút trên mỗi địa chỉ IP).
7. **Phương án sửa:** Khai báo `limit_req_zone $binary_remote_addr zone=webhook_limit:10m rate=30r/m;` và áp dụng vào location `/webhook/`.
8. **Tiêu chí nghiệm thu:** Gửi liên tiếp 40 requests từ một IP -> 10 requests cuối nhận HTTP 429 hoặc 503.

---
*Sổ Backlog này được lưu giữ và cập nhật trạng thái trong suốt vòng đời dự án SOTRANS Hub.*
