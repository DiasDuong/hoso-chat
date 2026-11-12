# KẾ HOẠCH KHẮC PHỤC HỆ THỐNG SOTRANS HUB
## SOTRANS HUB — MASTER SYSTEM REMEDIATION PLAN (SRP-20261029)

> **Tài liệu:** Kế hoạch kỹ thuật chi tiết khắc phục toàn diện hệ thống SOTRANS Hub  
> **Phiên bản:** 1.0 (Remediation Baseline)  
> **Ngày lập:** 29/10/2026  
> **Chế độ:** ĐỀ XUẤT KỸ THUẬT — CHỜ PHÊ DUYỆT (CHƯA TRIỂN KHAI)  
> **Nguyên tắc an toàn:** Không tự ý sửa code, không ghi/xóa dữ liệu thật, không thay đổi cấu hình, không restart/rebuild container khi chưa có phê duyệt từ Ban quản trị.

---

### MỤC LỤC
1. [Lộ trình triển khai tổng thể (Roadmap & Phases)](#1-lộ-trình-triển-khai-tổng-thể-roadmap--phases)
2. [Giai đoạn 1: Khắc phục Khẩn cấp P0 (Google Service Account Key)](#2-giai-đoạn-1-khắc-phục-khẩn-cấp-p0)
3. [Giai đoạn 2: Củng cố An ninh P1 (JWT Secret & Gemini API Key)](#3-giai-đoạn-2-củng-cố-an-ninh-p1)
4. [Giai đoạn 3: Nghiệp vụ Nhân sự & Cơ sở Dữ liệu P2](#4-giai-đoạn-3-nghiệp-vụ-nhân-sự--cơ-sở-dữ-liệu-p2)
5. [Giai đoạn 4: Tối ưu hóa & Dọn dẹp Schema P3](#5-giai-đoạn-4-tối-ưu-hóa--dọn-dẹp-schema-p3)
6. [Ma trận Rủi ro, Kế hoạch Rollback & Tiêu chí Nghiệm thu](#6-ma-trận-rủi-ro-kế-hoạch-rollback--tiêu-chí-nghiệm-thu)

---

### 1. LỘ TRÌNH TRIỂN KHAI TỔNG THỂ (ROADMAP & PHASES)

Kế hoạch khắc phục được chia thành 4 giai đoạn logic theo mức độ rủi ro giảm dần:

```
+---------------------------------------------------------------------------------------------------------+
| GIAI ĐOẠN   | MỨC ĐỘ | MÃ LỖI XỬ LÝ        | NỘI DUNG CHÍNH                          | THỜI GIAN DỰ KIẾN|
+---------------------------------------------------------------------------------------------------------+
| GIAI ĐOẠN 1 | P0     | BUG-001 (AUD-006)   | Thu hồi & luân chuyển Google SA Key     | 1 - 2 giờ        |
| GIAI ĐOẠN 2 | P1     | BUG-002 (AUD-002)   | Đưa JWT_SECRET & GEMINI_KEY vào .env    | 1 - 2 giờ        |
| GIAI ĐOẠN 3 | P2     | BUG-003, 004, 005,  | Xử lý 4 hồ sơ cần xóa, Foreign Key,     | 3 - 5 giờ        |
|             |        | BUG-006, 007, 008   | Backup tự động, Quota Gemini, OneDrive  |                  |
| GIAI ĐOẠN 4 | P3     | BUG-009, BUG-010    | Dọn dẹp bảng backup, Server pagination  | 2 - 3 giờ        |
+---------------------------------------------------------------------------------------------------------+
```

---

### 2. GIAI ĐOẠN 1: KHẮC PHỤC KHẨN CẤP P0

#### Hạng mục 1.1: Thu hồi và Luân chuyển Khóa Google Service Account (BUG-001 / AUD-006)
- **Mã lỗi:** `BUG-001` (Kiểm toán: `AUD-006`).
- **Mục tiêu:**
  - Vô hiệu hóa và xóa bỏ vĩnh viễn cặp khóa RSA Private Key bị lộ trong mã nguồn trên Google Cloud Console.
  - Loại bỏ hoàn toàn chuỗi Private Key hardcoded khỏi file `auth-service/services/syncWorker.js`.
  - Cấu hình cơ chế nạp credentials bảo mật thông qua biến môi trường hoặc file JSON được bảo vệ.
- **Phạm vi tệp tin & dịch vụ bị ảnh hưởng:**
  - Tệp: `auth-service/services/syncWorker.js`
  - Tệp: `.env` và `.gitignore`
  - Dịch vụ: Container `hr-auth` (tính năng đồng bộ Google Sheets hai chiều).
- **Các bước kỹ thuật chi tiết:**
  1. *Bước 1 (Quản trị Google Cloud):* Đăng nhập Google Cloud Console -> IAM & Admin -> Service Accounts -> Chọn tài khoản `sotrans-sheets-sync@...` -> Thẻ Keys.
  2. *Bước 2 (Tạo khóa mới):* Nhấn "Add Key" -> "Create new key" -> Chọn định dạng JSON -> Tải file chứng thực mới về máy an toàn.
  3. *Bước 3 (Lưu trữ chứng thực):* Lưu file tại `D:\hoso-chat\credentials\google_service_account.json` (Đảm bảo thư mục `credentials/` đã được khai báo trong `.gitignore`).
  4. *Bước 4 (Cập nhật mã nguồn `syncWorker.js`):* Sửa đoạn mã đọc hằng số sang đọc từ file hoặc biến môi trường:
     ```javascript
     const fs = require('fs');
     const path = require('path');
     
     let serviceAccount = null;
     const keyFilePath = process.env.GOOGLE_SA_KEY_PATH || path.join(__dirname, '../../credentials/google_service_account.json');
     
     if (fs.existsSync(keyFilePath)) {
       serviceAccount = JSON.parse(fs.readFileSync(keyFilePath, 'utf8'));
     } else if (process.env.GOOGLE_SA_PRIVATE_KEY && process.env.GOOGLE_SA_CLIENT_EMAIL) {
       serviceAccount = {
         client_email: process.env.GOOGLE_SA_CLIENT_EMAIL,
         private_key: process.env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, '\n')
       };
     }
     ```
  5. *Bước 5 (Kiểm thử đồng bộ với khóa mới):* Chạy script kiểm tra kết nối Google Sheets ở chế độ test đọc dữ liệu.
  6. *Bước 6 (Thu hồi khóa cũ):* Trên Google Cloud Console, chọn khóa cũ bị lộ và nhấn "Delete" để vô hiệu hóa hoàn toàn.
- **Kế hoạch kiểm thử nghiệm thu (Acceptance Criteria):**
  - Chạy regex scanner trên toàn bộ mã nguồn: Không còn bất kỳ chuỗi `BEGIN PRIVATE KEY` nào trong git tree.
  - Thử kích hoạt job đồng bộ Google Sheets: Trả về trạng thái kết nối thành công (HTTP 200).
- **Kế hoạch Rollback:**
  - Nếu khóa mới gặp lỗi quyền (Permission Denied): Tạm thời bật lại khóa cũ (nếu chưa xóa) hoặc cấp lại quyền Editor cho email Service Account trên trang tính Google Sheets mục tiêu.

---

### 3. GIAI ĐOẠN 2: CỦNG CỐ AN NINH P1

#### Hạng mục 2.1: Luân chuyển và Ẩn `JWT_SECRET` và `GEMINI_API_KEY` (BUG-002 / AUD-002)
- **Mã lỗi:** `BUG-002` (Kiểm toán: `AUD-002`).
- **Mục tiêu:**
  - Loại bỏ chuỗi plaintext của `JWT_SECRET` và `GEMINI_API_KEY` trong file `docker-compose.yml`.
  - Thiết lập cơ chế nạp biến môi trường chuẩn thông qua file `.env`.
  - Luân chuyển (Rotate) `JWT_SECRET` sang một chuỗi ngẫu nhiên có độ dài tối thiểu 64 ký tự (256-bit entropy).
- **Phạm vi tệp tin & dịch vụ bị ảnh hưởng:**
  - Tệp: `docker-compose.yml`
  - Tệp: `.env`
  - Dịch vụ: Container `hr-auth` (toàn bộ các route xác thực JWT và kết nối AI).
- **Các bước kỹ thuật chi tiết:**
  1. *Bước 1 (Sinh khóa bí mật mới):* Sinh chuỗi ngẫu nhiên bảo mật cao bằng Node.js crypto:
     ```bash
     node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
     ```
  2. *Bước 2 (Cập nhật file `.env`):* Khai báo giá trị mới vào file `.env` tại thư mục gốc:
     ```env
     JWT_SECRET=<CHUỖI_BÍ_MẬT_MỚI_64_KÝ_TỰ>
     GEMINI_API_KEY=<GEMINI_KEY_HIỆN_TẠI_HOẶC_MỚI>
     ```
  3. *Bước 3 (Cập nhật `docker-compose.yml`):* Thay thế chuỗi plaintext bằng biến nội suy:
     ```yaml
     hr-auth:
       environment:
         - JWT_SECRET=${JWT_SECRET}
         - GEMINI_API_KEY=${GEMINI_API_KEY}
     ```
  4. *Bước 4 (Áp dụng cấu hình và tái khởi động có kiểm soát):* Chạy `docker compose up -d hr-auth` sau khi được phê duyệt.
- **Kế hoạch kiểm thử nghiệm thu:**
  - `docker-compose.yml` không còn chứa chuỗi ký tự secret dạng plaintext.
  - Gọi `/api/health` trả về 200 OK.
  - Người dùng đăng nhập thành công, nhận token mới và truy cập được các route bảo vệ.
  - Token cũ bị từ chối với mã 401 (xác nhận token rotation thành công).
- **Kế hoạch Rollback:**
  - Nếu hệ thống gặp sự cố xác thực: Khôi phục lại giá trị `JWT_SECRET` cũ trong file `.env` và nạp lại container.

---

### 4. GIAI ĐOẠN 3: NGHIỆP VỤ NHÂN SỰ & CƠ SỞ DỮ LIỆU P2

#### Hạng mục 3.1: Xử lý 4 Hồ sơ Nhân sự yêu cầu Xóa hoàn toàn (BUG-004 / AUD-015)
- **Mã lỗi:** `BUG-004` (Kiểm toán: `AUD-015`).
- **Mục tiêu:** Xử lý dứt điểm 4 hồ sơ nhân viên thử nghiệm theo quyết định phê duyệt chính thức của Ban quản trị:
  1. Ngô Đặng Tuấn Uyên (CCCD: `062095000277`)
  2. Phan Dương Thanh Bình (CCCD: `079204001284`)
  3. Nguyễn Trần Thiện Nhân (CCCD: `079205001589`)
  4. Lê Thành Nhân (CCCD: `080087002353`)
- **Hai phương án xử lý đề xuất để Ban Quản Trị lựa chọn:**
  - **Lựa chọn A (Hard Delete - Khuyến nghị nếu là dữ liệu test thuần túy):** Xóa toàn bộ bản ghi liên quan trong `employees`, `hr_employee_profiles`, `hr_employee_staging`, và vector Qdrant.
  - **Lựa chọn B (Purge / Deactivate - Nếu cần lưu vết lịch sử):** Đánh dấu trạng thái `DELETED` hoặc chuyển vào bảng lưu trữ riêng biệt `employees_purged_archive`.
- **Quy trình thực hiện an toàn (nếu chọn Phương án A):**
  1. Sao lưu dữ liệu 4 hồ sơ ra file JSON/SQL lưu tại `scratch/backup_4_employees_before_purge.sql`.
  2. Thực hiện transaction SQL có kiểm soát:
     ```sql
     BEGIN;
     DELETE FROM hr_employee_staging WHERE cccd IN ('062095000277', '079204001284', '079205001589', '080087002353');
     DELETE FROM hr_employee_profiles WHERE identity_card_number IN ('062095000277', '079204001284', '079205001589', '080087002353');
     DELETE FROM employees WHERE id_card IN ('062095000277', '079204001284', '079205001589', '080087002353');
     COMMIT;
     ```
  3. Đồng bộ lại Qdrant vector database (`qdrantSyncService.reconcile()`).

#### Hạng mục 3.2: Thiết lập Ràng buộc Khóa Ngoại (Foreign Key) (BUG-005 / AUD-012)
- **Mã lỗi:** `BUG-005` (Kiểm toán: `AUD-012`).
- **Mục tiêu:** Bổ sung ràng buộc `FOREIGN KEY` giữa `employees.employee_code` và `hr_employee_profiles.employee_id` để đảm bảo tính toàn vẹn cấp độ CSDL.
- **Các bước kỹ thuật chi tiết:**
  1. Kiểm tra 100% dữ liệu: Đảm bảo mọi mã nhân viên trong `hr_employee_profiles` đều tồn tại duy nhất trong `employees`.
  2. Tạo index duy nhất: `CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_employee_code ON employees(employee_code);`
  3. Bổ sung ràng buộc:
     ```sql
     ALTER TABLE hr_employee_profiles 
     ADD CONSTRAINT fk_hr_employee_profiles_employee_code 
     FOREIGN KEY (employee_id) REFERENCES employees(employee_code) 
     ON UPDATE CASCADE ON DELETE CASCADE;
     ```
- **Kế hoạch Rollback:**
  `ALTER TABLE hr_employee_profiles DROP CONSTRAINT IF EXISTS fk_hr_employee_profiles_employee_code;`

#### Hạng mục 3.3: Tự động hóa Sao lưu Cơ sở Dữ liệu Hàng ngày (BUG-007 / AUD-024)
- **Mã lỗi:** `BUG-007` (Kiểm toán: `AUD-024`).
- **Mục tiêu:** Xây dựng script PowerShell chạy tự động qua Windows Task Scheduler lúc 01:00 AM mỗi ngày, thực hiện `pg_dump` toàn bộ CSDL và nén lưu trữ trong 30 ngày.
- **Giải pháp kỹ thuật:**
  1. Tạo script `scripts/backup_database_daily.ps1`.
  2. Lệnh thực thi: `docker exec hrbot-postgres-1 pg_dump -U postgres hr_auth | gzip > D:\hoso-chat\backups\backup_hr_auth_(Get-Date -Format 'yyyyMMdd').sql.gz`
  3. Thiết lập chính sách xoá file backup cũ hơn 30 ngày.

#### Hạng mục 3.4: Xử lý Hạn ngạch Gemini Free Tier Token (BUG-003 / AUD-003)
- **Mã lỗi:** `BUG-003` (Kiểm toán: `AUD-003`).
- **Giải pháp:**
  1. Đăng ký liên kết Billing Account cho Google AI Studio để chuyển đổi sang gói **Pay-as-you-go** (chi phí tính theo dung lượng thực tế, chi phí ước tính < $10/tháng cho quy mô nội bộ).
  2. Bổ sung cơ chế cắt ngắn context động (Token Budget Truncation) trong `aiRouter.js` khi tài liệu đính kèm vượt quá ngưỡng 15,000 từ.

---

### 5. GIAI ĐOẠN 4: TỐI ƯU HÓA & DỌN DẸP SCHEMA P3

#### Hạng mục 4.1: Dọn dẹp Bảng Backup Tàn dư trong Schema `public` (BUG-009 / AUD-013)
- **Mã lỗi:** `BUG-009` (Kiểm toán: `AUD-013`).
- **Mục tiêu:** Di chuyển hoặc lưu trữ 2 bảng cũ `chat_log_backup_20261018` và `chat_log_archive_legacy`.
- **Giải pháp kỹ thuật:**
  1. Tạo schema lưu trữ riêng: `CREATE SCHEMA IF NOT EXISTS archive;`
  2. Di chuyển bảng:
     ```sql
     ALTER TABLE public.chat_log_backup_20261018 SET SCHEMA archive;
     ALTER TABLE public.chat_log_archive_legacy SET SCHEMA archive;
     ```
  3. Hoặc xuất dữ liệu ra file `.sql` nén và thực hiện `DROP TABLE public.chat_log_backup_20261018;`.

#### Hạng mục 4.2: Nâng cấp Phân trang Server-side cho Admin Portal (BUG-010 / AUD-005)
- **Mã lỗi:** `BUG-010` (Kiểm toán: `AUD-005`).
- **Mục tiêu:** Bổ sung hỗ trợ tham số `page` và `limit` tại API `GET /api/employees` và cập nhật giao diện `chat/hr-admin.html` để tải dữ liệu theo trang thực tế.
- **Giải pháp kỹ thuật:**
  1. Backend `routes/employees.js`: Đọc `req.query.page` và `req.query.limit`, thực thi câu truy vấn `SELECT ... LIMIT $1 OFFSET $2`.
  2. Frontend `chat/hr-admin.html`: Gửi request với tham số phân trang thay vì tải toàn bộ mảng dữ liệu.

---

### 6. MA TRẬN RỦI RO, KẾ HOẠCH ROLLBACK & TIÊU CHÍ NGHIỆM THU

| Hạng mục | Rủi ro kỹ thuật | Mức độ rủi ro | Biện pháp giảm thiểu | Kế hoạch Rollback | Tiêu chí Nghiệm thu |
| :--- | :--- | :---: | :--- | :--- | :--- |
| **P0: Luân chuyển Google SA Key** | Gián đoạn sync Google Sheet | Trung bình | Kiểm tra kết nối khóa mới trước khi thu hồi khóa cũ | Cấp lại quyền hoặc khôi phục file JSON cũ | Không còn private key trong code; Sheet sync trả về 200 OK |
| **P1: JWT_SECRET & Gemini Key** | Người dùng bị đăng xuất | Thấp | Thực hiện ngoài giờ hành chính; thông báo trước | Trả lại JWT_SECRET cũ vào `.env` | Compose không còn plaintext secret; đăng nhập và chat hoạt động bình thường |
| **P2: Xóa 4 hồ sơ nhân sự** | Xóa nhầm dữ liệu cần giữ | Trung bình | Xuất bản backup SQL trước khi chạy transaction xóa | Import lại từ file backup SQL | 4 hồ sơ bị loại bỏ an toàn; bảng `employees` và `hr_employee_profiles` khớp 100% |
| **P2: Khóa ngoại Foreign Key** | Lỗi ràng buộc khi insert | Thấp | Kiểm tra dữ liệu cha-con trước khi thêm constraint | Lệnh `DROP CONSTRAINT` tức thì | Quan hệ khóa ngoại hoạt động; ngăn chặn bản ghi mồ côi |
| **P2: Backup tự động hàng ngày** | Đầy dung lượng ổ cứng | Thấp | Giới hạn retention 30 ngày; nén gzip | Xóa Task Scheduler | File `.sql.gz` được tạo đều đặn vào 01:00 AM mỗi ngày |
| **P3: Dọn dẹp schema public** | Mất lịch sử chat cũ | Rất thấp | Chỉ di chuyển sang schema `archive` | Chuyển ngược lại schema `public` | Schema `public` sạch sẽ, không còn bảng tạm |

---
*Kế hoạch khắc phục này đã hoàn thiện đầy đủ cơ sở kỹ thuật, phân tích tác động và phương án an toàn, sẵn sàng trình Ban Quản Trị xem xét và phê duyệt trước khi bắt đầu thực thi.*
