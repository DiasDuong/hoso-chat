# SOTRANS HUB — HR EMPLOYEE LIFECYCLE WORKFLOW
## HƯỚNG DẪN IMPORT, CẤU HÌNH VÀ BÀN GIAO TRIỂN KHAI CHO QUẢN LÝ

> **Tài liệu bàn giao kỹ thuật:** Quy trình Tiếp nhận Hồ sơ Nhân sự SOTRANS (SOTRANS Hub Employee Lifecycle)  
> **Phiên bản:** Phase 1.2 Streamlined & Portable Architecture  
> **Ngày lập:** 12/11/2026  
> **Môi trường gốc:** SOTRANS Hub Local/Staging Stack (n8n v2.41.6, Node.js v20, Postgres 16)

---

## 1. TỔNG QUAN GÓI BÀN GIAO

Thư mục bàn giao `exports/hr-employee-lifecycle-audit/` bao gồm 3 tệp chính:

1. **`SOTRANS_HR_EMPLOYEE_LIFECYCLE_LIVE_RAW.json`**
   - **Mô tả:** Bản export nguyên trạng từ container n8n đang hoạt động (`hrbot-n8n-1`), gồm 33 nodes.
   - **Đặc điểm:** Sử dụng các endpoint phân mảnh riêng lẻ (`/validate-token`, `/normalize-canonical-fields`, `/validate-duplicates`, `/persist-staging`). Chứa mã bí mật nội bộ thực tế của môi trường hiện tại. Dùng làm dữ liệu đối chiếu lịch sử (AS-IS).

2. **`SOTRANS_HR_EMPLOYEE_LIFECYCLE_PHASE1_2_PORTABLE.json` (KHUYẾN NGHỊ SỬ DỤNG ĐỂ GHÉP VÀO HỆ THỐNG MỚI)**
   - **Mô tả:** Bản workflow đã được chuẩn hóa kiến trúc Phase 1.2 gồm 34 nodes.
   - **Đặc điểm:** Đã hợp nhất các lời gọi backend phân tán thành một cổng duy nhất (`POST /api/hoso/intake/internal/process-staged-candidate`) kèm các chốt chặn fail-closed (`IF OCR Valid?`, `IF Ingestion Valid?`).
   - **Tính an toàn (Zero Secrets):** Toàn bộ token bí mật nội bộ, khóa API, URL dịch vụ nội bộ đã được tham số hóa thành biến môi trường n8n (`$env`) và placeholder `REPLACE_WITH_INTERNAL_SECRET`. Sẵn sàng để import vào bất kỳ cụm n8n nào mà không lo lộ lọt khóa hoặc phụ thuộc cứng vào mạng nội bộ cũ.

3. **`README_DEPLOYMENT_GUIDE.md`**
   - Tài liệu hướng dẫn này.

---

## 2. YÊU CẦU HỆ THỐNG VÀ TIỀN ĐỀ KỸ THUẬT

Để workflow hoạt động ổn định khi ghép vào hệ thống n8n đích, hệ sinh thái cần đáp ứng:

| Thành phần | Phiên bản khuyến nghị | Yêu cầu cấu hình bắt buộc |
| :--- | :--- | :--- |
| **n8n Engine** | `2.41.6` (hoặc `1.x` - `2.x`) | `N8N_DEFAULT_BINARY_DATA_MODE=separate`<br>`EXECUTIONS_TIMEOUT=120` |
| **Node.js** | `>= 20.x` | Môi trường container hoặc máy chủ n8n |
| **Auth Service** | `auth-service` (SOTRANS Hub) | Hỗ trợ endpoint `/api/hoso/intake/internal/process-staged-candidate` |
| **Database** | PostgreSQL 16 | Chứa bảng `hr_employee_staging`, `hr_intake_batches`, sequence mã nhân viên |
| **Mạng (Network)** | DNS / Docker Network | Container n8n phải gọi được internet (Google Gemini) và `auth-service` |

---

## 3. CÁC BIẾN MÔI TRƯỜNG CẦN THIẾT LẬP

Trước khi kích hoạt workflow trên n8n đích, vui lòng khai báo các biến môi trường sau cho n8n (hoặc tệp `.env` của n8n container):

```bash
# 1. Khóa bí mật giao tiếp nội bộ giữa Backend và n8n (x-internal-secret)
N8N_INTERNAL_SECRET=sotrans_hub_internal_secret_key_change_me_2026

# 2. Địa chỉ nội bộ của auth-service mà n8n có thể kết nối
# Ví dụ: http://hr-auth:3000 (nếu chung docker network) hoặc http://localhost:3000
AUTH_SERVICE_INTERNAL_URL=http://hr-auth:3000

# 3. Chế độ xử lý binary data (bắt buộc để upload file 25MB không bị tràn RAM)
N8N_DEFAULT_BINARY_DATA_MODE=separate
```

---

## 4. HƯỚNG DẪN CẤU HÌNH CREDENTIALS TRÊN N8N

Workflow sử dụng HTTP Request để gọi trực tiếp Google Gemini Vision API. Bạn cần tạo một Credential trên n8n như sau:

1. Đăng nhập giao diện n8n: Vào **Credentials** -> **Add Credential**.
2. Chọn loại: **Header Auth** (hoặc `httpHeaderAuth`).
3. Đặt tên Credential: `Gemini Header`.
4. Điền các trường:
   - **Name:** `x-goog-api-key`
   - **Value:** `<ĐIỀN_GOOGLE_GEMINI_API_KEY_CỦA_BẠN>`
5. Nhấn **Save**.
6. Sau khi import workflow:
   - Mở node **`OCR - Gemini Extraction`**.
   - Tại mục **Credential to connect with**, chọn đúng `Gemini Header` vừa tạo.

---

## 5. HƯỚNG DẪN IMPORT WORKFLOW

### Cách 1: Import qua Giao diện Web n8n (Khuyến nghị cho Quản lý)
1. Mở trang quản trị n8n: `https://<your-n8n-domain>/workflows`.
2. Nhấn nút dấu ba chấm (`...`) ở góc trên bên phải màn hình -> Chọn **Import from File**.
3. Chọn tệp: `exports/hr-employee-lifecycle-audit/SOTRANS_HR_EMPLOYEE_LIFECYCLE_PHASE1_2_PORTABLE.json`.
4. Kiểm tra các node:
   - Node **`OCR - Gemini Extraction`**: Kiểm tra đã gắn Credential `Gemini Header`.
   - Node **`Authorize & Normalize Event`**: Kiểm tra secret khớp với `N8N_INTERNAL_SECRET`.
5. Bật trạng thái workflow sang **Active** (gạt công tắc góc trên bên phải).

### Cách 2: Import qua n8n CLI (Trong Container)
```bash
docker cp exports/hr-employee-lifecycle-audit/SOTRANS_HR_EMPLOYEE_LIFECYCLE_PHASE1_2_PORTABLE.json <n8n-container-name>:/tmp/workflow.json
docker exec -it <n8n-container-name> n8n import:workflow --input=/tmp/workflow.json
```

---

## 6. DANH SÁCH WEBHOOK ENDPOINT ĐƯỢC MỞ

Sau khi workflow được kích hoạt, n8n sẽ lắng nghe trên 4 Webhook:

| Webhook Name | Đường dẫn Path | Phương thức | Chức năng |
| :--- | :--- | :--- | :--- |
| **Trigger Master Lifecycle** | `/webhook/hr-employee-lifecycle` | `POST` | Cổng điều phối đa sự kiện (`HR_UPLOAD`, `HR_APPROVAL`, `HR_RETRY_SYNC`) |
| **Trigger HR_UPLOAD** | `/webhook/hr-lifecycle-upload` | `POST` | Tiếp nhận trực tiếp file upload hồ sơ từ Frontend/Backend Proxy |
| **Trigger HR_APPROVAL** | `/webhook/hr-lifecycle-approval` | `POST` | Callback khi phê duyệt hồ sơ (ghi audit log, thông báo) |
| **Trigger HR_RETRY_SYNC** | `/webhook/hr-lifecycle-sync` | `POST` | Retry đồng bộ tuần tự dữ liệu sang NocoDB / Google Sheets |

---

## 7. KIỂM THỬ XÁC MINH SAU KHI DEPLOY (SMOKE TEST)

### Bước 1: Kiểm tra tính năng xác thực bí mật (Fail-Closed)
Gửi yêu cầu không có secret hoặc sai secret đến webhook:
```bash
curl -X POST http://<n8n-host>:5678/webhook/hr-employee-lifecycle \
  -H "Content-Type: application/json" \
  -d '{"event_type": "HR_UPLOAD", "secret": "wrong_secret"}'
```
*Kết quả kỳ vọng:* HTTP 401 Unauthorized (`{"success":false,"error":"401 Unauthorized: Invalid or missing internal secret."}`).

### Bước 2: Kiểm tra tiếp nhận Batch có secret hợp lệ
```bash
curl -X POST http://<n8n-host>:5678/webhook/hr-employee-lifecycle \
  -H "Content-Type: application/json" \
  -H "x-internal-secret: <N8N_INTERNAL_SECRET>" \
  -d '{"event_type": "UNKNOWN_ACTION", "secret": "<N8N_INTERNAL_SECRET>"}'
```
*Kết quả kỳ vọng:* HTTP 400 Bad Request (`"Unsupported or missing lifecycle event_type"`).

---

## 8. CÁC QUY TẮC AN TOÀN VÀ RANH GIỚI BẮT BUỘC (KIẾN TRÚC TO-BE)

Khi ghép workflow này vào hệ thống của quản lý, vui lòng lưu ý các ranh giới kiến trúc cốt lõi đã được kiểm định:

1. **OCR và Trích xuất AI (Thuộc về n8n):**
   - n8n đảm nhiệm chuyển đổi tài liệu, trích xuất hình ảnh/PDF, gọi Gemini Vision và tiền phân loại tài liệu. Điều này giúp backend không phải chịu tải nặng xử lý file và AI.
2. **Xác thực DB, Chống trùng lặp, Cấp mã nhân viên, Phê duyệt (BẮT BUỘC giữ ở Backend):**
   - **Tuyệt đối không chuyển logic sinh mã nhân viên (`seq_emp_code_stl`, `seq_emp_code_vtx`, `seq_emp_code_swc`) lên n8n**. Cấp mã nhân viên đòi hỏi Transaction Advisory Lock trong PostgreSQL để chống nhảy số hoặc trùng số khi nhiều HR cùng bấm duyệt.
   - **Tuyệt đối không chuyển quyền Phê duyệt (`hr.intake.approve` vs `hr.intake.submit`) lên n8n**. Backend bắt buộc kiểm tra chữ ký JWT, kiểm tra phân quyền và đảm bảo Tenant Isolation (nhân viên STL không được xem/duyệt hồ sơ của VTX hay SWC).
   - **Lưu trữ Staging**: n8n gọi endpoint `/api/hoso/intake/internal/process-staged-candidate` để backend thực hiện chuẩn hóa 53 trường và lưu vào `hr_employee_staging` dưới một transaction an toàn.
