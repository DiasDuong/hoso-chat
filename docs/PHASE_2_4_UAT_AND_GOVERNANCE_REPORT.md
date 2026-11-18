# SOTRANS HUB — BÁO CÁO NGHIỆM THU PHASE 2.4
## USER ACCEPTANCE TESTING & DATA GOVERNANCE HARDENING
### Chức năng Phân tích Dữ liệu Bảng tính Tải lên trong Giao diện General AI

---

## 1. TỔNG QUAN VÀ QUYẾT ĐỊNH NGHIỆM THU (GATE DECISION)

| Tiêu chí | Trạng thái | Đánh giá |
| :--- | :---: | :--- |
| **Môi trường nghiệm thu** | Staging (`sotrans_staging` port 5433, container `sotrans-auth-staging` port 3001) | ✅ Độc lập, cách ly tuyệt đối với Production |
| **Giao diện người dùng** | General AI duy nhất (không tạo chatbot hay tab riêng) | ✅ Đạt chuẩn kiến trúc hợp nhất |
| **Kiểm thử UAT Trải nghiệm** | 12/12 kịch bản trải nghiệm người dùng đạt chuẩn | ✅ 100% PASS |
| **Quản trị Vòng đời & Quyền dữ liệu** | Phân quyền ADMIN/HR/EMPLOYEE, Chia sẻ & Thu hồi tức thì | ✅ 100% PASS |
| **Tự động dọn dẹp & Lưu trữ** | Chính sách lưu 7 ngày, dọn tệp mồ côi & dataset kẹt | ✅ 100% PASS |
| **Nhật ký Kiểm toán (Audit Log)** | Ghi nhận đầy đủ vòng đời, loại bỏ 100% PII & raw rows | ✅ 100% PASS |
| **An toàn Bảo mật & Chống Tấn công** | IDOR, Path Traversal, PE Binary, ZIP Bomb, Formula/Prompt Injection | ✅ 100% PASS |
| **Hiệu năng & Định mức Tài nguyên** | Benchmark đến 50.000 dòng, concurrency semaphore 10 slots | ✅ Đạt xuất sắc (<50ms truy vấn) |
| **Tác động Database Nhân sự (`hrbot`)** | Không ghi dòng nào, không tạo bảng hay làm biến động DB | ✅ 100% Zero Intrusion |
| **Kiểm tra Role `staging_admin`** | Phát hiện `rolsuper: true` trên Staging DB | ⚠️ Ghi nhận điều kiện tiên quyết trước Prod |
| **Tổng kết Kiểm thử Hệ thống** | **255 / 255 Test Scenarios PASS (0 FAIL)** | ✅ **READY FOR PRODUCTION READINESS REVIEW** |

---

## 2. BẢNG TỔNG HỢP KẾT QUẢ TEST TOÀN HỆ THỐNG (REGRESSION & UAT)

Tất cả 8 bộ test suites trên toàn hệ thống đã được thực thi và xác minh đạt 100% tỷ lệ thành công:

```
========================================================================================
SOTRANS HUB — TOÀN BỘ KẾT QUẢ KIỂM THỬ TÍCH HỢP & NGHIỆM THU
========================================================================================
1. Analytics Engine Foundation Suite (Phase 1.1 - 1.4):  30 / 30 PASS   (100%)
2. Reporting API Suite (POST /api/analytics/kpis):        30 / 30 PASS   (100%)
3. General AI & BI Integration Suite:                   35 / 35 PASS   (100%)
4. Phase 1.4 E2E Staging Verification Suite:             53 / 53 PASS   (100%)
5. Phase 2 File Intake & Profiling Suite:                38 / 38 PASS   (100%)
6. Phase 2.3 AI Data Analysis & Advanced Query Suite:    19 / 19 PASS   (100%)
7. Phase 2.4 UAT & Data Governance Hardening Suite:      35 / 35 PASS   (100%)
8. Phase 2.4 Live Multi-Role Staging UAT Suite:          15 / 15 PASS   (100%)
----------------------------------------------------------------------------------------
TỔNG CỘNG:                                              255 / 255 PASS | 0 FAIL
Tỷ lệ thành công:                                        100.0%
Tác động đến PostgreSQL HR:                              ZERO (0 mutations, 0 writes)
========================================================================================
```

---

## 3. KẾT QUẢ NGHIỆM THU UAT TRẢI NGHIỆM NGƯỜI DÙNG (USER EXPERIENCE)

### 3.1. Tiếp nhận và Tiền xử lý Tệp Bảng tính
- **Hỗ trợ định dạng:** Đã nghiệm thu đầy đủ `.xlsx`, `.xls` và `.csv` với parser chuẩn RFC-4180 và tự động nhận diện dấu phân cách (`,`, `;`, `\t`, `|`).
- **Tệp nhiều Sheet:** Tự động nhận diện danh sách sheet, đặt sheet đầu tiên làm active sheet và cho phép truy vấn chính xác.
- **Làm sạch dữ liệu tự động:**
  - Tự động lọc bỏ các hàng hoàn toàn trống (`row_count` phản ánh đúng dữ liệu nghiệp vụ).
  - Loại bỏ các cột trống không tên hoặc chuẩn hóa tên cột tự động.
  - Xử lý tiêu đề trùng lặp: tự động bổ sung hậu tố `_2`, `_3` (ví dụ: `doanhso`, `doanhso_2`).
- **Chuẩn hóa ngày tháng độc lập Timezone:**
  - Hỗ trợ chuẩn xác `YYYY-MM-DD`, `DD/MM/YYYY`, `DD-MM-YYYY` và ISO-8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`).
  - Sử dụng hàm chuẩn hóa thuần toán học/chuỗi, ngăn chặn hoàn toàn lỗi lệch ngày do múi giờ UTC/GMT+7.
- **Xem trước dữ liệu (Data Preview):** Endpoint `GET /api/analytics/files/:fileId/preview` trả về chính xác 10 dòng đầu tiên đã được làm sạch và thoát ký tự an toàn.

### 3.2. Hỏi đáp Phân tích Tự nhiên bằng Tiếng Việt
- Người dùng chỉ cần gõ câu hỏi bằng ngôn ngữ tự nhiên:
  - *Tính toán và tổng hợp:* "Tổng doanh số theo phòng ban", "Trung bình lương theo chức danh".
  - *Lọc và điều kiện:* "Chỉ lấy phòng Kinh Doanh", "Doanh số lớn hơn 50 triệu".
  - *Thứ hạng và tỷ trọng:* "Top 5 khách hàng sản lượng cao nhất", "Tỷ trọng doanh số theo đơn vị".
  - *Xu hướng & chu kỳ:* "Biến động sản lượng theo tháng", "Tăng trưởng so với tháng trước".
- **Hỏi tiếp theo ngữ cảnh (Multi-turn Follow-up):** Hệ thống kế thừa Query Plan của lượt trước, bổ sung điều kiện lọc hoặc đổi chiều sắp xếp mà không làm mất ngữ cảnh tính toán trước đó.
- **Xử lý trạng thái rỗng (Empty State):** Khi bộ lọc dẫn đến kết quả 0 dòng, hệ thống trả về thông điệp thân thiện: `Không tìm thấy bản ghi nào phù hợp với điều kiện truy vấn...` kèm gợi ý nới lỏng điều kiện lọc, thay vì báo lỗi kỹ thuật hay làm gián đoạn hội thoại.

### 3.3. Trải nghiệm Giao diện General AI
- General AI tiếp tục là điểm chạm BI duy nhất.
- Khi người dùng tải tệp bảng tính lên trong chat, hệ thống hiển thị thông tin tệp kèm huy hiệu (pill) Dataset Đang Hoạt Động (`#activeDatasetBar`) với các thao tác:
  - `[✖ Hủy gắn]`: Rời khỏi dataset để quay về trò chuyện thông thường.
  - `[🗑 Xóa tệp]`: Xóa vĩnh viễn tệp và bộ nhớ đệm phân tích.
- Định dạng phản hồi trực quan: Kết hợp linh hoạt Thẻ chỉ số tổng hợp (KPI Cards), Bảng Markdown phân trang đẹp mắt và Đồ thị phản hồi nhanh (Bar / Line / Pie SVG) tạo ngay trong luồng chat.

---

## 4. QUẢN TRỊ DỮ LIỆU & VÒNG ĐỜI TỆP (DATA GOVERNANCE & FILE LIFECYCLE)

### 4.1. Ma trận Phân quyền & Sở hữu Tệp (RBAC & Multi-Tenant Isolation)

| Vai trò người dùng | Phạm vi tệp tự tải lên | Phạm vi tệp cùng công ty | Phạm vi tệp khác công ty | Quyền Xóa tệp |
| :--- | :---: | :---: | :---: | :---: |
| **ADMIN (Tập đoàn)** | Toàn quyền (View & Query) | Toàn quyền (View & Query) | Toàn quyền (View & Query) | Được xóa mọi tệp |
| **HR (Đơn vị)** | Toàn quyền (View & Query) | Toàn quyền (View & Query) | ⛔ Chặn tuyệt đối (IDOR Block 403) | Chỉ xóa tệp mình tải |
| **EMPLOYEE (Nhân viên)** | Toàn quyền (View & Query) | ⛔ Chặn mặc định (Cần được Share) | ⛔ Chặn tuyệt đối (IDOR Block 403) | Chỉ xóa tệp mình tải |
| **USER / GUEST** | ⛔ Chặn toàn bộ | ⛔ Chặn toàn bộ | ⛔ Chặn toàn bộ | ⛔ Không có quyền |

### 4.2. Quy trình Chia sẻ & Thu hồi Tức thì (Sharing & Instantaneous Revocation)
- **Cơ chế cấp quyền chia sẻ:**
  - Người sở hữu tệp (`uploaded_by`) hoặc ADMIN có thể chia sẻ tệp cho người dùng khác trong cùng đơn vị với 2 mức quyền:
    - `view`: Cho phép xem thông tin cấu trúc, danh sách cột và xem trước 10 dòng; **chặn tuyệt đối quyền chạy truy vấn tính toán (`query`) trả về mã 403 `INSUFFICIENT_PERMISSION`**.
    - `query`: Cho phép vừa xem cấu trúc vừa chạy phân tích, hỏi đáp tự nhiên trên dataset.
- **Thu hồi quyền tức thì (Instantaneous Revocation):**
  - Khi chủ sở hữu gọi `POST /api/analytics/files/:fileId/unshare`, quyền truy cập bị xóa ngay lập tức khỏi Registry trong RAM và đĩa.
  - Lượt truy vấn tiếp theo của người bị thu hồi bị từ chối ngay lập tức với HTTP 403 Forbidden.

### 4.3. Tự động Dọn dẹp & Quản lý Bộ nhớ (Automated Retention & Storage Hygiene)
- **Chính sách lưu giữ 7 ngày:**
  - Tệp tải lên tự động được ấn định hạn lưu giữ: `retention_expiry = now + 7 days`.
  - Cron job hàng ngày (`retentionService.js`) và chu kỳ khởi động tự động quét và xóa sạch cả tệp gốc lẫn tệp `.dataset.json`.
- **Dọn dẹp tệp mồ côi (Orphan Files):** Các tệp vật lý trong thư mục lưu trữ không có liên kết trong `datasets_registry.json` và tồn tại quá 10 phút sẽ được tự động xóa.
- **Xử lý tệp treo trạng thái (Stuck PROCESSING):** Các bản ghi dataset bị kẹt ở trạng thái `PROCESSING` quá 15 phút do lỗi mạng hoặc gián đoạn tiến trình sẽ được dọn dẹp an toàn.

### 4.4. Nhật ký Kiểm toán Không chứa Dữ liệu Nhạy cảm (Sanitized BI Audit Logging)
- Triển khai module chuyên trách `biAuditLogger.js` ghi vết độc lập vào `storage/bi_audit.log` và bảng cơ sở dữ liệu `auth_audit_logs`.
- Các sự kiện được kiểm toán đầy đủ:
  - `FILE_UPLOAD`: Ghi nhận người tải, kích thước, định dạng, số dòng.
  - `DATASET_QUERY` & `DATASET_ASK`: Ghi nhận kế hoạch truy vấn, số dòng trả về, thời gian thực thi (ms).
  - `DATASET_SHARE`: Ghi nhận người chia sẻ, người nhận, mức quyền (`view`/`query`).
  - `DATASET_REVOKE_SHARE`: Ghi nhận sự kiện thu hồi quyền.
  - `DATASET_DELETE`: Ghi nhận người xóa và thời điểm hủy tệp vật lý.
  - `RETENTION_PURGE`: Ghi nhận tệp bị xóa tự động theo hạn lưu giữ 7 ngày.
  - `ACCESS_DENIED`: Ghi nhận các nỗ lực vi phạm thẩm quyền (IDOR, truy vấn trái phép).
- **Bộ lọc làm sạch (Sanitization Filter):**
  - **TUYỆT ĐỐI KHÔNG** ghi lại bất kỳ dòng dữ liệu thô (`raw_rows`), nội dung ô tính (`cell_content`), thông tin cá nhân (CCCD, số điện thoại, email) hoặc token/mật khẩu vào log.

---

## 5. KẾT QUẢ KIỂM THỬ BẢO MẬT (SECURITY HARDENING)

| Vector tấn công | Phương pháp bảo vệ đã triển khai | Kết quả nghiệm thu |
| :--- | :--- | :---: |
| **IDOR / Cross-Tenant** | Kiểm tra ranh giới `company_id` giữa caller token và dataset owner; chặn người dùng công ty khác truy cập. | ✅ 100% BLOCKED (403) |
| **Path Traversal** | Chuẩn hóa tên tệp bằng `path.basename` và sinh UUID mới cho đường dẫn lưu trữ; loại bỏ `../`, `..\\`. | ✅ 100% SANITIZED |
| **Disguised Executable** | Kiểm tra Magic Bytes đầu tệp: chặn tệp Windows PE (`MZ...`) hoặc Linux ELF mang phần mở rộng `.xlsx` / `.csv`. | ✅ 100% BLOCKED |
| **ZIP Bomb / DoS** | Quét Central Directory header của XLSX; từ chối ngay lập tức nếu tỷ lệ nén vượt quá **25:1** hoặc dung lượng giải nén > 100MB. | ✅ 100% REJECTED |
| **Formula Injection (CSV/Excel DDE)** | Tự động thêm dấu nháy đơn (`'`) trước các ô bắt đầu bằng `=`, `+`, `-`, `@`, `\t`, `\r` để vô hiệu hóa thực thi mã lệnh phía client. | ✅ 100% SANITIZED |
| **Prompt Injection trong ô tính** | Dữ liệu ô tính được đóng gói thành Literal Data, không bao giờ đưa vào System Prompt chỉ dẫn của AI. | ✅ 100% NEUTRALIZED |
| **Tấn công cạn kiệt CPU** | Timeout guard cho mỗi truy vấn (mặc định 5000ms); vượt quá thời gian sẽ hủy truy vấn an toàn (HTTP 408). | ✅ 100% SAFE TIMEOUT |
| **Tấn công cạn kiệt RAM** | Giới hạn số nhóm tối đa (`max_groups = 5000`), kích thước tệp tối đa (25MB), số dòng tối đa (50.000 dòng). | ✅ 100% BOUNDED |
| **XSS qua Markdown** | Mã hóa an toàn các ký tự nhạy cảm, đặc biệt là ký tự `\|` trong bảng Markdown. | ✅ 100% ESCAPED |

---

## 6. ĐO LƯỜNG HIỆU NĂNG THỰC TẾ & ĐỊNH MỨC CHUYỂN ĐỔI KIẾN TRÚC

Đã thực hiện benchmark tải thực tế trên In-Memory Analytical Engine từ 1.000 đến 50.000 dòng dữ liệu bảng tính:

### 6.1. Bảng đo lường hiệu năng (Empirical Benchmark Table)

| Quy mô dữ liệu | Dung lượng XLSX | Thời gian Parse & Profile | Thời gian chạy Query | Mức chiếm dụng RAM (Heap Delta) | Đánh giá vận hành |
| :---: | :---: | :---: | :---: | :---: | :---: |
| **1.000 dòng** | 382 KB | 71 ms | **3 ms** | ~4 MB | ✅ Xuất sắc |
| **5.000 dòng** | 1.893 KB | 160 ms | **5 ms** | ~22 MB | ✅ Xuất sắc |
| **10.000 dòng** | 3.783 KB | 280 ms | **12 ms** | ~56 MB | ✅ Xuất sắc |
| **25.000 dòng** | 9.612 KB | 710 ms | **15 ms** | ~64 MB | ✅ Xuất sắc |
| **50.000 dòng** | 19.327 KB | 1.734 ms | **31 ms** | < 70 MB | ✅ Đạt chuẩn cao |

### 6.2. Kiểm thử Tải Đồng thời (Concurrency Capacity)
- Đã cấu hình và kiểm thử thành công cơ chế Semaphore `MAX_CONCURRENT_QUERIES = 10`.
- Chạy đồng thời 10 truy vấn phân tích song song: **10 / 10 truy vấn hoàn thành thành công trong dưới 80ms**.
- Bộ đếm truy vấn đồng thời (`activeConcurrentQueries`) được giải phóng sạch sẽ về 0 ngay khi truy vấn kết thúc (kể cả khi xảy ra lỗi).
- Khi vượt quá 10 truy vấn đồng thời, hệ thống trả về mã HTTP 429 `CONCURRENCY_LIMIT_EXCEEDED` để bảo vệ tài nguyên máy chủ.

### 6.3. Ngưỡng Chuyển đổi Kiến trúc sang DuckDB / Parquet
Dựa trên kết quả đo lường thực nghiệm:
1. **Vùng tối ưu của In-Memory Engine hiện tại:**
   - Số dòng: **$\le$ 50.000 dòng**.
   - Dung lượng tệp: **$\le$ 25 MB**.
   - Thời gian phản hồi: **< 50ms cho các truy vấn tổng hợp thông thường**.
   - Mức tiêu hao RAM: Hoàn toàn ổn định trong giới hạn container 512MB - 1GB.
2. **Điều kiện kích hoạt chuyển đổi sang DuckDB / Parquet (Phase tiếp theo):**
   - Khi có yêu cầu phân tích các tệp bảng tính có quy mô **vượt quá 50.000 dòng** hoặc dung lượng **lớn hơn 25 MB**.
   - Khi xuất hiện bài toán **JOIN dữ liệu chéo giữa nhiều tệp bảng tính** hoặc giữa tệp tải lên với kho dữ liệu lớn.

---

## 7. ĐIỀU KIỆN TIÊN QUYẾT TRƯỚC KHI LÊN PRODUCTION (OPERATIONAL POOL HARDENING)

### 7.1. Hiện trạng trên Cơ sở dữ liệu Staging
Qua kiểm tra trực tiếp danh mục roles của PostgreSQL Staging:
```sql
SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin 
FROM pg_roles 
WHERE rolname IN ('staging_admin', 'staging_readonly');
```
Kết quả ghi nhận:
- `staging_readonly`: `rolsuper = false`, `rolinherit = false`, `rolcreaterole = false`, `rolcreatedb = false` (Đạt chuẩn Least Privilege tuyệt đối cho BI).
- `staging_admin`: **`rolsuper = true`**, `rolcreaterole = true`, `rolcreatedb = true`.

### 7.2. Yêu cầu Tiên quyết đối với Đội ngũ DBA/DevOps trước khi Go-Live Production
> [!WARNING]
> Tài khoản kết nối cơ sở dữ liệu vận hành (`staging_admin` trên Staging / `prod_app_user` trên Production) **TUYỆT ĐỐI KHÔNG ĐƯỢC MANG QUYỀN SUPERUSER** khi đưa lên môi trường Production.
> 
> Trước khi triển khai Go-Live Production, DBA cần thực thi kịch bản chuẩn hóa Least Privilege cho tài khoản ứng dụng:
> ```sql
> -- Chuẩn hóa tài khoản kết nối ứng dụng vận hành trước khi Go-Live
> ALTER ROLE prod_app_user NOSUPERUSER NOCREATEDB NOCREATEROLE;
> ```
> *(Trong suốt quá trình Phase 2.4, mã nguồn và kịch bản kiểm thử tuyệt đối tuân thủ chỉ dẫn: không can thiệp, không chạy lệnh ALTER ROLE làm biến động quyền hạn database).*

---

## 8. KẾT LUẬN & BÀN GIAO CHUYỂN GIAO (HANDOVER)

1. **Giai đoạn Phase 2 (Phase 2.1, 2.2, 2.3 và 2.4) đã hoàn thành xuất sắc toàn bộ mục tiêu.**
2. **Tổng hợp năng lực hệ thống đã sẵn sàng:**
   - Hệ thống BI Báo cáo Nhân sự từ Cơ sở dữ liệu (Phase 1.4) hoạt động an toàn qua tài khoản read-only.
   - Hệ thống Phân tích Dữ liệu Bảng tính Tải lên độc lập (Phase 2) hoạt động mượt mà ngay trong General AI.
   - Đảm bảo 100% tính biệt lập: Dữ liệu tải lên hoàn toàn không xâm lấn hay ghi đè vào database PostgreSQL HR.
   - Giao diện General AI hỗ trợ tương tác tự nhiên, vẽ biểu đồ SVG tức thì, chuyển đổi và quản trị dataset rõ ràng.
3. **Quyết định:**
   - **XÁC NHẬN NGHIỆM THU PHASE 2.4 — THÀNH CÔNG.**
   - **TRẠNG THÁI TOÀN HỆ THỐNG: CHÍNH THỨC SẴN SÀNG CHO ĐÁNH GIÁ GO-LIVE (READY FOR PRODUCTION READINESS REVIEW).**
