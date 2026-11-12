# SOTRANS HUB — BÁO CÁO KIỂM TOÁN SAU CHUẨN HÓA
## POST-STANDARDIZATION INTEGRITY & RELATIONSHIP AUDIT

**Dự án:** SOTRANS Hub — Logistics AI Platform  
**Thư mục làm việc:** `D:\hoso-chat`  
**Chế độ thực hiện:** **AUDIT ONLY (READ-ONLY)** — Tuyệt đối không thay đổi mã nguồn, database hay workflow  
**Thời điểm thực hiện kiểm toán:** 04/11/2026  
**Tài liệu tham chiếu:** `docs/DOCUMENT_RELATIONSHIP_TAXONOMY_AUDIT.md`, `docs/BUSINESS_FIRST_UX_DESIGN.md`  

---

## 1. TỔNG QUAN KẾT QUẢ KIỂM TOÁN

Đợt kiểm toán toàn diện tính toàn vẹn dữ liệu, kiểm soát ranh giới phân quyền (Tenant Boundary) và logic 7 loại quan hệ văn bản sau chuẩn hóa ghi nhận các kết quả cốt lõi:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       TỔNG HỢP KẾT QUẢ KIỂM TOÁN                            │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Toàn vẹn Dữ liệu: 21 Documents, 104 Chunks, 104 Qdrant Points.           │
│    Khớp 100% 1-1 giữa PostgreSQL và Qdrant (0 point/chunk mồ côi).          │
│ 2. Xác nhận Giả thuyết: 2 chunks giảm chính xác tuyệt đối do người dùng đã   │
│    xóa văn bản "QC-CNKV-2025" (2 chunks). Dữ liệu hoàn toàn nhất quán.      │
│ 3. Đồng bộ Taxonomy 7 loại: Hoàn tất trên cả Backend (/scopes, validator),  │
│    Upload Wizard (7 loại) và Modal #relDlg (6 loại phi độc lập).             │
│    Loại quan hệ "applies_with" có mặt đầy đủ ở cả 2 giao diện.              │
│ 4. Quan hệ trùng lặp (Case 1): Chặn trùng lặp thành công nhờ UNIQUE key.    │
│ 5. Quan hệ mâu thuẫn (Case 2-6): Database cho phép do đảo chiều Source/Target│
│    -> Phát hiện lỗ hổng logic: Cần bộ lọc phát hiện mâu thuẫn nghiệp vụ.    │
│ 6. Tenant Boundary & RBAC: Lỗi cũ Admin STL duyệt VTX đã bị chặn 403.        │
│    Phát hiện điểm cần khắc phục: GET /:id/relationships chưa lọc tenant.     │
│ 7. Không hồi quy (Non-regression): 3 quan hệ lịch sử và rào chắn            │
│    QC-DXM-2026-FLEX (pilot_unverified, restricted=true) bảo toàn 100%.      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. ĐỐI CHIẾU SỐ LƯỢNG DOCUMENTS, CHUNKS VÀ QDRANT

### 2.1. Bảng đối chiếu tổng thể

| Chỉ số | Báo cáo cũ (Governance V2) | Thực tế kiểm toán hiện tại | Chênh lệch | Trạng thái đồng bộ |
|---|:---:|:---:|:---:|:---:|
| **Tổng số Documents** | 22 | **21** | -1 | Đạt chuẩn (đã xóa 1 văn bản) |
| **Tổng số Chunks (PostgreSQL)** | 106 | **104** | -2 | Khớp 100% dữ liệu văn bản |
| **Tổng số Points (Qdrant `hr_docs`)** | 106 | **104** | -2 | Khớp 100% với PostgreSQL chunks |
| **Chunks mồ côi (Orphan chunks in PG)** | 0 | **0** | 0 | Không có rác dữ liệu |
| **Points mồ côi (Orphan points in Qdrant)**| 0 | **0** | 0 | Không có vector point rác |
| **Chunks PG chưa sync sang Qdrant** | 0 | **0** | 0 | Đồng bộ thời gian thực 100% |

### 2.2. Xác minh giả thuyết "2 chunks giảm do xóa 1 văn bản cũ"

- **Kết luận:** **XÁC NHẬN CHÍNH XÁC 100% (CONFIRMED)**.
- **Minh chứng dữ liệu thực tế trích xuất từ Backup và Audit Log:**
  1. Đối chiếu tệp sao lưu Qdrant collection `hr_docs` thời điểm 106 points (`backups/business_first_v2_20261104/qdrant_hr_docs_points.json`):
     - Tồn tại văn bản mã hiệu: `QC-CNKV-2025`
     - Tiêu đề: *Quy Che Chi Nhanh Kho Van (2025)*
     - `doc_version_id`: `fdc23a99-380f-4519-817d-e1a14d3d9ebc`
     - Số lượng chunks thuộc văn bản này: **đúng chính xác 2 chunks**.
  2. Truy vấn nhật ký kiểm toán `document_audit_logs`:
     - Văn bản `fdc23a99-380f-4519-817d-e1a14d3d9ebc` từng được chuyển trạng thái thử nghiệm trước khi người dùng thực hiện xóa khỏi hệ thống.
  3. Hiện tại trong cơ sở dữ liệu:
     - Bảng `documents`: 0 bản ghi có ID `fdc23a99-380f-4519-817d-e1a14d3d9ebc`.
     - Bảng `chunks`: 0 bản ghi có ID `fdc23a99-380f-4519-817d-e1a14d3d9ebc`.
     - Qdrant `hr_docs`: 0 point có ID `fdc23a99-380f-4519-817d-e1a14d3d9ebc`.
  4. Số lượng chunks của 21 văn bản còn lại cộng dồn:
     `3 + 0 + 3 + 4 + 0 + 5 + 3 + 10 + 1 + 20 + 3 + 1 + 0 + 0 + 5 + 22 + 2 + 2 + 5 + 4 + 11 = 104 chunks`.
- **Đánh giá:** Không có hiện tượng mất mát dữ liệu ngầm hay lỗi đồng bộ. Hệ thống hoàn toàn nhất quán.

---

## 3. KIỂM TOÁN 7 LOẠI QUAN HỆ TRÊN TỪNG LỚP HỆ THỐNG

| Lớp hệ thống / Vị trí | Taxonomy 7 loại | `applies_with` | `clarifies` | Đánh giá đồng bộ |
|---|:---:|:---:|:---:|:---:|
| **1. Hằng số `DOCUMENT_RELATIONSHIP_TAXONOMY`** (`documents.js`) | Có đủ 7 loại | Có | Có | **PASS (100%)** |
| **2. API `GET /api/documents/scopes`** | Trả về đủ 7 loại | Có | Có | **PASS (100%)** |
| **3. API Tiếp nhận (`POST /api/documents`)** | Hỗ trợ 7 loại | Có | Có | **PASS (100%)** |
| **4. API Quản lý quan hệ (`POST /:id/relationships`)** | Hỗ trợ 6 loại phi độc lập | Có | Có | **PASS (100%)** |
| **5. Giao diện Upload Wizard (`#upRelType`)** | Đầy đủ 7 tùy chọn (1 - 7) | Có | Có | **PASS (100%)** |
| **6. Giao diện Quản lý quan hệ (`#relType` trong `#relDlg`)** | Đầy đủ 6 tùy chọn phi độc lập | Có (Option 6) | Có (Option 5) | **PASS (100%)** |
| **7. Backend Validation (`VALID_RELATION_TYPES`)** | Gồm 6 loại hợp lệ | Có | Có | **PASS (100%)** |
| **8. Policy Conflict Detector (`policyConflictDetector.js`)** | Nhận diện quan hệ hợp lệ | Có | Có | **PASS (100%)** |
| **9. Database Constraint (`document_relationships`)** | Check constraint 6 loại | Có | Có | **PASS (100%)** |

> [!NOTE]
> **Làm rõ sự khác biệt giữa 7 loại ở Taxonomy và 6 loại ở Modal `#relDlg`:**
> - Taxonomy tổng thể có 7 loại vì bao gồm `independent` (*Văn bản độc lập*).
> - Tại Modal Quản lý quan hệ giữa 2 văn bản cụ thể (`#relDlg`), người dùng đang liên kết văn bản nguồn với văn bản đích. Khái niệm "độc lập" (không liên kết) không thể áp dụng cho mối nối giữa 2 văn bản, do đó hệ thống lọc bỏ `independent` và chỉ hiển thị đúng 6 loại quan hệ thực tế.
> - Cả hai giao diện đều có mặt `applies_with` (*Áp dụng song song*). Hoàn toàn không có lỗi thiếu `applies_with`.

---

## 4. KIỂM TOÁN QUAN HỆ TRÙNG LẶP VÀ MÂU THUẪN (CASES 1 - 7)

Kiểm toán được thực hiện bằng mô phỏng giao dịch trong PostgreSQL Sandbox với lệnh `ROLLBACK` ngay sau kiểm thử (bảo toàn 100% dữ liệu gốc):

| Trường hợp | Mô tả kiểm thử | Cơ chế xử lý hiện tại | Kết quả thực tế | Phân loại |
|:---:|---|---|---|:---:|
| **Case 1** | **A supersedes B** và tạo lại **A supersedes B** | Ràng buộc duy nhất `unique_doc_relationship` trên `(source, target, relation_type)` + `ON CONFLICT DO UPDATE`. | **Ngăn tạo bản ghi trùng thành công.** Chỉ cập nhật nội dung ghi chú. | **PASS** |
| **Case 2** | **A supersedes B** và **B supplements A** | DB cho phép do Source và Target hoán đổi vị trí. | **Mâu thuẫn ngữ nghĩa:** B đã bị bãi bỏ bởi A nhưng lại được gán bổ sung cho A. | **NEEDS REVIEW** |
| **Case 3** | **A supersedes B** và **B supersedes A** | DB cho phép do Source và Target hoán đổi vị trí. | **Mâu thuẫn nghiêm trọng (Vòng lặp bãi bỏ lẫn nhau):** Cả 2 văn bản đều triệt tiêu hiệu lực của nhau. | **FAIL** |
| **Case 4** | **A amends B** và **B supersedes A** | DB cho phép do Source và Target hoán đổi vị trí. | **Mâu thuẫn nghiệp vụ:** A sửa đổi B nhưng B lại bãi bỏ hoàn toàn A. | **NEEDS REVIEW** |
| **Case 5** | **A clarifies B** và **B clarifies A** | DB cho phép. | **Dư thừa nghiệp vụ:** Làm rõ 2 chiều là bất thường trong văn bản pháp lý nhưng không triệt tiêu hiệu lực. | **NEEDS REVIEW** |
| **Case 6** | **A applies_with B** và **B applies_with A** | DB cho phép. | **Trùng lặp vô hướng:** `applies_with` mang tính đối xứng. Tạo cả 2 chiều bị trùng ngữ nghĩa. | **NEEDS REVIEW** |
| **Case 7** | **A independent B** và tạo quan hệ khác | `independent` chỉ là cờ trên UI, không lưu bản ghi vào DB. | Quan hệ mới được tạo là quan hệ thực duy nhất, không bị xung đột DB. | **PASS** |

### Đánh giá nguyên nhân & Điểm cần bổ sung:
- Ràng buộc tầng Database (`unique_doc_relationship`) chỉ kiểm soát được trùng lặp **cùng chiều** `(source, target, relation_type)`.
- Các trường hợp mâu thuẫn ngược chiều (Case 2, 3, 4) và trùng lặp đối xứng (Case 6) thuộc về **Logic Nghiệp vụ Ngữ nghĩa (Semantic Business Logic)**, cần được kiểm soát ở tầng Backend Validation trước khi thực thi lệnh `INSERT`.

---

## 5. KIỂM TOÁN TENANT BOUNDARY VÀ RBAC

Kiểm toán được thực thi với JWT Token thật của 7 vai trò: `superadmin`, `admin_stl`, `admin_vtx`, `admin_swc`, `hr_stl`, `emp_stl`, `user_guest`.

### 5.1. Ma trận kiểm toán phân quyền & Ranh giới đơn vị

| API Endpoint | Thao tác kiểm thử | Quyền hạn kiểm tra | Kết quả thực tế | Đánh giá |
|---|---|---|---|:---:|
| `POST /relationships/:id/review` | Admin STL duyệt quan hệ của VTX | Kiểm soát ranh giới Tenant (`checkRelationshipTenantScope`) | **HTTP 403 Forbidden** *(Đã ghi nhận SECURITY_TENANT_VIOLATION)* | **PASS** *(Lỗi cũ đã khắc phục triệt để)* |
| `POST /:id/relationships` | Admin STL tạo quan hệ cho văn bản VTX | Kiểm soát ranh giới Tenant | **HTTP 403 Forbidden** | **PASS** |
| `DELETE /relationships/:id` | Admin STL xóa quan hệ của VTX | Kiểm soát ranh giới Tenant | **HTTP 403 Forbidden** | **PASS** |
| `POST /:id/relationships` | Nhân viên (`EMPLOYEE`) tạo quan hệ | RBAC: Kiểm tra `document.edit` | **HTTP 403 Forbidden** | **PASS** |
| `POST /:id/relationships` | Khách vãng lai (`USER`/Guest) tạo quan hệ | RBAC: Kiểm tra `document.edit` | **HTTP 403 Forbidden** | **PASS** |
| `POST /relationships/:id/review` | Nhân viên (`EMPLOYEE`) duyệt quan hệ | RBAC: Kiểm tra vai trò Admin/HR | **HTTP 403 Forbidden** | **PASS** |
| `GET /relationships/all` | Admin STL xem toàn bộ quan hệ | Lọc Tenant tự động | **HTTP 200 OK** *(Chỉ trả về các quan hệ thuộc phạm vi STL hoặc Corporate)* | **PASS** |
| `GET /:id/relationships` | Admin STL xem quan hệ của văn bản VTX | Kiểm tra quyền truy cập `:id` | **HTTP 200 OK** *(Trả về quan hệ của văn bản VTX)* | **FAIL (Bảo mật đọc)** |

### 5.2. Phát hiện lỗi bảo mật đọc (Read Privilege Leak):
- **Hiện tượng:** Khi Admin STL gửi request `GET /api/documents/<VTX_DOC_ID>/relationships`, API trả về mã HTTP 200 kèm danh sách quan hệ của văn bản VTX đó.
- **Nguyên nhân:** Trong khi `GET /api/documents/:id` (lấy chi tiết) đã có cơ chế kiểm tra `userBranch` và chặn 403 nếu tài liệu thuộc công ty khác, thì endpoint `GET /api/documents/:id/relationships` truy vấn thẳng vào DB theo `source_doc_version_id = $1 OR target_doc_version_id = $1` mà **chưa kiểm tra quyền truy cập văn bản gốc `:id`**.
- **Mức độ ảnh hưởng:** Trung bình (Medium - Rò rỉ thông tin liên kết chính sách của công ty thành viên khác qua đường dẫn API trực tiếp).

---

## 6. KIỂM TOÁN KHÔNG HỒI QUY (NON-REGRESSION)

| Nội dung kiểm tra | Hiện trạng | Kết quả kiểm toán |
|---|---|:---:|
| **3 quan hệ lịch sử** | - `d084e3bc...` (VTX supplements Corporate): `pending_review`<br>- `20f280f3...` (Corporate supersedes Labor Safety): `pending_review`<br>- `8610ca2a...` (HQ supplements DXM): `approved` | **BẢO TOÀN 100%** |
| **Quy chế `QC-DXM-2026-FLEX`** | `retrieval_mode = 'pilot_unverified'`, `is_restricted_general = true`, `status = 'active'` | **BẢO TOÀN 100%** |
| **Cơ chế Draft cách ly RAG** | Văn bản trạng thái `draft` không được nạp vào Qdrant và bị loại bỏ khỏi câu truy vấn của n8n | **BẢO TOÀN 100%** |
| **Văn bản `pending_review`** | Quan hệ chưa duyệt không kích hoạt thay đổi hiệu lực văn bản cũ sang `superseded` | **BẢO TOÀN 100%** |
| **Phân quyền và dữ liệu HR/OCR** | Bảng `hr_employee_staging`, `employees` và các tiến trình OCR hoàn toàn không bị ảnh hưởng | **BẢO TOÀN 100%** |
| **General AI & Personal AI Agents** | Các tuyến đường `agents.js`, `general_ai.js` và bảng `user_agents` hoạt động ổn định | **BẢO TOÀN 100%** |

---

## 7. DANH SÁCH LỖI VÀ ĐIỂM CẦN XỬ LÝ

### Lỗi 1: Thiếu rào chắn Tenant tại `GET /api/documents/:id/relationships`
- **Mức độ:** 🟡 **MEDIUM (Security - Read Scope Leak)**
- **Mô tả:** Tài khoản Admin STL có thể tra cứu danh sách quan hệ của một văn bản thuần túy thuộc VTX bằng cách gọi thẳng API `GET /api/documents/<VTX_DOC_ID>/relationships`.
- **Bằng chứng:** Test script trả về HTTP 200 kèm dữ liệu quan hệ của văn bản `45/2024/QĐ-VTX`.
- **Phương án khắc phục đề xuất:**
  Bổ sung kiểm tra quyền truy cập văn bản `:id` tương tự như `GET /api/documents/:id`:
  ```javascript
  const docRes = await db.query('SELECT branch_scope FROM documents WHERE doc_version_id = $1', [id]);
  if (docRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Không tìm thấy văn bản.' });
  if (!isSuperAdminUser(req.user)) {
    const userBranch = getBranchForCompany(req.user.company_id);
    const scope = docRes.rows[0].branch_scope || [];
    if (!scope.includes('all') && !scope.includes(userBranch)) {
      return res.status(403).json({ success: false, error: '403 Forbidden: Bạn không có quyền xem quan hệ của văn bản thuộc đơn vị khác.' });
    }
  }
  ```

### Lỗi 2: Thiếu kiểm tra mâu thuẫn ngược chiều (Contradictory / Circular Relationships)
- **Mức độ:** 🟠 **HIGH (Business Logic Integrity)**
- **Mô tả:** Hệ thống hiện chưa chặn trường hợp vòng lặp bãi bỏ (A supersedes B và B supersedes A) hoặc quan hệ mâu thuẫn trực tiếp (A supersedes B nhưng B supplements A).
- **Bằng chứng:** Mô phỏng giao dịch trong PostgreSQL ghi nhận DB cho phép tạo cả 2 bản ghi do Source và Target đảo chiều.
- **Phương án khắc phục đề xuất:**
  Bổ sung hàm kiểm tra mâu thuẫn ngữ nghĩa `checkRelationshipContradiction(sourceId, targetId, relationType)` trong `POST /:id/relationships` và `POST /documents`:
  - Nếu tạo `supersedes` (A thay thế B): Kiểm tra nếu đã có (B supersedes A) hoặc (B supplements/amends A) -> Báo lỗi HTTP 400 mâu thuẫn.
  - Nếu tạo `applies_with` (A áp dụng song song B): Nếu đã có (B applies_with A) -> Báo lỗi HTTP 409 quan hệ đã tồn tại theo chiều ngược lại.

---

## 8. PHÂN LOẠI KẾT QUẢ KIỂM TOÁN TỔNG THỂ

| Hạng mục kiểm toán | Kết quả | Ghi chú |
|---|:---:|---|
| **Tính toàn vẹn dữ liệu (Documents/Chunks/Qdrant)** | **PASS** | 21 docs, 104 chunks, 104 points khớp 100%. Xác nhận giảm do xóa `QC-CNKV-2025`. |
| **Đồng bộ Taxonomy 7 loại** | **PASS** | Đủ 7 loại tại /scopes và Form Upload; đủ 6 loại tại #relDlg; có `applies_with`. |
| **Chặn trùng lặp quan hệ (Case 1)** | **PASS** | `unique_doc_relationship` hoạt động chính xác. |
| **Ngăn chặn mâu thuẫn quan hệ (Cases 2-6)** | **FAIL** | Cần bổ sung Semantic Contradiction Check ở Backend. |
| **Ranh giới Tenant Thao tác (Review, Create, Delete)** | **PASS** | Admin STL bị chặn 403 tuyệt đối khi tác động lên VTX/SWC. |
| **Ranh giới Tenant Truy vấn (`GET /:id/relationships`)** | **FAIL** | Cần bổ sung kiểm tra quyền xem văn bản `:id`. |
| **Bảo vệ RBAC (Employee, Guest)** | **PASS** | Bị chặn 403 tuyệt đối mọi thao tác thay đổi quan hệ. |
| **Không hồi quy (QC-DXM-2026-FLEX, 3 quan hệ)** | **PASS** | Bảo lưu 100% trạng thái kiểm soát an toàn. |

---

## 9. KẾ HOẠCH KHẮC PHỤC ĐỀ XUẤT (KHI ĐƯỢC PHÊ DUYỆT)

Tuân thủ nghiêm ngặt nguyên tắc **AUDIT ONLY**, đội ngũ kỹ thuật KHÔNG tự ý sửa đổi code. Kính trình Quý ban xem xét kế hoạch xử lý theo 2 mức ưu tiên:

1. **Ưu tiên 1 (An toàn dữ liệu & Ngăn vòng lặp bãi bỏ):**
   - Bổ sung hàm kiểm tra mâu thuẫn quan hệ ngược chiều trước khi `INSERT INTO document_relationships` (chặn Case 2, 3, 4 và chuẩn hóa đối xứng Case 6).
2. **Ưu tiên 2 (Bảo mật truy vấn ranh giới Tenant):**
   - Bổ sung kiểm tra `branch_scope` của văn bản `:id` trong API `GET /api/documents/:id/relationships` để đồng bộ hoàn toàn với `GET /api/documents/:id`.
