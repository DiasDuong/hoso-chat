# SOTRANS HUB — BÁO CÁO TOÀN DIỆN DỌN DẸP DỮ LIỆU KIỂM THỬ SẢN XUẤT
## Mã công việc: PROD-TEST-DATA-CLEANUP-01

**Ngày hoàn tất:** 30/10/2026  
**Dự án:** `D:\hoso-chat`  
**Hệ thống thực hiện:** Production SOTRANS Hub  
**Cơ sở dữ liệu:** PostgreSQL 16 `hrbot` (Port 5432, User: `hrbot`)  
**Bản sao lưu tiền xử lý:** `backups/prod_test_data_cleanup_01/hrbot_pre_cleanup_backup.sql`  
- Kích thước: `77,643,526 bytes`  
- Checksum SHA-256: `3f7df692df0baa466f36e49cbfe1386c1dce2ffdab24301d90c0c3c7371cd12f`  
- Trạng thái kiểm chứng: `PostgreSQL database dump complete (VALIDATED)`  
**Tập tin Manifest chi tiết:** [`docs/production/PRODUCTION_TEST_DATA_CLEANUP_MANIFEST.json`](file:///D:/hoso-chat/docs/production/PRODUCTION_TEST_DATA_CLEANUP_MANIFEST.json)  
**Tài liệu kiểm kê tiền trạm:** [`docs/production/PRODUCTION_TEST_DATA_INVENTORY.md`](file:///D:/hoso-chat/docs/production/PRODUCTION_TEST_DATA_INVENTORY.md)

---

## 1. TỔNG QUAN KẾT QUẢ THỰC THI

| Hạng mục kiểm soát | Trạng thái | Diễn giải & Căn cứ kỹ thuật |
| :--- | :---: | :--- |
| **Trạng thái dọn dẹp tổng thể** | **`CLEANUP_COMPLETED`** | 100% dữ liệu runtime được xác định là test data đã được loại bỏ an toàn. Không còn bản ghi mồ côi hay tệp test rác. |
| **Bảo toàn nhân sự thật** | **`100% PRESERVED`** | Toàn bộ 5 nhân sự cơ sở (`STL00014`, `SWC00022`, `SWC00023`, `SWC00024`, `SWC00025`) được giữ nguyên, **zero mutations**. |
| **Hồ sơ nhân sự chi tiết** | **`100% PRESERVED`** | Đúng 5 hồ sơ `hr_employee_profiles` (53 trường thông tin) tương ứng 5 nhân viên thật. |
| **Hard Delete Workflow Tables** | **`SẠCH HOÀN TOÀN (0)`** | Toàn bộ các bảng `employee_hard_delete_*` trở về trạng thái 0 bản ghi sau khi xóa yêu cầu test E2E. |
| **Orphaned Sync Tasks** | **`ĐÃ XÓA 78 BẢN GHI`** | Xóa sạch 78 tác vụ đồng bộ mồ côi tham chiếu tới các nhân sự test cũ (`TST-DEL-01`, `STL-1029`,...). Giữ nguyên 4 sync tasks của nhân sự thật và 18 sync tasks staging. |
| **Personal AI Agents** | **`ĐÃ XÓA 3 BẢN COPY TEST`** | Giữ đúng 4 Agent thực tế: `Email-Assistant`, 2 `Excel-Data-Pro` (của `emp_stl` và `emp_vtx`), và 1 bản gốc `Logistics Calculator Pro`. |
| **AI Attachments & Fixtures** | **`ĐÃ XÓA 9 TỆP TEST`** | Đã xóa toàn bộ các tệp mẫu `fixture_sotrans_sop.docx`, `fixture_multi_sheet_4q.xlsx`, `fixture_single_sheet_math.xlsx`. 33 tệp thật của người dùng được bảo toàn. |
| **AI Conversations & Messages**| **`ĐÃ XÓA 20 HỘI THOẠI TEST`** | Đã xóa 6 hội thoại `Test Conversation BIZ-04` và 14 hội thoại automated smoke tests. 308 hội thoại thật được bảo toàn. |
| **Google Sheets Đối chiếu** | **`BẢO TOÀN DỮ LIỆU THẬT`** | 5 dòng tương ứng 5 nhân viên thật được bảo toàn nguyên vẹn. Dòng thứ 7 (`SWC00021` - Nguyễn Văn Hiếu) được giữ nguyên phục vụ đối soát lịch sử. |
| **Qdrant Vector Database** | **`100 VECTORS BẢO TOÀN`** | 100/100 vectors của collection `hr_docs` thuộc 19 văn bản chính sách doanh nghiệp, không có vector test nào phát sinh. |

---

## 2. ĐỐI SOÁT CHI TIẾT SỐ LƯỢNG TRƯỚC VÀ SAU DỌN DẸP

| Bảng / Tài nguyên hệ thống | Trước dọn dẹp | Sau dọn dẹp | Số lượng đã xóa | Phân loại dữ liệu | Ghi chú & Căn cứ nghiệp vụ |
| :--- | :---: | :---: | :---: | :--- | :--- |
| **`employees`** | 5 | 5 | **0** | `PRODUCTION_BUSINESS_DATA` | Bảo toàn 100% (`STL00014`, `SWC00022`, `SWC00023`, `SWC00024`, `SWC00025`). |
| **`hr_employee_profiles`** | 5 | 5 | **0** | `PRODUCTION_BUSINESS_DATA` | Bảo toàn 100% hồ sơ 53 trường. |
| **`companies`** | 3 | 3 | **0** | `SYSTEM_CONFIGURATION` | `STL`, `SWC`, `VTX`. |
| **`users`** | 14 | 14 | **0** | `SYSTEM_CONFIGURATION` | Toàn bộ 14 tài khoản quản trị & nhân viên hoạt động bình thường. |
| **`role_permissions`** | 32 | 32 | **0** | `SYSTEM_CONFIGURATION` | 32 quyền hạn RBAC. |
| **`documents`** | 19 | 19 | **0** | `PRODUCTION_BUSINESS_DATA` | 19 quy chế, thỏa ước lao động thật. |
| **`chunks`** | 100 | 100 | **0** | `PRODUCTION_BUSINESS_DATA` | 100 chunks RAG phục vụ tra cứu chính sách. |
| **`employee_hard_delete_requests`** | 1 | 0 | **1** | `CONFIRMED_TEST_DATA` | Xóa `REQ-HD-20261030-B38E` (Test UAT 4-Eyes). |
| **`employee_hard_delete_manifests`** | 1 | 0 | **1** | `CONFIRMED_TEST_DATA` | Xóa manifest băm SHA-256 test. |
| **`employee_hard_delete_audit`** | 2 | 0 | **2** | `CONFIRMED_TEST_DATA` | Xóa 2 sự kiện kiểm toán test. |
| **`employee_hard_delete_approvals`** | 0 | 0 | **0** | - | Đã sạch. |
| **`employee_hard_delete_executions`** | 0 | 0 | **0** | - | Đã sạch (Chưa từng chạy trên Production). |
| **`employee_hard_delete_outbox`** | 0 | 0 | **0** | - | Đã sạch. |
| **`employee_hard_delete_tombstones`** | 0 | 0 | **0** | - | Đã sạch. |
| **`employee_retention_policies`** | 0 | 0 | **0** | `SYSTEM_CONFIGURATION` | Chờ Ban Pháp chế/Nhân sự phê duyệt chính thức. |
| **`hr_sync_tasks`** | 100 | 22 | **78** | `CONFIRMED_TEST_DATA` | Xóa 78 sync task mồ côi của nhân viên test cũ. Giữ 4 task thật + 18 task staging. |
| **`hr_employee_staging`** | 14 | 14 | **0** | `AUDIT_REQUIRES_RETENTION` | 5 approved, 5 rejected, 4 manual review. Giữ nguyên theo audit retention. |
| **`user_agents`** | 7 | 4 | **3** | `CONFIRMED_TEST_DATA` | Xóa 3 bản sao chép test `Logistics Calculator Pro`, giữ 1 bản gốc và 3 Agent thật. |
| **`user_agent_versions`** | 9 | 6 | **3** | `CONFIRMED_TEST_DATA` | Xóa 3 cấu hình version thuộc 3 Agent test đã xóa. |
| **`agent_output_files`** | 4 | 4 | **0** | `PRODUCTION_BUSINESS_DATA` | 4 tệp báo cáo Excel của người dùng thực tế. |
| **`ai_attachments`** | 42 | 33 | **9** | `CONFIRMED_TEST_DATA` | Xóa 9 tệp fixture kiểm thử (`.docx`, `.xlsx`). |
| **`ai_conversations`** | 328 | 308 | **20** | `CONFIRMED_TEST_DATA` | Xóa 20 hội thoại test UAT/smoke test. Bảo lưu 308 hội thoại thật. |
| **`ai_messages`** | 2253 | 2228 | **25** | `CONFIRMED_TEST_DATA` | Xóa các tin nhắn bên trong 20 hội thoại test. |
| **`chat_conversation_files`** | 605 | 591 | **14** | `CONFIRMED_TEST_DATA` | Xóa metadata tệp snapshot của các hội thoại test. |
| **`chat_log`** | 3033 | 3033 | **0** | `AUDIT_REQUIRES_RETENTION` | Giữ nguyên toàn bộ lịch sử hỏi đáp của chatbot. |
| **`auth_audit_logs`** | 3337 | 3337 | **0** | `AUDIT_REQUIRES_RETENTION` | Giữ nguyên nhật ký đăng nhập và bảo mật. |

---

## 3. KẾT QUẢ DỌN DẸP HỆ THỐNG NGOẠI VI & FILE VẬT LÝ

### A. File Storage Vật lý (Disk)
- **Đã xóa 11 tệp Markdown hội thoại test trong `auth-service/storage/conversations/`:**
  - `conversation_7954faec-23aa-4f64-a002-5bea34462367.md`
  - `conversation_07fbd584-fab0-434a-8045-39ae79d3dd5c.md`
  - `conversation_767eb53b-75da-4d0a-9356-616fa1f74fb2.md`
  - `conversation_34cb2bf9-6b34-4794-89f2-4610ade8274d.md`
  - `conversation_e4c42044-582c-46d0-8711-e79b7aeb5cec.md`
  - `conversation_599a1648-e1a8-444b-b638-a140cc0bdded.md`
  - `conversation_4b4aed5a-cf3c-42e3-85ee-18730861f0f7.md`
  - `conversation_e8b3bf68-cecd-4345-bad4-0fc952f6f752.md`
  - `conversation_bcddaab5-2d43-4cfe-9617-d8f1f4d7d31a.md`
  - `conversation_244939fa-0f1e-4644-80eb-6578962055ef.md`
  - `conversation_8cb83c8e-ec39-4b82-910c-4eeadbc0574e.md`
- **Thư mục tạm `scratch/`:** Đã dọn dẹp toàn bộ các script phân tích debug tạm thời, chỉ giữ lại các tài liệu báo cáo và bộ script kiểm định chính thức.

### B. Google Sheets & NocoDB
- **Google Sheets (`1q_Sv9-p-pa5_yzoMSlbJfwz5vNqEhFFBaBhC3f0U6YI`):**
  - Giữ nguyên 5 dòng của 5 nhân viên thật (`STL00014`, `SWC00024`, `SWC00022`, `SWC00023`, `SWC00025`).
  - Dòng 7 mang mã `SWC00021` (Nguyễn Văn Hiếu) được đánh dấu `REQUIRES_MANUAL_REVIEW` và giữ nguyên để đối soát (do mã này đã xóa vật lý trên database ở nhiệm vụ trước, nhưng Google Sheets vẫn còn vết).
- **NocoDB (`:8081`):**
  - Tự động phản chiếu 1:1 theo `hrbot` mà không còn bất kỳ bản ghi mồ côi nào.

### C. Vector Database Qdrant (`:6333`)
- Collection `hr_docs` lưu trữ chính xác 100 điểm vector tương ứng 100 chunks của 19 văn bản chính sách doanh nghiệp. Không bị ảnh hưởng và hoạt động tối ưu.

---

## 4. BẢO TOÀN BASELINE PRODUCTION (ĐỐI SOÁT 5 NHÂN VIÊN THẬT)

Cơ sở dữ liệu `hrbot` tại thời điểm kiểm tra cuối cùng bảo toàn 100% 5 nhân viên cơ sở:

```text
┌─────────┬───────────────┬──────────────────────────┬────────────┬──────────┐
│ (index) │ employee_code │ employee_name            │ company_id │ status   │
├─────────┼───────────────┼──────────────────────────┼────────────┼──────────┤
│ 0       │ 'STL00014'    │ 'NGUYỄN TRƯỜNG NAM'      │ 'STL'      │ 'ACTIVE' │
│ 1       │ 'SWC00022'    │ 'PHAN DƯƠNG THANH BÌNH'  │ 'SWC'      │ 'ACTIVE' │
│ 2       │ 'SWC00023'    │ 'NGUYỄN TRẦN THIỆN NHÂN' │ 'SWC'      │ 'ACTIVE' │
│ 3       │ 'SWC00024'    │ 'NGÔ ĐẶNG TUẤN UYÊN'     │ 'SWC'      │ 'ACTIVE' │
│ 4       │ 'SWC00025'    │ 'LÊ THÀNH NHÂN'          │ 'SWC'      │ 'ACTIVE' │
└─────────┴───────────────┴──────────────────────────┴────────────┴──────────┘
```

**Làm rõ sự khác biệt giữa 5 và 6 nhân sự trước đây:**
- Trước đây hệ thống ghi nhận 6 nhân viên bao gồm cả `SWC00021` (Nguyễn Văn Hiếu).
- Tại yêu cầu công việc số 9 ("hard delete Nguyễn Văn Hiếu"), hồ sơ này đã được xóa vật lý hoàn toàn khỏi bảng `employees` và `hr_employee_profiles` của `hrbot`.
- Do đó, số lượng nhân sự Production cơ sở hiện tại là **chính xác 5 hồ sơ**, hoàn toàn khớp với thực tế dữ liệu vận hành.

---

## 5. KẾT QUẢ KIỂM TRA SỨC KHỎE HỆ THỐNG SAU DỌN DẸP

Script kiểm chứng: `scratch/verify_production_health.js`

```text
================================================================
SOTRANS HUB — POST-CLEANUP PRODUCTION INTEGRITY & HEALTH CHECK
================================================================

1. Production Employees in hrbot (Must be exactly 5): 5 [PASS]
2. Production Employee Profiles count (Must be 5): 5 [PASS]
3. Workflow Tables Check (Must be 0 records): ALL 0 [PASS]
4. Orphaned Sync Tasks count (Must be 0): 0 [PASS]
5. Test Fixture Attachments (Must be 0): 0 [PASS]
6. User Agents remaining count (Must be 4): 4 [PASS]
7. Testing HTTP Services:
 - Gateway -> Auth /api/health: OK [PASS]
 - Auth :3000 /api/health: OK [PASS]
 - Login admin_stl: SUCCESS (Role: ADMIN) [PASS]
 - /api/auth/me: SUCCESS (User: admin_stl) [PASS]
 - /api/employees: 5 records [PASS]
 - /api/hoso/intake/staging: 14 records [PASS]

🎉 ALL PRODUCTION HEALTH CHECKS PASSED WITH FLYING COLORS!
```

---

## 6. DANH MỤC BACKUP CHỨA DỮ LIỆU TEST & THỜI HẠN XỬ LÝ (RETENTION)

Theo quy định quản lý sao lưu an toàn tại Mục IX và XIV:
1. `backups/prod_test_data_cleanup_01/hrbot_pre_cleanup_backup.sql`: Bản sao lưu an toàn ngay trước khi dọn dẹp, được lưu giữ tối thiểu 30 ngày để phục vụ đối soát và dự phòng rủi ro.
2. `backups/prod_hard_delete_02/hrbot_pre_migration_backup.sql`: Bản sao lưu tiền triển khai Hard Delete.
3. **Kế hoạch loại bỏ:** Các bản sao lưu chứa dữ liệu test trước đây sẽ hết hạn và được xoay vòng tự động sau 30 ngày theo chính sách lưu trữ sao lưu của SOTRANS Hub.
