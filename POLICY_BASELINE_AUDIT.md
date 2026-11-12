# SOTRANS HUB — KIỂM TOÁN HIỆN TRẠNG & ĐƯỜNG CƠ SỞ (CHECKPOINT 0)
## POLICY & REGULATORY GOVERNANCE BASELINE AUDIT

> **Dự án:** SOTRANS Hub — Logistics AI Platform  
> **Workspace:** `D:\hoso-chat`  
> **Phiên bản hiện tại:** `v1.1.0-gov3-hotfix1`  
> **Nhánh thực thi (Implementation Branch):** `feat/policy-conflict-engine-v2`  
> **Mục tiêu triển khai:** Môi trường Staging biệt lập (Independent Staging)  
> **Thời điểm kiểm định:** 09/11/2026 10:55 (UTC+7)  
> **Chế độ:** PREFLIGHT BASELINE AUDIT — ZERO PRODUCTION WRITE

---

## 1. KIỂM TRA MÔI TRƯỜNG & GIT WORKING TREE

### 1.1. Trạng thái Git Branch & Working Tree
* **Nhánh hoạt động ban đầu:** `master`.
* **Nhánh thực thi nâng cấp:** Đã khởi tạo và chuyển sang `feat/policy-conflict-engine-v2` an toàn mà không làm mất mát hoặc ghi đè bất kỳ tệp tin nào của người dùng.
* **Tình trạng Working Tree:** Có các tệp chưa commit từ các bản sửa lỗi trước đó (`chat/hr-admin.html`, `auth-service/routes/documents.js`, `nginx/default.conf`, v.v.). Toàn bộ các thay đổi này được bảo toàn nguyên vẹn 100%.

### 1.2. Trạng thái Container Docker Đang Chạy
* `hr-auth`: Node.js Backend phục vụ API (Port: `127.0.0.1:3000`)
* `hrbot-postgres-1`: PostgreSQL 16 (Port: `127.0.0.1:5432`, Database: `hrbot`, Trạng thái: Healthy)
* `hrbot-qdrant-1`: Qdrant Vector DB (Port: `127.0.0.1:6333`, Status: Green)
* `hr-gateway`: Nginx Gateway (Port: `0.0.0.0:8082`)
* `hrbot-n8n-1`: N8N Workflow Automation (Port: `127.0.0.1:5679`)
* `nocodb`: NocoDB (Port: `127.0.0.1:8081`)

### 1.3. Cơ sở dữ liệu Thực tế (PostgreSQL Baseline)
* **Bảng `documents`:** Đang lưu trữ 3 văn bản chính sách (`QC-IS-2024`, `QC-DXCD-2026`, `QC-CNKV-2025`) ở các trạng thái `active` và `superseded`. Toàn bộ dữ liệu này **phải được giữ nguyên vẹn**, nghiêm cấm mọi hành vi xóa hoặc làm hỏng.
* **Bảng `chunks`:** 6 bản ghi trích xuất (tương ứng với 3 văn bản trên).
* **Bảng `document_relationships`:** 1 bản ghi quan hệ văn bản (`QC-DXCD-2026` liên kết với văn bản liên quan).
* **Bảng `document_retrieval_controls`:** 0 bản ghi.
* **Bảng `document_retry_leases`:** 0 bản ghi (các tác vụ trước đó đã giải phóng sạch).
* **Bảng `document_audit_logs`:** 581 bản ghi (Được bảo toàn toàn bộ phục vụ truy vết).
* **Enum `doc_status`:** 10 giá trị chuẩn: `['draft', 'testing', 'scheduled', 'active', 'superseded', 'revoked', 'archived', 'trash', 'pending_approval', 'rejected']`.

### 1.4. Qdrant Vector DB Baseline
* Collection `hr_docs` (Production): 6 points (tương ứng 6 chunks đang active trong PG).
* Collection `hr_docs_staging`: 67 points.

### 1.5. Kho Lưu trữ Tệp (File Storage Baseline)
* Thư mục `D:\hoso-chat\files\policies`: Tồn tại, lưu trữ tệp PDF của các văn bản đang hiệu lực và tệp lưu trữ lịch sử.

---

## 2. RÀ SOÁT CHI TIẾT 8 PHẠM VI CHỨC NĂNG (8 FUNCTIONAL DOMAINS)

### Domain 1 — Document Lifecycle Management (Quản lý Vòng đời Văn bản)
* **Hiện trạng:** Đã có hệ thống enum `doc_status` 10 trạng thái và các API tương ứng (`/submit`, `/approve`, `/reject`, `/activate`, `/archive`, `/retract`, `/restore`, `/delete`).
* **Khoảng trống (Gap):** Logic chuyển đổi trạng thái (State Transitions) đang nằm rải rác trên từng route handler, chưa có bộ kiểm định ma trận trạng thái tập trung (Deterministic Transition Matrix) để từ chối các bước nhảy trạng thái phi lý (vd: từ `rejected` nhảy thẳng sang `active` mà không qua nộp duyệt lại).

### Domain 2 — Document Relationship Governance (Quản trị Quan hệ Văn bản)
* **Hiện trạng:** Hỗ trợ 7 loại quan hệ: `independent`, `supersedes`, `amends`, `supplements`, `exception_to`, `clarifies`, `applies_with`.
* **Khoảng trống (Gap):**
  * Đã có kiểm tra tự liên kết (`self-reference`), nhưng **hoàn toàn chưa có thuật toán phát hiện chu trình vòng lặp (Circular Relationship / Cycle Detection)** (ví dụ: A thay thế B, B thay thế C, C thay thế A).
  * Chưa có kiểm định quan hệ mâu thuẫn đồng thời (Contradictory Relationships) giữa cùng 1 cặp văn bản (ví dụ: vừa khai báo `supersedes` bãi bỏ vừa khai báo `applies_with` cùng áp dụng).

### Domain 3 — Policy Conflict Engine V2 (Động cơ Đối soát Xung đột V2)
* **Hiện trạng:** File `policyConflictDetector.js` (1.193 dòng) đang triển khai:
  * Layer 1: SHA-256 đối soát tệp nhị phân (`EXACT_DUPLICATE`).
  * Layer 3: Shingles N-gram 85% tương đồng nội dung.
  * Layer 4: Đánh giá sơ bộ về đối tượng và chủ đề.
* **Khoảng trống (Gap):**
  * Thiếu phân loại chuẩn hóa: Chưa xuất nhãn rõ ràng cho `IDENTIFIER_DUPLICATE` (trùng mã hiệu khác nội dung), `CONTENT_OVERLAP` (trùng lặp nội dung không xung đột), `SUPERSESSION` (thay thế hợp lệ).
  * Chưa hỗ trợ phân loại `UNKNOWN` (Fail-closed khi bằng chứng không đầy đủ / Insufficient Evidence).
  * Shadow Mode: Chưa kết nối luồng ghi kết quả V2 ra tệp độc lập `shadow_conflict_audit.jsonl` như thiết kế Phase 2.2 đã duyệt.

### Domain 4 — OCR & Document Processing Reliability (Độ tin cậy OCR & Xử lý)
* **Hiện trạng:** 
  * Đường ống: Upload -> Validate File -> n8n OCR -> Chunks Extraction -> Zero-Chunk Gate -> Conflict Check -> Approval -> Publication -> Qdrant Indexing.
  * Chốt chặn Zero-Chunk Gate (`APPROVE_BLOCKED_ZERO_CHUNK`) đã được tích hợp chặt chẽ tại route `approve` và hàm `handleDirectApproval`.
* **Khoảng trống (Gap):** Cần bài test kiểm định khả năng phục hồi tự động khi n8n OCR trả về lỗi hoặc timeout, bảo đảm không có văn bản 0 chunk nào lọt qua được cửa xuất bản.

### Domain 5 — Safe Publication & Data Consistency (Xuất bản An toàn & Nhất quán)
* **Hiện trạng:** Đã có cơ chế quản lý thế hệ (`active_generation_id`, `fencing_token`) và hàm đối soát `reconcileGenerationsAndVectors()` trong `qdrantSyncService.js`.
* **Khoảng trống (Gap):** Cần giải quyết dứt điểm phát hiện **F-01** (đối soát số lượng orphan chunks khi dọn dẹp) và chứng minh tính bền vững khi chạy đa tiến trình (Multi-instance).

### Domain 6 — RBAC & Approval Workflow (Phân quyền & Luồng Phê duyệt)
* **Hiện trạng:** Sử dụng middleware `verifyToken` và `requirePermission`. Phân định rõ quyền của `ADMIN` (được duyệt, kích hoạt, sửa) và `HR` (chỉ được nộp bản nháp, gửi yêu cầu, xóa văn bản do chính mình tạo khi bị từ chối). Phân định phạm vi đơn vị `branch_scope` (`STL`, `SWC`, `VTX`, `all`).
* **Khoảng trống (Gap):** Cần bộ test kiểm thử tự động xác nhận HR không thể kích hoạt văn bản trực tiếp qua việc gửi request POST thẳng vào `/api/documents/:id/approve`.

### Domain 7 — Advanced RAG & Policy Assistant (Trợ lý Chính sách Thông minh)
* **Hiện trạng:** Route `policy.js` và module `smartRouter.js` chuyển tiếp câu hỏi vào Qdrant và mô hình sinh câu trả lời.
* **Khoảng trống (Gap):** Cần đảm bảo bộ lọc truy vấn vector loại trừ các văn bản đã bãi bỏ (`superseded`) hoặc hết hạn (`expired`), trích dẫn chính xác Điều/Khoản và trả về cảnh báo "Không đủ căn cứ" khi dữ liệu thiếu hụt.

### Domain 8 — Dashboard, Audit & Monitoring (Bảng điều khiển & Nhật ký)
* **Hiện trạng:** Route `GET /api/documents` tính toán số liệu thống kê trực tiếp từ PostgreSQL.
* **Khoảng trống (Gap):** Cần hoàn thiện hiển thị số liệu cảnh báo xung đột và tỷ lệ xử lý OCR thành công dựa trên dữ liệu thật.

---

## 3. ĐIỀU TRA CÁC PHÁT HIỆN LỊCH SỬ (F-01 ĐẾN F-04)

| Mã phát hiện | Nội dung điều tra | Kết quả kiểm tra mã nguồn thực tế | Đánh giá hiện trạng | Hành động xử lý trong Phase 3 |
|---|---|---|---|---|
| **F-01** | Lệch số lượng bản ghi orphan khi dọn dẹp chunks chưa publish | Hàm `reconcileGenerationsAndVectors` xóa chunks ở 2 bước nối tiếp nhưng có thể báo trùng lặp đếm. | **ĐÃ PHÁT HIỆN NGUYÊN NHÂN** | Tối ưu hóa truy vấn dọn dẹp atomic duy nhất và trả về count chính xác trong Checkpoint 3. |
| **F-02** | Khóa thuê thử lại (Durable Retry Lease) chạy đa phiên bản | Bảng `document_retry_leases` sử dụng `SELECT ... FOR UPDATE` và `fencing_token`. | **ĐÃ CÓ TRONG POSTGRESQL** | Viết kịch bản test đa luồng giả lập 2 tiến trình tranh chấp cùng lúc để chứng minh tính phân tán. |
| **F-03** | Thiếu bộ kiểm thử tự động hồi quy toàn diện | Các bài test nằm phân tán trong `tests/` và `scratch/`, chưa có test runner chuẩn hóa. | **CHƯA ĐẠT CHUẨN** | Xây dựng bộ test suite tích hợp tự động cho toàn bộ 8 Domains trong Checkpoint 5. |
| **F-04** | Kiểm định Zero-Chunk Gate và Publication an toàn | Route `POST /api/documents/:id/approve` đã chặn triệt để `APPROVE_BLOCKED_ZERO_CHUNK`. | **ĐÃ HOẠT ĐỘNG TỐT** | Bổ sung test case tự động cố tình approve văn bản 0 chunk để xác nhận mã lỗi 400. |

---

## 4. KẾT LUẬN PREFLIGHT GATE

1. Toàn bộ mã nguồn và cơ sở dữ liệu Production hiện tại đang an toàn, nguyên vẹn.
2. Không có bất kỳ thao tác xóa nào được phép thực hiện trên Production.
3. Bước tiếp theo: Thiết lập tài liệu Gap Matrix, Kế hoạch Triển khai (Implementation Plan) và Kế hoạch An toàn Production (Production Safety Plan) trước khi chuyển sang Checkpoint 1.
