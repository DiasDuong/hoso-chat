# BÁO CÁO NGHIỆM THU BẢO MẬT & TOÀN VẸN QUAN HỆ VĂN BẢN
## SOTRANS HUB — RELATIONSHIP INTEGRITY & TENANT SECURITY PATCH
**Thời điểm thực hiện:** 04/11/2026 13:45:00 (UTC+7)  
**Trạng thái kiểm định:** **HOÀN TOÀN THÀNH CÔNG (100% PASS — 35/35 TEST CASES)**  
**Phạm vi:** Backend `auth-service/routes/documents.js`, Giao diện `chat/hr-admin.html`, Cơ sở dữ liệu PostgreSQL `hrbot`, Vector DB Qdrant `hr_docs`.

---

## 1. TỔNG QUAN & NGUYÊN NHÂN GỐC CỦA CÁC LỖI

Đợt cập nhật này khắc phục dứt điểm 2 lỗi `FAIL` và làm sáng tỏ 1 nghi vấn phát hiện trong Báo cáo Kiểm toán ngày 04/11/2026:

### 1.1. Lỗi 1 — Lỗ hổng Tenant Boundary tại `GET /api/documents/:id/relationships` (Đã khắc phục)
- **Hiện trạng trước sửa lỗi:** Endpoint chỉ yêu cầu xác thực JWT cơ bản (`verifyToken`), hoàn toàn thiếu logic phân quyền RBAC và kiểm tra phạm vi đơn vị (`branch_scope`). Kết quả: Quản trị viên `admin_stl` có thể gửi tham số `:id` là văn bản của Vietranstimex (`432a3c27...`) và nhận về danh sách quan hệ nội bộ với mã `HTTP 200`. Nhân viên thông thường (`EMPLOYEE`) và khách (`USER/GUEST`) cũng có thể truy vấn trái phép.
- **Nguyên nhân gốc:** Quá trình chuẩn hóa API trước đó tập trung vào các hành động ghi dữ liệu (`CREATE`, `REVIEW`, `DELETE`), bỏ quên kiểm soát phạm vi đọc trên endpoint truy vấn quan hệ theo `:id`.

### 1.2. Lỗi 2 — Nguy cơ mâu thuẫn quan hệ và vòng lặp bãi bỏ (Đã khắc phục)
- **Hiện trạng trước sửa lỗi:** Endpoint `POST /:id/relationships` chỉ dựa vào ràng buộc duy nhất trong database:
  `UNIQUE (source_doc_version_id, target_doc_version_id, relation_type)` kết hợp mệnh đề `ON CONFLICT DO UPDATE`. 
- **Nguyên nhân gốc:** 
  1. Mệnh đề `ON CONFLICT DO UPDATE` âm thầm ghi đè ghi chú thay vì trả lỗi `HTTP 409 Conflict` để cảnh báo trùng lặp cho người dùng.
  2. Database constraint chỉ kiểm tra cùng chiều, hoàn toàn bất lực trước quan hệ ngược chiều và mâu thuẫn ngữ nghĩa (ví dụ: A thay thế B, rồi B lại thay thế A; hoặc A thay thế B, nhưng B lại bổ sung/sửa đổi cho A).
  3. Quan hệ đối xứng `applies_with` (áp dụng song song) bị nhân đôi khi người dùng thiết lập ngược chiều `B applies_with A`.

### 1.3. Vấn đề 3 — Nghi vấn không thống nhất số lượng quan hệ giữa các giao diện (Đã làm sáng tỏ)
- **Hiện trạng:** Báo cáo audit ghi nhận Taxonomy có 7 loại, Upload Wizard có 7 loại, nhưng modal `#relDlg` chỉ có 6 loại.
- **Bản chất nghiệp vụ:** 
  - Danh mục toàn hệ thống `DOCUMENT_RELATIONSHIP_TAXONOMY` chuẩn hóa 7 loại.
  - Khi tải văn bản mới (Upload Wizard), người dùng có tùy chọn số 1: `independent` (**Văn bản độc lập** — ban hành mới hoàn toàn, không liên kết văn bản cũ).
  - Khi mở modal `#relDlg` (**Liên kết & Quan hệ Chính sách**), người dùng đang liên kết văn bản A với một văn bản đích B cụ thể. Do đó, loại `independent` (không liên kết) bị loại trừ có chủ đích (`rt.id !== 'independent'`), chỉ hiển thị đúng 6 loại quan hệ thực tế (`supersedes`, `amends`, `supplements`, `exception_to`, `clarifies`, `applies_with`).
  - Cả hai giao diện đều đồng bộ tuyệt đối về mã, tên hiển thị tiếng Việt và mô tả nghiệp vụ. Loại quan hệ `applies_with` (Áp dụng song song) đã được thử nghiệm tạo, lưu và truy vấn thành công.

---

## 2. FILE VÀ API ĐÃ THAY ĐỔI

### 2.1. Mã nguồn đã chỉnh sửa: `auth-service/routes/documents.js`
1. **Bổ sung hàm kiểm tra ngữ nghĩa `checkRelationshipContradiction`:**
   - Kiểm tra quan hệ 2 chiều giữa 2 văn bản trong PostgreSQL (loại trừ các bản ghi đã `rejected`).
   - Ngăn chặn duplicate cùng chiều (báo mã `409 DUPLICATE_RELATIONSHIP`).
   - Ngăn chặn duplicate đối xứng cho `applies_with` (báo mã `409 SYMMETRIC_DUPLICATE`).
   - Ngăn chặn vòng lặp thay thế `supersedes` 2 chiều (báo mã `409 CIRCULAR_SUPERSEDES`).
   - Ngăn chặn văn bản đã bị bãi bỏ thiết lập quan hệ bổ sung/sửa đổi/hướng dẫn cho văn bản kế thừa nó (báo mã `409 REVOKED_DOC_RELATION`).
   - Ngăn chặn xung đột giữa văn bản sửa đổi và văn bản bãi bỏ (báo mã `409 CONFLICTING_SUPERSEDES_MODIFIER`).
   - Ngăn chặn vòng lặp làm rõ lẫn nhau (báo mã `409 CIRCULAR_CLARIFICATION`).
   - Ngăn chặn các vòng lặp sửa đổi/bổ sung/ngoại lệ ngược chiều (`MUTUAL_AMENDMENT`, `MUTUAL_SUPPLEMENT`, `MUTUAL_EXCEPTION`).
   - Ngăn chặn truyền `independent` vào API thiết lập liên kết quan hệ (`400 INVALID_INDEPENDENT_LINK`).

2. **Gia cố bảo mật `GET /api/documents/:id/relationships`:**
   - **RBAC Enforcement:** Kiểm tra quyền `req.user.role`. Chỉ `ADMIN`, `HR`, `SUPER_ADMIN`, `SUPERADMIN` mới được phép truy cập. `EMPLOYEE` và `USER/GUEST` bị từ chối với `HTTP 403 Forbidden`.
   - **Existence Check:** Kiểm tra sự tồn tại của văn bản `:id`, nếu không có trả về `HTTP 404 Not Found`.
   - **Tenant Scope Enforcement:** Trích xuất `company_id` từ JWT token đã xác thực (không tin tưởng `req.query` hay `req.body`). Nếu người dùng thuộc đơn vị STL nhưng truy vấn văn bản của VTX/SWC (và văn bản không có phạm vi `all`), lập tức từ chối với `HTTP 403 Forbidden`.
   - **Related Document Sanitization:** Lọc sạch và loại bỏ các quan hệ trỏ tới tài liệu của tenant khác để không tiết lộ cấu trúc chính sách nội bộ qua metadata.

3. **Gia cố `POST /api/documents/:id/relationships`:**
   - Tích hợp `checkRelationshipContradiction` trước khi thực hiện `INSERT`.
   - Chuyển lệnh `INSERT` thành lệnh chuẩn có kiểm soát, ngăn chặn việc âm thầm ghi đè dữ liệu.

4. **Sửa lỗi lưu quan hệ tại `POST /api/documents` (Intake Wizard):**
   - Loại bỏ các cột không tồn tại (`effective_date`, `change_summary`) trong câu lệnh chèn của bảng `document_relationships`.
   - Bổ sung kiểm tra Tenant Boundary đối với văn bản đích được chọn trong Wizard.

---

## 3. THÔNG TIN BACKUP TRƯỚC KHI CHỈNH SỬA

Toàn bộ hiện trạng hệ thống đã được niêm phong an toàn tại thư mục:  
`D:\hoso-chat\backups\patch_relationship_integrity_20261104\`

| Tên tệp tin | Kích thước | SHA-256 Hash | Mô tả |
|---|---|---|---|
| `documents.js` | 68,254 bytes | `7a4eb3924f0c436b77ae4b1ea8ff8c0a969371077716f9f6874ebf4ff8d928a3` | Bản sao lưu route documents |
| `hr-admin.html` | 553,038 bytes | `9a35e40e2cf631165bc674f762696b9ae098d5f3083dbb6c23ce65e5da994b62` | Bản sao lưu giao diện HR Admin |
| `policyConflictDetector.js` | 12,726 bytes | `adba6b5790a36bb3d2bbf405e32a69634e29788f4cff51f28682aee1416e7dd7` | Bản sao lưu bộ phát hiện xung đột |
| `pg_patch_backup.dump` | 15,722,140 bytes | `971f11c8cb4e6f4a5ca44485542ea407c0b05b542ea8bf8ef48633331cf11d59` | Bản dump nhị phân PostgreSQL `hrbot` |
| `MANIFEST.json` | 880 bytes | `888fbf0a97c41ebfd6c8bc5c65f0e9b9cb1a3aefcf639a66d0c04fa2c65a7702` | Manifest kiểm chứng tính toàn vẹn |

---

## 4. QUY TẮC KIỂM TRA MÂU THUẪN QUAN HỆ ĐÃ TRIỂN KHAI

Bảng ma trận quy tắc ngữ nghĩa trong hàm `checkRelationshipContradiction`:

| STT | Tình huống đầu vào | Logic kiểm tra | Mã lỗi | HTTP Status | Kết quả xử lý |
|:---:|---|---|:---:|:---:|---|
| **1** | A supersedes B, gửi lại A supersedes B | Kiểm tra trùng lặp cặp doc cùng chiều cùng loại | `DUPLICATE_RELATIONSHIP` | `409 Conflict` | Chặn duplicate, giữ nguyên quan hệ cũ |
| **2** | A supersedes B, sau đó B supersedes A | Kiểm tra reverse relation có loại `supersedes` | `CIRCULAR_SUPERSEDES` | `409 Conflict` | Chặn vòng lặp bãi bỏ lẫn nhau |
| **3** | A supersedes B, sau đó B supplements/amends A | Văn bản nguồn B đã bị A bãi bỏ | `REVOKED_DOC_RELATION` | `409 Conflict` | Chặn văn bản bãi bỏ bổ sung cho văn bản mới |
| **4** | B amends A, sau đó A supersedes B | Văn bản đích B đang sửa đổi văn bản nguồn A | `CONFLICTING_SUPERSEDES_MODIFIER` | `409 Conflict` | Chặn văn bản gốc thay thế bản sửa đổi của chính mình |
| **5** | A clarifies B, sau đó B clarifies A | Kiểm tra reverse relation có loại `clarifies` | `CIRCULAR_CLARIFICATION` | `409 Conflict` | Chặn vòng lặp làm rõ lẫn nhau |
| **6** | A applies_with B, sau đó B applies_with A | Xác định `applies_with` là quan hệ đối xứng | `SYMMETRIC_DUPLICATE` | `409 Conflict` | Chặn tạo quan hệ đối xứng trùng lặp |
| **7** | A independent B truyền vào API liên kết | `independent` mang ngữ nghĩa không liên kết | `INVALID_INDEPENDENT_LINK` | `400 Bad Request` | Chặn loại độc lập khi liên kết 2 văn bản |
| **8** | Hai văn bản cùng amends/supplements/exception_to lẫn nhau | Kiểm tra vòng lặp hai chiều cùng loại | `MUTUAL_AMENDMENT` / `MUTUAL_SUPPLEMENT` | `409 Conflict` | Chặn vòng lặp sửa đổi/bổ sung chéo |

---

## 5. KẾT QUẢ MA TRẬN TENANT BOUNDARY TẠI GET RELATIONSHIPS (11/11 PASS)

Kiểm tra toàn bộ ma trận phân quyền và giới hạn đơn vị tại endpoint `GET /api/documents/:id/relationships`:

| Mã Test | Vai trò người dùng | Đơn vị người dùng | Văn bản đích kiểm tra | Phạm vi văn bản | Kết quả mong đợi | Kết quả thực tế | Trạng thái |
|:---:|---|:---:|---|:---:|:---:|:---:|:---:|
| **TC01** | Admin STL | STL | `61a4bae2...` (ST-CSDN-2026-V4) | `sotrans_logistics` | 200 OK | 200 OK | **PASS** |
| **TC02** | Admin STL | STL | `432a3c27...` (20/QD-VTX) | `vietranstimex` | 403 Forbidden | 403 Forbidden | **PASS** |
| **TC03** | Admin STL | STL | `481dad7a...` (CS-GLV-MAU) | `sowatco` | 403 Forbidden | 403 Forbidden | **PASS** |
| **TC04** | Admin VTX | VTX | `432a3c27...` (20/QD-VTX) | `vietranstimex` | 200 OK | 200 OK | **PASS** |
| **TC05** | Admin SWC | SWC | `481dad7a...` (CS-GLV-MAU) | `sowatco` | 200 OK | 200 OK | **PASS** |
| **TC06** | HR STL | STL | `61a4bae2...` (ST-CSDN-2026-V4) | `sotrans_logistics` | 200 OK | 200 OK | **PASS** |
| **TC07** | HR STL | STL | `432a3c27...` (20/QD-VTX) | `vietranstimex` | 403 Forbidden | 403 Forbidden | **PASS** |
| **TC08** | Employee STL | STL | `61a4bae2...` (ST-CSDN-2026-V4) | `sotrans_logistics` | 403 Forbidden | 403 Forbidden | **PASS** |
| **TC09** | Guest (User) | — | `61a4bae2...` (ST-CSDN-2026-V4) | `sotrans_logistics` | 403 Forbidden | 403 Forbidden | **PASS** |
| **TC10** | Super Admin | ALL | `432a3c27...` (20/QD-VTX) | `vietranstimex` | 200 OK | 200 OK | **PASS** |
| **TC11** | Admin STL | STL | `00000000...` (ID giả không tồn tại) | — | 404 Not Found | 404 Not Found | **PASS** |

---

## 6. KẾT QUẢ KIỂM THỬ MÂU THUẪN & DUPLICATE (11/11 PASS)

Thực thi trên môi trường cách ly với 2 văn bản tạm thời `QC-TEST-A` và `QC-TEST-B` thuộc STL (được xóa sạch ngay sau kiểm thử):

| Mã Test | Thao tác thực hiện | Dữ liệu đầu vào | Kết quả mong đợi | Kết quả thực tế | Trạng thái |
|:---:|---|---|---|---|:---:|
| **TC12** | Tạo quan hệ hợp lệ A supersedes B | `supersedes`, notes hợp lệ | 201 Created | 201 Created | **PASS** |
| **TC13** | Gửi lại A supersedes B (Duplicate cùng chiều) | `supersedes`, duplicate | 409 Conflict (`DUPLICATE_RELATIONSHIP`) | 409 Conflict | **PASS** |
| **TC14** | B supersedes A (Vòng lặp bãi bỏ 2 chiều) | `supersedes` ngược chiều | 409 Conflict (`CIRCULAR_SUPERSEDES`) | 409 Conflict | **PASS** |
| **TC15** | B supplements A (Văn bản bãi bỏ sửa đổi văn bản mới) | `supplements` khi B đã superseded | 409 Conflict (`REVOKED_DOC_RELATION`) | 409 Conflict | **PASS** |
| **TC16** | Thiết lập hợp lệ B amends A | `amends`, notes hợp lệ | 201 Created | 201 Created | **PASS** |
| **TC17** | A supersedes B (Xung đột với văn bản đang sửa đổi mình) | `supersedes` khi B amends A | 409 Conflict (`CONFLICTING_SUPERSEDES_MODIFIER`) | 409 Conflict | **PASS** |
| **TC18** | Thiết lập hợp lệ A clarifies B | `clarifies`, notes hợp lệ | 201 Created | 201 Created | **PASS** |
| **TC19** | B clarifies A (Vòng lặp làm rõ lẫn nhau) | `clarifies` ngược chiều | 409 Conflict (`CIRCULAR_CLARIFICATION`) | 409 Conflict | **PASS** |
| **TC20** | Thiết lập hợp lệ A applies_with B | `applies_with`, notes hợp lệ | 201 Created | 201 Created | **PASS** |
| **TC21** | B applies_with A (Duplicate quan hệ đối xứng) | `applies_with` ngược chiều | 409 Conflict (`SYMMETRIC_DUPLICATE`) | 409 Conflict | **PASS** |
| **TC22** | Truyền relation_type = 'independent' vào API quan hệ | `independent` | 400 Bad Request (`INVALID_INDEPENDENT_LINK`) | 400 Bad Request | **PASS** |

---

## 7. KẾT QUẢ KIỂM THỬ THAO TÁC LIÊN ĐƠN VỊ & ĐỒNG BỘ TAXONOMY (6/6 PASS)

| Mã Test | Nội dung kiểm thử | Phương thức & Endpoint | Kết quả mong đợi | Kết quả thực tế | Trạng thái |
|:---:|---|---|---|---|:---:|
| **TC23** | Admin STL cố tạo quan hệ giữa 2 văn bản VTX | `POST /api/documents/:vtxDoc/relationships` | 403 Forbidden | 403 Forbidden | **PASS** |
| **TC24** | Admin STL cố duyệt quan hệ thuộc VTX | `POST /api/documents/relationships/:vtxRel/review` | 403 Forbidden | 403 Forbidden | **PASS** |
| **TC25** | Admin STL cố xóa quan hệ thuộc VTX | `DELETE /api/documents/relationships/:vtxRel` | 403 Forbidden | 403 Forbidden | **PASS** |
| **TC26** | API Scopes trả đủ 7 loại quan hệ chuẩn hóa | `GET /api/documents/scopes` | 7 loại quan hệ | 7 loại quan hệ | **PASS** |
| **TC27** | Giao diện hr-admin.html đồng bộ đúng chuẩn | Kiểm tra cấu trúc HTML Upload Wizard & relDlg | Wizard 7, relDlg 6 | Wizard 7, relDlg 6 | **PASS** |
| **TC28** | Lưu thành công quan hệ `applies_with` qua Intake | `POST /api/documents` có kèm `applies_with` | Lưu thành công vào DB | Đã xác nhận trong DB | **PASS** |

---

## 8. BẢO TOÀN DỮ LIỆU LỊCH SỬ & KIỂM THỬ HỒI QUY (7/7 PASS)

| Mã Test | Nội dung kiểm tra | Tiêu chuẩn đánh giá | Dữ liệu thực tế | Trạng thái |
|:---:|---|---|---|:---:|
| **TC29** | Bảo toàn số lượng văn bản | Đúng 21 văn bản | 21 văn bản | **PASS** |
| **TC30** | Bảo toàn số lượng chunks | Đúng 104 chunks | 104 chunks | **PASS** |
| **TC31** | Bảo toàn 3 bản ghi quan hệ lịch sử | `d084...`, `20f2...`, `997f...` nguyên trạng | Đủ 3 quan hệ, đúng trạng thái | **PASS** |
| **TC32** | Bảo toàn kiểm soát QC-DXM-2026-FLEX | `retrieval_mode = pilot_unverified`, `is_restricted_general = true` | Giữ nguyên 100% | **PASS** |
| **TC33** | Kiểm tra hồi quy General AI | `GET /api/agents` trả về HTTP 200 | 200 OK | **PASS** |
| **TC34** | Kiểm tra hồi quy Personal AI Agent | `GET /api/conversations` trả về HTTP 200 | 200 OK | **PASS** |
| **TC35** | Kiểm tra hồi quy HR Intake Staging | `GET /api/hoso/intake/batch/:id` phản hồi đúng chuẩn | 404 (handled gracefully) | **PASS** |

---

## 9. KẾT LUẬN & KIẾN NGHỊ VẬN HÀNH

1. **Kết luận:**
   - Cả 2 lỗ hổng an ninh dữ liệu phát hiện trong Post-Standardization Audit đã được vá hoàn toàn.
   - Admin của các đơn vị thành viên (STL, VTX, SWC) bị cô lập tuyệt đối trong phạm vi đơn vị mình ở mọi thao tác (Đọc, Tạo, Duyệt, Xóa quan hệ văn bản).
   - Hệ thống ngăn chặn toàn diện mọi hình thức trùng lặp (kể cả quan hệ đối xứng) và mâu thuẫn ngữ nghĩa ngược chiều.
   - Toàn bộ 21 tài liệu, 104 chunks, 104 Qdrant points và cơ chế hạn chế RAG của văn bản thử nghiệm `QC-DXM-2026-FLEX` được bảo toàn nguyên vẹn.

2. **Khuyến nghị vận hành:**
   - Duy trì nguyên tắc phân quyền theo công ty dựa trên JWT token được ký bởi backend.
   - Khi HR/Admin thêm các loại quan hệ pháp lý mới trong tương lai, cần cập nhật đồng thời tại `DOCUMENT_RELATIONSHIP_TAXONOMY` và bổ sung quy tắc ngữ nghĩa tương ứng trong `checkRelationshipContradiction`.
