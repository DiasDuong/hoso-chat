# DANH SÁCH GIỚI HẠN ĐÃ BIẾT VÀ KHUYẾN NGHỊ VẬN HÀNH
## GENERALAI × BI × WRENAI FORK
**Mã tài liệu:** `DOC-BI-LIMIT-07`  
**Phiên bản:** 2.0.0 (Đã đối soát giới hạn hệ thống thực tế)  
**Trạng thái:** ACCEPTED / DOCUMENTED  
**Ngày cập nhật:** 18/11/2026  
**Commit Baseline:** `dbed29a187b09a7b8eac09b6b65c10ae408053c1` (`main`)

---

## 1. GIỚI HẠN DỮ LIỆU NGUỒN VÀ TRẠNG THÁI `DATA_UNAVAILABLE`

### 1.1. Hiện tượng Kỹ thuật và Kiểm toán Mã nguồn
Trong quá trình kiểm thử bộ `tests/test_bi_dashboard_contract.js` và `tests/test_bi_release_foundation.js`, hệ thống có các kịch bản trả về trạng thái chuẩn hóa `DATA_UNAVAILABLE` hoặc `BLOCKED`:
1. `FILE_DISTINCT_HEADCOUNT`: Khi bảng tính tải lên thiếu cột định danh nhân sự duy nhất (như CCCD, Mã NV, hoặc UUID), hệ thống không thể tính toán `DISTINCT_COUNT` mà chỉ trả về `COUNT(*)` số dòng. Thẻ KPI tương ứng chuyển sang trạng thái `DATA_UNAVAILABLE`.
2. `LEGACY_GROUPED_AVG`: Khi người dùng yêu cầu tính trung bình nhóm theo phân loại dữ liệu cũ nhưng tập dữ liệu không có sẵn cột tổng hợp tóm tắt (summary column), hệ thống trả về `DATA_UNAVAILABLE` kèm lý do giải thích thay vì lấy trung bình cộng của các giá trị đã làm tròn.
3. `BLOCKED_KPI`: Khi người dùng thuộc vai trò `USER` hoặc nhân viên yêu cầu xem các chỉ số nhạy cảm (như tổng quỹ lương hoặc lương chi tiết) mà quyền truy cập bị giới hạn bởi RBAC, thẻ KPI giữ trạng thái `BLOCKED` với giá trị `primary_value: null` và lý do: `"Bạn không có quyền truy cập chỉ số này"`.

### 1.2. Tính Toàn Vẹn Dữ Liệu (Zero Hallucination Policy)
- Trong các ứng dụng phân tích số liệu tài chính và nhân sự doanh nghiệp, việc mô hình AI tự tiện đoán định hoặc gán giá trị giả tạo (như số 0 hoặc số ngẫu nhiên) khi thiếu dữ liệu nguồn là vi phạm nghiêm trọng nguyên tắc trung thực dữ liệu.
- Ràng buộc hợp đồng dữ liệu trong `biDashboardSchemaValidator.js` (Hàm `assertValidDashboardPayload`):
  - Bắt buộc `primary_value` phải là `null` đối với KPI có trạng thái `BLOCKED` hoặc `DATA_UNAVAILABLE`. Nếu xuất hiện bất kỳ giá trị số nào, hệ thống sẽ ném lỗi `FORBIDDEN_FAKE_VALUE`.
  - Bắt buộc phải có chuỗi ký tự giải thích (`subtext`) để người dùng hiểu rõ nguyên nhân.
- **Kế hoạch mở rộng tương lai:** Bổ sung giao diện UI Mapping Wizard cho phép người dùng chỉ định thủ công cột nào là "Mã định danh duy nhất" khi tải lên các file Excel có cấu trúc bất quy tắc.

### 1.3. Trạng thái UNVERIFIED của 3 KPI Đo lường Vận hành Tiếp nhận
Hệ thống xác định 3 chỉ số KPI chuyên sâu về giám sát quy trình tiếp nhận và chính sách hiện đang ở trạng thái `BLOCKED` và được phân loại kỹ thuật là **UNVERIFIED**:
1. **`INTAKE_FAILURE` (Tỷ lệ tiếp nhận lỗi):** `BLOCKED` / `UNVERIFIED`. Gateway Staging hiện tại chưa ghi log phân loại lỗi tiếp nhận vào bảng CSDL độc lập để truy vấn; thiếu dữ liệu log telemetry.
2. **`INTAKE_DURATION` (Thời lượng xử lý hồ sơ trung bình):** `BLOCKED` / `UNVERIFIED`. Trong schema bảng `hr_intake_batches` hiện hành, giá trị `created_at` bằng `updated_at` và chưa có cột mốc `completed_at` để tính toán chính xác khoảng thời gian hoàn tất.
3. **`POLICY_CONFLICT` (Tỷ lệ xung đột chính sách hồ sơ):** `BLOCKED` / `UNVERIFIED`. Module Policy Conflict Detector hiện hoạt động in-memory trong middleware thẩm định, chưa lưu vết phân loại xung đột vào bảng tĩnh CSDL.

*Khuyến nghị giải pháp:* Để đưa 3 KPI này lên trạng thái `AVAILABLE`, cần thực hiện migration bổ sung cột `completed_at` cho `hr_intake_batches`, thiết kế bảng `hr_policy_conflicts` và cấu hình module gateway telemetry đẩy log vào CSDL trong các chu kỳ phát triển tiếp theo.

---

## 2. GIỚI HẠN TỆP BẢNG TÍNH VÀ LƯU TRỮ

| Tham số | Giá trị Giới hạn Thực tế | Căn cứ Cấu hình Mã nguồn | Tác động Kỹ thuật & Khuyến nghị |
|:---|:---:|:---|:---|
| **Dung lượng file tối đa** | `25 MB` | `MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024`<br>(`biFileSecurityService.js`) | Tránh tràn bộ nhớ đệm (Node.js Heap OOM) khi phân tích bảng tính. File > 25MB bị từ chối với HTTP 413. |
| **Dung lượng nén ZIP tối đa** | `100 MB` | `MAX_UNCOMPRESSED_ZIP_BYTES`<br>(`biFileSecurityService.js`) | Phòng chống tấn công từ chối dịch vụ dạng ZIP Bomb. |
| **Tỷ lệ nén tối đa** | `25:1` | `MAX_ZIP_RATIO` | Chặn các file bảng tính nén bất thường có tỷ lệ giãn nở cao. |
| **Định dạng hỗ trợ** | `.xlsx`, `.xls`, `.csv` | `ALLOWED_EXTENSIONS` | Kiểm tra Magic Byte. Không hỗ trợ file bảng tính có đặt mật khẩu bảo vệ. |
| **Vòng đời lưu trữ tạm thời** | `7 ngày` | `DEFAULT_RETENTION_DAYS = 7` | Dữ liệu bảng tính sau 7 ngày sẽ tự động bị từ chối truy vấn và dọn dẹp để giải phóng dung lượng đĩa. |

---

## 3. GIỚI HẠN NGỮ CẢNH HỘI THOẠI VÀ XUẤT BÁO CÁO

- **Độ sâu ngữ cảnh hội thoại (Multi-turn depth):** Tối đa 10 lượt tương tác liên tiếp trong cùng một phiên chat (`conversationReferenceResolver.js`). Sau 10 lượt, hệ thống thực hiện tóm tắt ngữ cảnh để tiết kiệm token và đảm bảo tốc độ phản hồi.
- **Phạm vi xuất báo cáo:**
  - Định dạng Excel (`.xlsx`): Được sinh và tải về trực tiếp từ API backend `POST /api/analytics/export` với token HMAC có thời hạn 1 giờ.
  - Định dạng PDF: Được hỗ trợ thông qua cơ chế in phía trình duyệt (`window.print()` trong `chat/bi-dashboard.js`). Hệ thống không triển khai headless browser render PDF trên máy chủ backend để tránh tiêu tốn tài nguyên CPU/RAM.

---

## 4. GIỚI HẠN TẢI ĐỒNG THỜI VÀ MÔ HÌNH SIDECAR

- **Thời gian timeout truy vấn SQL:** Mặc định là `5.000 ms`. Nếu câu truy vấn quét bảng dữ liệu vượt quá 5 giây, kết nối sẽ bị ngắt để bảo vệ tài nguyên cơ sở dữ liệu.
- **Khả năng tải đồng thời (Concurrency Capacity):**
  - Cấu hình Sidecar đơn container hiện tại hỗ trợ tối đa khoảng **50 truy vấn BI đồng thời** với độ trễ phản hồi bình quân `< 200 ms`.
  - Trong trường hợp mở rộng quy mô lớn (> 100 QPS), cần nhân bản Sidecar WrenAI theo cơ chế Pod Horizontal Replicas kết hợp bộ cân bằng tải.
