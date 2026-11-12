# SOTRANS HUB — PRODUCTION TEST DATA INVENTORY & CLASSIFICATION
## Mã công việc: PROD-TEST-DATA-CLEANUP-01

**Ngày kiểm kê:** 30/10/2026  
**Dự án:** `D:\hoso-chat`  
**Cơ sở dữ liệu:** PostgreSQL 16 `hrbot` (Port: 5432, User: `hrbot`)  
**Bản sao lưu kiểm chứng:** `backups/prod_test_data_cleanup_01/hrbot_pre_cleanup_backup.sql` (77,643,526 bytes, SHA-256: `3f7df692df0baa466f36e49cbfe1386c1dce2ffdab24301d90c0c3c7371cd12f`)

---

## 1. NGUYÊN TẮC PHÂN LOẠI DỮ LIỆU

Mọi bản ghi và tài nguyên trên hệ thống được thẩm tra và phân loại thành 5 nhóm:

1. **`CONFIRMED_TEST_DATA`**: Dữ liệu có bằng chứng nguồn gốc phát sinh 100% từ các ca kiểm thử tự động, UAT, smoke test, hoặc kịch bản giả lập (Đủ điều kiện xóa có kiểm soát).
2. **`PRODUCTION_BUSINESS_DATA`**: Dữ liệu nghiệp vụ thật của doanh nghiệp (nhân sự, hồ sơ lương, tài liệu chính sách, báo cáo người dùng) — **Bảo toàn tuyệt đối**.
3. **`SYSTEM_CONFIGURATION`**: Cấu hình hệ thống, bảng danh mục công ty, vai trò phân quyền RBAC — **Bảo toàn tuyệt đối**.
4. **`AUDIT_REQUIRES_RETENTION`**: Lịch sử kiểm toán, log phê duyệt, vết tiếp nhận staging cần lưu trữ phục vụ truy vết pháp lý — **Bảo toàn tuyệt đối**.
5. **`REQUIRES_MANUAL_REVIEW`**: Dữ liệu có tính lịch sử phức tạp hoặc không đủ bằng chứng kết luận là test data thuần túy — **Không xóa tự động, lập hồ sơ báo cáo thủ công**.

---

## 2. BẢNG KIỂM KÊ TOÀN DIỆN CÁC NHÓM DỮ LIỆU TRÊN POSTGRESQL (`hrbot`)

| Nhóm / Tên Bảng | Tổng bản ghi | Phân loại | Căn cứ xác định & Nguồn gốc | Hành động dự kiến |
| :--- | :---: | :--- | :--- | :--- |
| **`employees`** | 5 | `PRODUCTION_BUSINESS_DATA` | 5 nhân sự cơ sở (`STL00014`, `SWC00022`, `SWC00023`, `SWC00024`, `SWC00025`). | **GIỮ NGUYÊN (100%)** |
| **`hr_employee_profiles`** | 5 | `PRODUCTION_BUSINESS_DATA` | 5 hồ sơ chi tiết 53 trường tương ứng 5 nhân sự cơ sở. | **GIỮ NGUYÊN (100%)** |
| **`companies`** | 3 | `SYSTEM_CONFIGURATION` | 3 đơn vị thành viên: `STL`, `SWC`, `VTX`. | **GIỮ NGUYÊN (100%)** |
| **`users`** | 14 | `SYSTEM_CONFIGURATION` | 14 tài khoản người dùng và quản trị viên đang hoạt động. | **GIỮ NGUYÊN (100%)** |
| **`role_permissions`** | 32 | `SYSTEM_CONFIGURATION` | 32 quyền hạn RBAC quản trị hệ thống. | **GIỮ NGUYÊN (100%)** |
| **`documents`** | 19 | `PRODUCTION_BUSINESS_DATA` | 19 văn bản chính sách, quy chế khen thưởng, thỏa ước lao động thật. | **GIỮ NGUYÊN (100%)** |
| **`chunks`** | 100 | `PRODUCTION_BUSINESS_DATA` | 100 đoạn phân tích vector tương ứng 19 văn bản chính sách. | **GIỮ NGUYÊN (100%)** |
| **`document_audit_logs`** | 47 | `AUDIT_REQUIRES_RETENTION` | Lịch sử tải lên, thẩm định và phê duyệt tài liệu chính sách. | **GIỮ NGUYÊN (100%)** |
| **`employee_hard_delete_requests`** | 1 | `CONFIRMED_TEST_DATA` | `REQ-HD-20261030-B38E` (Lý do: Non-destructive E2E UI Test, Status: CANCELLED). | **XÓA CÓ KIỂM SOÁT** |
| **`employee_hard_delete_manifests`** | 1 | `CONFIRMED_TEST_DATA` | Bảng kê phạm vi băm SHA-256 thuộc `REQ-HD-20261030-B38E`. | **XÓA CÓ KIỂM SOÁT** |
| **`employee_hard_delete_audit`** | 2 | `CONFIRMED_TEST_DATA` | 2 sự kiện kiểm toán (`REQUEST_CREATED`, `REQUEST_CANCELLED`) của yêu cầu test. | **XÓA CÓ KIỂM SOÁT** |
| **`employee_hard_delete_approvals`** | 0 | `CONFIRMED_TEST_DATA` | 0 bản ghi (Đã giải phóng trong test suite). | Không có dữ liệu |
| **`employee_hard_delete_executions`**| 0 | `CONFIRMED_TEST_DATA` | 0 bản ghi (Chưa từng thực thi xóa vật lý trên Prod). | Không có dữ liệu |
| **`employee_hard_delete_outbox`** | 0 | `CONFIRMED_TEST_DATA` | 0 bản ghi (Hàng đợi outbox sạch). | Không có dữ liệu |
| **`employee_hard_delete_tombstones`**| 0 | `CONFIRMED_TEST_DATA` | 0 bản ghi. | Không có dữ liệu |
| **`employee_retention_policies`** | 0 | `SYSTEM_CONFIGURATION` | 0 bản ghi (Chờ Ban Pháp chế/Nhân sự phê duyệt chính thức). | Không có dữ liệu |
| **`hr_sync_tasks`** (Baseline) | 4 | `PRODUCTION_BUSINESS_DATA` | 4 tác vụ đồng bộ cho nhân viên `STL00014` (`SOFT_DELETE`, `RESTORE`). | **GIỮ NGUYÊN (100%)** |
| **`hr_sync_tasks`** (Staging) | 18 | `PRODUCTION_BUSINESS_DATA` | 18 tác vụ đồng bộ upsert từ các đợt duyệt staging hồ sơ. | **GIỮ NGUYÊN (100%)** |
| **`hr_sync_tasks`** (Orphan Test)| 78 | `CONFIRMED_TEST_DATA` | 78 tác vụ mồ côi tham chiếu nhân sự test đã bị xóa (`TST-DEL-01`, `STL-1029`,...). | **XÓA CÓ KIỂM SOÁT** |
| **`hr_employee_staging`** (Approved)| 5 | `AUDIT_REQUIRES_RETENTION` | 5 hồ sơ staging được duyệt tạo nên 5 nhân sự cơ sở. | **GIỮ NGUYÊN (100%)** |
| **`hr_employee_staging`** (Rejected)| 5 | `AUDIT_REQUIRES_RETENTION` | 5 hồ sơ staging bị từ chối do mismatch công ty trong các đợt intake. | **GIỮ NGUYÊN (100%)** |
| **`hr_employee_staging`** (Legacy)  | 4 | `REQUIRES_MANUAL_REVIEW` | 4 hồ sơ staging ngày 28/10 lưu mã CCCD tạm thời. | **GIỮ NGUYÊN (100%)** |
| **`user_agents`** (Business) | 3 | `PRODUCTION_BUSINESS_DATA` | 3 Agent do người dùng tạo (`Email-Assistant`, 2 `Excel-Data-Pro`). | **GIỮ NGUYÊN (100%)** |
| **`user_agents`** (Test Duplicates)| 4 | `CONFIRMED_TEST_DATA` | 4 bản copy `Logistics Calculator Pro` do script UAT sinh ngày 30/10. | **XÓA 3 BẢN TRÙNG, GIỮ 1 BẢN GỐC** |
| **`user_agent_versions`** | 9 | Hỗn hợp (4 test / 5 thật) | Các phiên bản cấu hình prompt của Agent. | **XÓA CÁC VERSION THUỘC AGENT TEST** |
| **`agent_output_files`** | 4 | `PRODUCTION_BUSINESS_DATA` | 4 tệp báo cáo Excel do `emp_stl` sinh từ Personal Agent. | **GIỮ NGUYÊN (100%)** |
| **`ai_attachments`** (Fixtures) | 6 | `CONFIRMED_TEST_DATA` | 6 tệp fixture test (`fixture_sotrans_sop.docx`, `fixture_multi_sheet_4q.xlsx`). | **XÓA CÓ KIỂM SOÁT** |
| **`ai_attachments`** (Business) | 36 | `PRODUCTION_BUSINESS_DATA` | 36 tệp đính kèm do người dùng tải lên trong các hội thoại nghiệp vụ. | **GIỮ NGUYÊN (100%)** |
| **`ai_conversations`** (Test) | 18 | `CONFIRMED_TEST_DATA` | 6 hội thoại `Test Conversation BIZ-04` + 12 hội thoại automated smoke tests 30/10. | **XÓA CÓ KIỂM SOÁT** |
| **`ai_conversations`** (Business)| 310 | `PRODUCTION_BUSINESS_DATA` | 310 hội thoại của nhân viên thực tế từ 18/10 đến nay. | **GIỮ NGUYÊN (100%)** |
| **`ai_messages`** (Test) | ~110 | `CONFIRMED_TEST_DATA` | Toàn bộ tin nhắn thuộc 18 hội thoại test nêu trên. | **XÓA CÓ KIỂM SOÁT** |
| **`chat_conversation_files`** (Test)| 18 | `CONFIRMED_TEST_DATA` | 18 tệp markdown snapshot tương ứng 18 hội thoại test. | **XÓA CÓ KIỂM SOÁT** |
| **`chat_log`** | 3033 | `AUDIT_REQUIRES_RETENTION` | Nhật ký hỏi đáp Chatbot thực tế của toàn bộ hệ thống. | **GIỮ NGUYÊN (100%)** |
| **`auth_audit_logs`** | 3337 | `AUDIT_REQUIRES_RETENTION` | Nhật ký bảo mật đăng nhập và phân quyền JWT. | **GIỮ NGUYÊN (100%)** |
| **`admin_actions`** | 52 | `AUDIT_REQUIRES_RETENTION` | Nhật ký thao tác của quản trị viên. | **GIỮ NGUYÊN (100%)** |

---

## 3. KIỂM KÊ HỆ THỐNG NGOẠI VI & FILE VẬT LÝ

### A. Google Sheets (`1q_Sv9-p-pa5_yzoMSlbJfwz5vNqEhFFBaBhC3f0U6YI`)
- **Tổng số dòng:** 7 dòng (1 Dòng tiêu đề + 6 Dòng dữ liệu).
- **Dòng 2 đến 6:** 5 nhân sự cơ sở (`STL00014`, `SWC00024`, `SWC00022`, `SWC00023`, `SWC00025`) -> `PRODUCTION_BUSINESS_DATA` (**Bảo toàn 100%**).
- **Dòng 7:** `SWC00021` — `NGUYỄN VĂN HIẾU` -> `REQUIRES_MANUAL_REVIEW`.
  - *Căn cứ lịch sử:* `SWC00021` đã được xóa vật lý trên PostgreSQL `hrbot` theo lệnh công việc số 9 ("hard delete Nguyễn Văn Hiếu"), do đó cơ sở dữ liệu `hrbot` có 5 nhân sự trong khi Google Sheets còn lưu dòng 7. 
  - *Kết luận:* Không tự ý xóa dòng này để bảo đảm minh bạch và khớp với yêu cầu Mục XII của chỉ thị.

### B. NocoDB (`http://127.0.0.1:8081`)
- NocoDB kết nối trực tiếp vào PostgreSQL `hrbot` như nguồn dữ liệu gốc (System of Record).
- Mọi dữ liệu dọn dẹp trên `hrbot` sẽ lập tức đồng bộ 1:1 trên giao diện NocoDB.

### C. Vector Database Qdrant (`http://127.0.0.1:6333`)
- **Collection:** `hr_docs`.
- **Số lượng vectors:** Đúng 100 vectors, tương ứng chính xác 100 chunks của 19 văn bản chính sách doanh nghiệp.
- **Dữ liệu test:** 0 vector test. Toàn bộ là `PRODUCTION_BUSINESS_DATA` (**Bảo toàn 100%**).

### D. File Storage Vật lý
- **Thư mục `auth-service/storage/conversations/`:**
  - 8 tệp markdown sinh ra từ smoke test ngày 30/10 (`conversation_07fbd584-*.md`, `conversation_7954faec-*.md`,...) -> `CONFIRMED_TEST_DATA` (**Xóa an toàn**).
- **Thư mục `scratch/`:**
  - Các script debug tạm thời phục vụ điều tra lỗi cũ (`analyze_swc*.js`, `check_row_356.js`,...) -> `CONFIRMED_TEST_DATA` (**Dọn dẹp**).
  - Giữ lại các bộ kiểm thử tự động chính thức (`test_prod_hard_delete_suite.js`, `e2e_prod_hard_delete_ui.js`).

---

## 4. CHI TIẾT DANH MỤC XÓA CÓ KIỂM SOÁT (`CONFIRMED_TEST_DATA`)

Dưới đây là bảng kê chi tiết toàn bộ các đối tượng sẽ được xử lý trong đợt dọn dẹp:

```json
{
  "manifest_summary": {
    "workflow_requests": 1,
    "workflow_manifests": 1,
    "workflow_audit": 2,
    "orphan_sync_tasks": 78,
    "test_conversations": 18,
    "test_attachments": 6,
    "duplicate_user_agents": 3,
    "conversation_markdown_files": 8
  }
}
```

Thứ tự thực thi sẽ tuân thủ nghiêm ngặt nguyên tắc **Child-First** bên trong **PostgreSQL Transaction**:
1. Xóa `ai_attachments` thuộc hội thoại test.
2. Xóa `chat_conversation_files` thuộc hội thoại test.
3. Xóa `ai_messages` thuộc hội thoại test.
4. Xóa `ai_conversations` test (18 bản ghi).
5. Xóa `user_agent_versions` thuộc 3 agent test trùng lặp.
6. Xóa `user_agents` test trùng lặp (3 bản ghi).
7. Xóa `hr_sync_tasks` mồ côi (78 bản ghi).
8. Xóa `employee_hard_delete_audit` test (2 bản ghi).
9. Xóa `employee_hard_delete_manifests` test (1 bản ghi).
10. Xóa `employee_hard_delete_requests` test (1 bản ghi).
11. Hậu commit: Xóa các file vật lý `.md` tương ứng trong storage.
