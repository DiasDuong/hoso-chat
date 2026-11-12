# SOTRANS HUB — BÁO CÁO AUDIT & CHUẨN HÓA DANH MỤC QUAN HỆ VĂN BẢN
## STANDARDIZED DOCUMENT RELATIONSHIP TAXONOMY REPORT

**Dự án:** SOTRANS Hub — Logistics AI Platform  
**Thư mục làm việc:** `D:\hoso-chat`  
**Tài liệu tham chiếu:** `docs/BUSINESS_FIRST_UX_DESIGN.md`  
**Thời điểm thực hiện & nghiệm thu:** 04/11/2026  
**Chế độ triển khai:** Non-destructive In-place Standardization  

---

## 1. TỔNG QUAN & MỤC TIÊU NGHIỆP VỤ

Trong quá trình rà soát vận hành thực tế hệ thống SOTRANS Hub, tồn tại sự không thống nhất về danh mục và thuật ngữ phân loại quan hệ văn bản giữa hai giao diện chính:

1. **Màn hình Tiếp nhận / Upload văn bản mới (Modal `#upDlg` - Bước 3):** Sử dụng danh mục 5 loại, tiêu đề trường mang tính kỹ thuật *"Tính chất quan hệ pháp lý (*)"*, thiếu loại quan hệ *"Làm rõ / Hướng dẫn áp dụng"* (`clarifies`) và loại quan hệ *"Áp dụng song song"* (`applies_with`).
2. **Màn hình Quản lý liên kết quan hệ văn bản (Modal `#relDlg`):** Sử dụng danh mục 6 loại hiển thị bằng tiếng Anh kèm giải thích (`supplements (Bổ sung chế độ/điều khoản)`), thứ tự sắp xếp lộn xộn, hiển thị danh sách quan hệ thiếu người phê duyệt và văn bản nguồn/đích trực quan.

**Mục tiêu giải quyết triệt để:**
- Thiết lập **Một nguồn cấu hình dùng chung (Single Source of Truth)** cho danh mục quan hệ văn bản.
- Đồng bộ 100% tên hiển thị và định danh hệ thống giữa Giao diện Upload và Giao diện Quản lý quan hệ.
- Giúp cán bộ HR/Pháp chế chỉ cần hiểu và ghi nhớ một bộ danh mục ngôn ngữ nghiệp vụ tiếng Việt duy nhất.
- Bổ sung validation chặt chẽ: bắt buộc chọn văn bản đích và căn cứ nghiệp vụ khi tạo quan hệ, chặn tự liên kết chính mình (self-relationship).
- Bảo toàn tuyệt đối 100% dữ liệu lịch sử, không làm thay đổi trạng thái 3 quan hệ hiện hữu, bảo vệ nghiêm ngặt quy chế thí điểm `QC-DXM-2026-FLEX`.

---

## 2. ĐỐI CHIẾU DANH MỤC TRƯỚC VÀ SAU CHUẨN HÓA

### 2.1. So sánh hiện trạng trước chuẩn hóa

| Giá trị hệ thống (`relation_type`) | Giao diện Upload cũ | Giao diện Quản lý Quan hệ cũ | Database Constraint | Đánh giá hiện trạng |
|---|---|---|---|---|
| `independent` | Có ("1. Văn bản độc lập...") | Không có | Không lưu DB (chỉ là cờ UI) | Không đồng nhất |
| `supersedes` | Có ("2. Thay thế văn bản cũ...") | Có ("supersedes (Thay thế...)") | Cho phép | Thuật ngữ và vị trí khác nhau |
| `amends` | Có ("3. Sửa đổi điều khoản...") | Có ("amends (Sửa đổi...)") | Cho phép | Thuật ngữ và vị trí khác nhau |
| `supplements` | Có ("4. Bổ sung chế độ...") | Có ("supplements (Bổ sung...)") | Cho phép | Thuật ngữ và vị trí khác nhau |
| `exception_to` | Có ("5. Quy định ngoại lệ...") | Có ("exception_to (Quy định...)") | Cho phép | Thuật ngữ và vị trí khác nhau |
| `clarifies` | **THIẾU** | Có ("clarifies (Làm rõ...)") | Cho phép | Bị khuyết ở Form Upload |
| `applies_with` | **THIẾU** | Có ("applies_with (Áp dụng song song)") | Cho phép | Xuất hiện lẻ loi ở `#relDlg` |

### 2.2. Danh mục chuẩn hóa thống nhất toàn diện (Single Source of Truth)

Toàn bộ hệ thống hiện đã đồng bộ theo một bảng danh mục chuẩn hóa duy nhất:

| STT | Mã hệ thống (`relation_type`) | Tên hiển thị nghiệp vụ chuẩn | Ý nghĩa nghiệp vụ | Phạm vi áp dụng | Tác động hiệu lực văn bản đích |
|:---:|---|---|---|:---:|---|
| **1** | `independent` | **Văn bản độc lập** | Ban hành mới hoàn toàn, không liên kết hoặc phụ thuộc vào văn bản nào khác. | Upload Wizard | Không có văn bản đích. |
| **2** | `supersedes` | **Thay thế văn bản cũ** | Văn bản mới thay thế hoàn toàn văn bản cũ (bãi bỏ bản cũ khi bản mới có hiệu lực). | Upload & Quản lý quan hệ | Văn bản cũ chuyển sang `superseded` khi quan hệ được duyệt và đến ngày hiệu lực. |
| **3** | `amends` | **Sửa đổi văn bản cũ** | Văn bản mới sửa đổi, điều chỉnh một phần nội dung/điều khoản của văn bản cũ. | Upload & Quản lý quan hệ | Cả 2 văn bản cùng có hiệu lực song song; điều khoản mới được ưu tiên áp dụng. |
| **4** | `supplements` | **Bổ sung văn bản cũ** | Văn bản mới bổ sung thêm nội dung, quy trình hoặc chế độ phụ cấp cho quy chế chung. | Upload & Quản lý quan hệ | Cả 2 văn bản cùng có hiệu lực song song; văn bản bổ sung mở rộng chế độ. |
| **5** | `exception_to` | **Quy định ngoại lệ** | Văn bản mới quy định ngoại lệ đặc thù đối với văn bản cũ (cho phạm vi hẹp). | Upload & Quản lý quan hệ | Cả 2 văn bản cùng có hiệu lực; phạm vi đặc thù ưu tiên áp dụng quy chế ngoại lệ. |
| **6** | `clarifies` | **Làm rõ / Hướng dẫn áp dụng** | Văn bản mới làm rõ, giải thích hoặc hướng dẫn thi hành văn bản hiện có. | Upload & Quản lý quan hệ | Cả 2 văn bản cùng có hiệu lực; văn bản làm rõ cung cấp căn cứ áp dụng. |
| **7** | `applies_with` | **Áp dụng song song (Tham chiếu)** | Áp dụng đồng thời cùng văn bản hiện hành (tham chiếu chéo, không sửa đổi hay bãi bỏ). | Upload & Quản lý quan hệ | Cả 2 văn bản cùng có hiệu lực độc lập nhưng được liên kết ngữ cảnh tra cứu. |

---

## 3. ĐÁNH GIÁ CHUYÊN SÂU LOẠI QUAN HỆ `applies_with`

Theo yêu cầu tại Mục 3 của đặc tả, loại quan hệ `applies_with` đã được rà soát độc lập và đánh giá toàn diện:

1. **Hiện trạng dữ liệu trong Database:**
   - Truy vấn: `SELECT COUNT(*) FROM document_relationships WHERE relation_type = 'applies_with';`
   - Kết quả: **0 bản ghi** (Chưa có văn bản nào trong hệ thống từng gán quan hệ này).
2. **Khả năng tương thích cơ sở dữ liệu:**
   - Ràng buộc kiểm tra `document_relationships_relation_type_check` trong PostgreSQL đã có sẵn giá trị `'applies_with'`.
   - Backend `validRelations` cũng đã hỗ trợ giá trị này.
3. **Ý nghĩa nghiệp vụ thực tiễn:**
   - Trong quản trị nhân sự tập đoàn, nhiều chính sách không thay thế hay sửa đổi lẫn nhau nhưng mang tính tương hỗ, bắt buộc cán bộ áp dụng song song (Ví dụ: *"Quy chế Công tác phí"* áp dụng song song với *"Quy định Thanh toán Tạm ứng"*).
   - Nếu loại bỏ `applies_with`, HR sẽ không có công cụ liên kết tham chiếu hai quy chế độc lập nhưng có liên quan mật thiết về nghiệp vụ.
4. **Quyết định giải pháp:**
   - **GIỮ LẠI VÀ CHUẨN HÓA:** Giữ nguyên giá trị `applies_with` trong Database Check Constraint và Backend Validation.
   - Chuẩn hóa tên hiển thị tiếng Việt: **"Áp dụng song song (Tham chiếu)"**.
   - Cập nhật vào động cơ đối soát xung đột `policyConflictDetector.js`: Khi hai văn bản có quan hệ `applies_with` đã được duyệt, hệ thống ghi nhận là áp dụng song song hợp lệ, không báo xung đột giả định.
   - Bổ sung vào cả Form Upload và Modal Quản lý quan hệ để đồng nhất 100%.

---

## 4. QUY TẮC NGHIỆP VỤ & CHIỀU QUAN HỆ (SOURCE VS TARGET)

### 4.1. Chiều lưu trữ dữ liệu trong hệ thống

Bảng `document_relationships` lưu trữ quan hệ có hướng rõ ràng:
- **`source_doc_version_id` (Văn bản nguồn):** Là văn bản mới được ban hành / văn bản chủ động tạo mối liên kết (Văn bản thực thi hành động).
- **`target_doc_version_id` (Văn bản đích):** Là văn bản hiện có / văn bản gốc bị tác động (bị thay thế, bị sửa đổi, được bổ sung, nhận ngoại lệ, hoặc được làm rõ).

### 4.2. Bảng ma trận logic nghiệp vụ từng loại quan hệ

```
┌─────────────────┬───────────────────┬────────────────────────────────────────┬──────────────────────┐
│ Loại quan hệ    │ Chiều tác động    │ Tác động trạng thái (Status)           │ Tác động RAG Chatbot │
├─────────────────┼───────────────────┼────────────────────────────────────────┼──────────────────────┤
│ supersedes      │ Source → Target   │ Khi Source Active & Approved:          │ Target bị loại bỏ    │
│                 │ (Mới thay Cũ)     │ Target status chuyển sang 'superseded' │ hoàn toàn khỏi RAG   │
│                 │                   │ Ngày hết hiệu lực = Ngày hiệu lực mới -1│                      │
├─────────────────┼───────────────────┼────────────────────────────────────────┼──────────────────────┤
│ amends          │ Source → Target   │ Cả 2 cùng Active.                      │ Cả 2 được nạp vào    │
│                 │ (Mới sửa Cũ)      │ Target giữ nguyên status 'active'.     │ Context RAG (Ưu tiên)│
├─────────────────┼───────────────────┼────────────────────────────────────────┼──────────────────────┤
│ supplements     │ Source → Target   │ Cả 2 cùng Active.                      │ Cả 2 được nạp vào    │
│                 │ (Mới bổ sung Cũ)  │ Target giữ nguyên status 'active'.     │ Context RAG          │
├─────────────────┼───────────────────┼────────────────────────────────────────┼──────────────────────┤
│ exception_to    │ Source → Target   │ Cả 2 cùng Active.                      │ Chatbot phân luồng:  │
│                 │ (Ngoại lệ cho Cũ) │ Target áp dụng phạm vi chung.          │ Ưu tiên Source cho   │
│                 │                   │ Source áp dụng phạm vi hẹp/đặc thù.    │ phạm vi đặc thù      │
├─────────────────┼───────────────────┼────────────────────────────────────────┼──────────────────────┤
│ clarifies       │ Source → Target   │ Cả 2 cùng Active.                      │ Source hỗ trợ giải   │
│                 │ (Làm rõ cho Cũ)   │ Target giữ nguyên status 'active'.     │ thích điều khoản Cũ  │
├─────────────────┼───────────────────┼────────────────────────────────────────┼──────────────────────┤
│ applies_with    │ Source ↔ Target   │ Cả 2 cùng Active.                      │ Liên kết tham chiếu  │
│                 │ (Song song nhau)  │ Độc lập về hiệu lực và phạm vi.        │ ngữ cảnh mở rộng     │
└─────────────────┴───────────────────┴────────────────────────────────────────┴──────────────────────┘
```

> [!IMPORTANT]
> **Nguyên tắc bất khả xâm phạm:**
> 1. Không được suy luận rằng việc tạo quan hệ mới sẽ làm văn bản cũ mất hiệu lực. Chỉ có quan hệ `supersedes` **đã được HR/Admin phê duyệt** và **đến ngày hiệu lực** mới làm văn bản cũ chuyển sang `superseded`.
> 2. Việc tạo quan hệ mới ở trạng thái `pending_review` tuyệt đối không làm thay đổi trạng thái pháp lý của văn bản đích.

---

## 5. CHI TIẾT CÁC TỆP TIN & API ĐÃ NÂNG CẤP

### 5.1. Backend: `auth-service/routes/documents.js`
- **Single Source of Truth:** Khai báo hằng số `DOCUMENT_RELATIONSHIP_TAXONOMY` (7 loại) và `VALID_RELATION_TYPES` (6 loại phi độc lập).
- **`GET /api/documents/scopes`:** Trả về danh mục chuẩn hóa thống nhất kèm mô tả chi tiết cho Frontend.
- **`POST /api/documents` (Intake Wizard):**
  - Xác thực danh mục quan hệ đi kèm: Nếu chọn loại phi độc lập mà không có trong danh mục chuẩn -> Báo lỗi HTTP 400.
  - Bắt buộc phải chọn `target_doc_version_id` khi quan hệ không phải `independent` -> Báo lỗi HTTP 400.
  - Bắt buộc phải có `notes` (căn cứ pháp lý) khi gửi trình duyệt (`submit_for_approval: true`) -> Báo lỗi HTTP 400.
- **`POST /api/documents/:id/relationships` (Quản lý quan hệ):**
  - Chặn quan hệ tự thân: `id === target_doc_version_id` -> Báo lỗi HTTP 400 *"Văn bản không thể tự thiết lập quan hệ với chính nó."*
  - Xác thực `VALID_RELATION_TYPES` -> Báo lỗi HTTP 400 nếu sai danh mục.
  - Bắt buộc phải nhập căn cứ pháp lý: `notes.trim().length > 0` -> Báo lỗi HTTP 400.
- **`GET /api/documents/relationships/all`:**
  - Bổ sung rào chắn Tenant Boundary cho tài khoản Admin đơn vị (ví dụ `admin_stl` chỉ được xem quan hệ liên quan đến `STL` hoặc toàn tập đoàn `all`).

### 5.2. Backend: `auth-service/services/policyConflictDetector.js`
- Cập nhật logic rà soát quan hệ đã xác lập: Bổ sung `'applies_with'` vào danh sách quan hệ hợp lệ đã được phê duyệt `['supersedes', 'supplements', 'amends', 'clarifies', 'applies_with']` để không báo xung đột chính sách giả.

### 5.3. Frontend: `chat/hr-admin.html`
- **Bộ từ điển dùng chung:** Khai báo `DOC_RELATION_TAXONOMY` và helper `getRelTypeBadge(type)` hiển thị badge trạng thái chuẩn màu sắc theo từng loại quan hệ.
- **Form Tiếp nhận (Upload Wizard - Bước 3):**
  - Đổi tên trường thành: `<label>Quan hệ với văn bản hiện có (*):</label>`.
  - Hiển thị danh mục 7 tùy chọn tiếng Việt thân thiện, đánh số thứ tự từ 1 đến 7.
  - Đổi nhãn văn bản đích thành *"Văn bản đích liên quan (*)"* và ghi chú thành *"Căn cứ pháp lý / Ghi chú nghiệp vụ (*)"*.
  - Kiểm tra điều kiện phía Client: Bắt buộc chọn văn bản đích, bắt buộc nhập ghi chú căn cứ, và bắt buộc nhập ngày bãi bỏ nếu chọn `supersedes`.
- **Modal Quản lý Quan hệ (`#relDlg`):**
  - Đồng bộ danh mục 6 tùy chọn trong dropdown `#relType` khớp 100% với Form Upload.
  - Yêu cầu nhập căn cứ pháp lý trước khi bấm *"Xác nhận thiết lập quan hệ"*.
  - Nâng cấp giao diện hiển thị danh sách quan hệ (`loadDocRelationships`):
    - Hiển thị rõ **Văn bản nguồn** (`[Mã] Tiêu đề nguồn`).
    - Hiển thị rõ **Loại quan hệ** bằng Badge tiếng Việt chuẩn hóa.
    - Hiển thị rõ **Văn bản đích** (`[Mã] Tiêu đề đích`).
    - Khối trích dẫn **Căn cứ / Ghi chú nghiệp vụ** viền xanh rõ ràng.
    - Hiển thị đầy đủ **Trạng thái phê duyệt**, **Người thiết lập**, **Người phê duyệt** (kèm thời gian phê duyệt nếu có).
- **Hàm `loadWizardScopes()`:** Tự động đồng bộ các option trong `<select>` từ API `GET /scopes` để đảm bảo tương lai mở rộng thêm loại quan hệ sẽ tự động cập nhật cả 2 giao diện mà không cần sửa HTML tĩnh.

---

## 6. KẾT QUẢ KIỂM THỬ TỰ ĐỘNG TOÀN DIỆN

Hệ thống đã được kiểm thử với 2 bộ test độc lập:

### 6.1. Taxonomy Standardization Test Suite (`test_taxonomy_standardization.js`)
**Kết quả: 18 / 18 PASS (100%)**

```text
========================================================================
🚀 BẮT ĐẦU KIỂM THỬ CHUẨN HÓA DANH MỤC QUAN HỆ VĂN BẢN (TAXONOMY AUDIT)
========================================================================

--- PHẦN 1: SINGLE SOURCE OF TRUTH & TAXONOMY SCOPES ---
  ✅ [PASS] GET /scopes trả về đầy đủ 7 loại quan hệ chuẩn hóa
  ✅ [PASS] GET /scopes chứa đầy đủ 7 mã định danh hệ thống (independent, supersedes, amends, supplements, exception_to, clarifies, applies_with)
  ✅ [PASS] Loại quan hệ "clarifies" có tên hiển thị chuẩn: "Làm rõ / Hướng dẫn áp dụng"
  ✅ [PASS] Loại quan hệ "applies_with" được chuẩn hóa tên hiển thị: "Áp dụng song song (Tham chiếu)"

--- PHẦN 2: ĐỌC DỮ LIỆU QUAN HỆ LỊCH SỬ ---
  ✅ [PASS] GET /relationships/all đọc đầy đủ dữ liệu quan hệ lịch sử
  ✅ [PASS] Dữ liệu quan hệ trả về đầy đủ văn bản nguồn, văn bản đích, loại quan hệ và trạng thái phê duyệt

--- PHẦN 3: VALIDATION BACKEND & QUY TẮC NGHIỆP VỤ ---
  ✅ [PASS] POST /documents chặn 400 khi khai báo relation_type không có trong danh mục chuẩn hóa
  ✅ [PASS] POST /documents chặn 400 khi chọn quan hệ phi độc lập nhưng thiếu văn bản đích
  ✅ [PASS] POST /documents chặn 400 khi gửi duyệt văn bản có quan hệ nhưng bỏ trống căn cứ pháp lý
  ✅ [PASS] POST /:id/relationships chặn 400 không cho phép văn bản tự thiết lập quan hệ với chính nó
  ✅ [PASS] POST /:id/relationships bắt buộc phải cung cấp căn cứ pháp lý hoặc ghi chú nghiệp vụ

--- PHẦN 4: THIẾT LẬP & PHÊ DUYỆT ĐỘC LẬP QUAN HỆ MỚI ---
  ✅ [PASS] Thiết lập thành công quan hệ chuẩn hóa "clarifies" (Làm rõ / Hướng dẫn áp dụng)
  ✅ [PASS] Quan hệ "clarifies" không làm văn bản cũ mất hiệu lực (vẫn giữ nguyên status: active)
  ✅ [PASS] Xóa sạch quan hệ kiểm thử, khôi phục nguyên vẹn database

--- PHẦN 5: TENANT BOUNDARY ISOLATION ---
  ✅ [PASS] GET /relationships/all với Admin STL thực thi thành công có kiểm soát Tenant

--- PHẦN 6: BẢO TOÀN DỮ LIỆU & RÀO CHẮN QC-DXM-2026-FLEX ---
  ✅ [PASS] Toàn vẹn số lượng văn bản: bảo lưu chính xác 21 văn bản
  ✅ [PASS] Toàn vẹn số lượng quan hệ: bảo lưu chính xác 3 quan hệ lịch sử
  ✅ [PASS] QC-DXM-2026-FLEX: Rào chắn truy xuất được bảo vệ tuyệt đối (pilot_unverified, restricted=true)

========================================================================
📊 KẾT QUẢ KIỂM THỬ TAXONOMY: 18 PASS, 0 FAIL (Tổng: 18)
========================================================================
```

### 6.2. Business-First Governance V2 Regression Suite (`test_business_first_v2.js`)
**Kết quả: 17 / 17 PASS (100%)**
- Xác nhận các chức năng Phân quyền Tenant, Phát hiện trùng SHA-256, Đối soát xung đột chính sách động, Lưu bản nháp (Draft) và Vòng đời 3 trục không bị ảnh hưởng tiêu cực.

---

## 7. BẢO TOÀN DỮ LIỆU & THÔNG TIN SAO LƯU

### 7.1. Trạng thái 3 quan hệ lịch sử được bảo toàn nguyên vẹn
| ID quan hệ | Loại quan hệ | Văn bản nguồn | Văn bản đích | Trạng thái phê duyệt | Ghi chú bảo lưu |
|---|---|---|---|:---:|---|
| `d084e3bc...` | `supplements` | 45/2024/QĐ-VTX | 18/2023/QC-SOTRANS | `pending_review` | Giữ nguyên chờ HR/Legal thẩm định |
| `20f280f3...` | `supersedes` | 15/QĐ-SOTRANS | 17/QĐ-LAODONG | `pending_review` | Giữ nguyên chờ HR/Legal thẩm định |
| `8610ca2a...` | `supplements` | QC-VPC-2024-V1 | QC-DXM-2026-FLEX | `approved` | Đã được SuperAdmin phê duyệt |

### 7.2. Rào chắn truy xuất của `QC-DXM-2026-FLEX`
- `status`: `active`
- `retrieval_mode`: `pilot_unverified`
- `is_restricted_general`: `true`
- Văn bản này tiếp tục được cách ly an toàn khỏi các câu hỏi thông thường của nhân viên chung.

### 7.3. Thư mục sao lưu an toàn
Toàn bộ mã nguồn và cơ sở dữ liệu trước khi thay đổi được niêm phong tại:
`D:\hoso-chat\backups\taxonomy_standardization_20261104\`
- `MANIFEST.json`: Bảng băm SHA-256 đối chiếu an toàn.
- `pg_taxonomy_backup.dump`: Bản sao lưu PostgreSQL đầy đủ (15,721,754 bytes).
- `hr-admin.html`: 546,426 bytes.
- `documents.js`: 65,411 bytes.
- `policyConflictDetector.js`: 12,689 bytes.

---

## 8. CÁC NỘI DUNG CẦN QUÝ BAN HR / ĐIỀU HÀNH XÁC NHẬN

1. **Phê duyệt chính thức 2 quan hệ văn bản đang chờ (`pending_review`):**
   - Quan hệ bổ sung `45/2024/QĐ-VTX` bổ sung phụ cấp công trường cho `18/2023/QC-SOTRANS`.
   - Quan hệ thay thế `15/QĐ-SOTRANS` thay thế quy định an toàn lao động `17/QĐ-LAODONG`.
   *(HR có thể bấm nút "Duyệt" trực tiếp tại cửa sổ Quan hệ văn bản trên giao diện mới được nâng cấp).*
2. **Quyết định sử dụng thực tế của loại quan hệ `applies_with`:**
   - Hệ thống đã chuẩn hóa và sẵn sàng cho phép HR sử dụng để liên kết tham chiếu các quy chế áp dụng song song. HR có thể bắt đầu sử dụng khi cần thiết lập các luồng chính sách tương hỗ.
3. **Mở rộng RAG n8n cho `clarifies`:**
   - Hiện tại n8n workflow đang lấy related chunks cho các quan hệ `('supplements', 'amends', 'exception_to')`.
   - Nếu HR muốn các văn bản hướng dẫn/làm rõ (`clarifies`) cũng tự động được chatbot trích xuất làm ngữ cảnh trả lời khi nhân viên hỏi văn bản gốc, đội ngũ kỹ thuật sẽ cập nhật câu truy vấn `PG Recheck` trong n8n khi được phê duyệt.
