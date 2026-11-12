# PHỤ LỤC 2: KIỂM TOÁN NĂNG LỰC PHÁT HIỆN THÔNG TIN TRÙNG LẶP & XUNG ĐỘT TÀI LIỆU
## SOTRANS HUB — DOCUMENT DUPLICATE & CONFLICT DETECTION AUDIT

**Ngày kiểm toán:** 04/11/2026  
**Phạm vi:** Module `policyConflictDetector.js`, API `/api/documents/check-duplicate`, `/api/documents/detect-conflicts`, và quy trình nạp tài liệu tại `chat/hr-admin.html`.

---

### I. ĐÁNH GIÁ 6 LOẠI TÌNH HUỐNG TRÙNG LẶP & XUNG ĐỘT

Theo yêu cầu chuẩn nghiệp vụ doanh nghiệp, hệ thống kiểm soát tài liệu cần phân biệt rạch ròi 6 loại tình huống:

```
                            PHÂN LOẠI QUAN HỆ NỘI DUNG VĂN BẢN
                                           │
         ┌─────────────────────────────────┴─────────────────────────────────┐
         ▼                                                                   ▼
   [NHÓM TRÙNG LẶP]                                                    [NHÓM ĐIỀU CHỈNH / XUNG ĐỘT]
         │                                                                   │
   ┌─────┴──────────────────┐                                          ┌─────┴──────────────────┐
   ▼                        ▼                                          ▼                        ▼
Loại A: Trùng tệp       Loại B: Trùng văn bản                    Loại D: Bổ sung          Loại E: Sửa đổi/Ngoại lệ
(Exact SHA-256)         (Cùng mã, khác format)                   (Complementary)          (Amends / Exception)
                            │                                                                   │
                            ▼                                                                   ▼
                        Loại C: Trùng thông tin                                            Loại F: Mâu thuẫn thực sự
                        (Information Duplication)                                          (Semantic Conflict)
```

---

#### 1. Loại A: Trùng file nhị phân (Exact Duplicate — SHA-256)
- **Cơ chế hiện tại:** Sử dụng thuật toán SHA-256 tính mã băm nội dung tệp nhị phân (`file_sha256`).
- **Khâu thực hiện:**
  - Client-side: `computeFileSha256(f)` tính toán ngay khi chọn tệp tại giao diện tiếp nhận.
  - Server-side: `POST /api/documents` và `POST /api/documents/check-duplicate` kiểm tra trong bảng `documents`.
- **Đánh giá:** **L4 — VERIFIED.** Chặn 100% tình trạng người dùng vô tình tải lại cùng một tệp PDF/Word đã có trong kho dữ liệu (HTTP 409 Conflict).

#### 2. Loại B: Trùng tài liệu (Document Duplicate — Khác định dạng, cùng văn bản)
- **Cơ chế hiện tại:** Đối chiếu theo trường `doc_code` và `doc_number` thông qua truy vấn `ILIKE`.
- **Khâu thực hiện:** Cảnh báo khi người dùng nhập hoặc hệ thống tự động nhận diện mã văn bản đã tồn tại trong CSDL.
- **Lỗ hổng phát hiện:**
  - Nếu hai tệp cùng nội dung nhưng một tệp không có số hiệu (văn bản nội bộ/dự thảo) hoặc người dùng đặt tiêu đề khác nhau, hệ thống **không phát hiện được** đây là cùng một văn bản.
- **Đánh giá:** **L2 — PARTIAL.** Chỉ phát hiện khi có `doc_code` trùng khớp.

#### 3. Loại C: Trùng thông tin (Information Duplication)
- **Tình huống:** Quy định A và Chính sách B cùng ghi: *"Thời gian làm việc từ 08:00 đến 17:00"*.
- **Hành vi thực tế của hệ thống:**
  - `policyConflictDetector.js` nhận diện cả hai văn bản có chung topic `thoi_gio_lam_viec` và cùng áp dụng cho toàn công ty (`scope = all`).
  - Hệ thống lập tức đánh cờ: **`Xung đột chính sách trực tiếp (HIGH: POLICY_CONTRADICTION)`**!
- **Hạn chế nghiêm trọng:** Hệ thống tạo ra **Báo động giả (False Positive)**. Hai văn bản đồng thuận hoàn toàn về thông tin lại bị hệ thống coi là mâu thuẫn đối kháng và chặn phê duyệt.
- **Đánh giá:** **L1 — BASIC (Cần cải tiến).**

#### 4. Loại D: Thông tin bổ sung (Complementary Information)
- **Tình huống:** Quy chế A quy định giờ làm việc chung (08:00–17:00). Quy định B quy định thời gian nghỉ trưa và nghỉ giữa ca (12:00–13:00).
- **Hành vi thực tế của hệ thống:**
  - Regex trong `extractCoreTopics` gom cả `gio lam viec` và `nghi trua` vào cùng một topic `thoi_gio_lam_viec`.
  - Nếu cả hai văn bản cùng áp dụng cho toàn công ty, hệ thống tiếp tục đánh cờ **`HIGH: POLICY_CONTRADICTION`**.
- **Hạn chế:** Không nhận diện được hai thông tin tương hỗ, có thể áp dụng đồng thời.
- **Đánh giá:** **L1 — BASIC.**

#### 5. Loại E: Sửa đổi một phần & Ngoại lệ (Amendment / Exception)
- **Tình huống:** Quy chế chung áp dụng toàn công ty, Quyết định mới áp dụng riêng cho Đội xe hoặc Khối Kho bãi.
- **Hành vi thực tế của hệ thống:**
  - Về mặt thiết kế: Hệ thống có hàm `isNarrowerScope` để phát hiện phạm vi hẹp hơn và chuyển sang cảnh báo `MEDIUM: UNLINKED_SPECIALIZATION`.
  - **Lỗi kỹ thuật nghiêm trọng (Bug phát hiện trong đợt kiểm toán):**
    ```javascript
    const isFullyOverlappingScope = branchOverlap && deptOverlap && buOverlap && egOverlap;
    ```
    Trong đó hàm `isScopeOverlapping` quy định: nếu một mảng chứa `'all'` thì luôn trả về `true`. Do đó, khi văn bản hiện hành áp dụng cho `{all}`, thì `isFullyOverlappingScope` **luôn luôn bằng true**, khiến cho nhánh `else if (isSpecializedScope)` **không bao giờ được chạy**!
  - **Hậu quả:** Mọi văn bản đặc thù phòng ban/nhóm nhân sự đều bị hệ thống phân loại nhầm thành xung đột trực tiếp `HIGH` thay vì `MEDIUM` ngoại lệ.
- **Đánh giá:** **FAIL (Lỗi logic cần vá).**

#### 6. Loại F: Mâu thuẫn thực sự (Semantic Conflict)
- **Tình huống:** Quy chế A quy định vào làm lúc 08:00. Chính sách B quy định vào làm lúc 08:30 (cùng phạm vi, cùng thời kỳ hiệu lực).
- **Hành vi thực tế:** Phát hiện và chặn phê duyệt thành công nếu nằm trong 5 chủ đề hardcoded.
- **Lỗ hổng chí mạng:** Nếu mâu thuẫn về các chủ đề khác (ví dụ: thời gian thử việc 30 ngày vs 60 ngày, bồi hoàn chi phí đào tạo 10 triệu vs 20 triệu, quy trình phê duyệt 2 bước vs 3 bước), hệ thống **bỏ sót 100% (False Negative)** vì không khớp regex từ khóa.
- **Đánh giá:** **L2 — PARTIAL.**

---

### II. CÁC LỖ HỔNG KỸ THUẬT & LOGIC ĐƯỢC PHÁT HIỆN QUA KIỂM TOÁN

#### Lỗ hổng 1: Lỗi chuẩn hóa ký tự tiếng Việt "đ/Đ" trong `extractCoreTopics`
- **Vị trí:** `auth-service/services/policyConflictDetector.js` (dòng 51–57).
- **Nguyên nhân:**
  ```javascript
  const norm = String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  ```
  Trong bảng mã Unicode, ký tự `đ` và `Đ` (U+0111, U+0110) không phải là tổ hợp dấu thanh (combining diacritics), do đó `normalize('NFD')` không phân rã `đ` thành `d`. Ký tự `đ` vẫn giữ nguyên là `đ`.
- **Hậu quả:**
  - Regex dòng 65: `/an\s*toan\s*lao\s*dong/` sử dụng chữ `d`. Khi gặp chuỗi `an toan lao đong`, chuỗi kiểm tra **trả về false**!
  - **Bằng chứng kiểm chứng:** Văn bản `An toàn lao động (Bản cập nhật)` (Mã 15/QĐ-SOTRANS) khi đưa vào hàm `extractCoreTopics` trả về mảng rỗng `[]`. Hệ thống hoàn toàn không phát hiện được bất kỳ xung đột nào liên quan đến an toàn lao động!
- **Mức độ rủi ro:** **P1 — CAO (Lỗi cốt lõi làm mất tác dụng phát hiện xung đột an toàn lao động).**

#### Lỗ hổng 2: Lỗi logic `isFullyOverlappingScope` nuốt mất nhánh `isSpecializedScope`
- **Vị trí:** `auth-service/services/policyConflictDetector.js` (dòng 173–178, 212–240).
- **Nguyên nhân:**
  Khi so sánh văn bản mới có `department_scope: ['Khai thác Kho bãi']` với văn bản cũ có `department_scope: ['all']`:
  - `deptOverlap` trả về `true` (vì tập `all` bao hàm Kho bãi).
  - `isFullyOverlappingScope` được tính bằng `branchOverlap && deptOverlap && buOverlap && egOverlap` $\rightarrow$ Kết quả là `true`.
  - Khối lệnh `if (isFullyOverlappingScope)` bắt toàn bộ các trường hợp, đẩy thành `HIGH: POLICY_CONTRADICTION`. Nhánh `isSpecializedScope` bị tê liệt.
- **Hậu quả:** Không thể phân biệt được văn bản quy định chung và văn bản đặc thù của phòng ban.
- **Mức độ rủi ro:** **P1 — CAO.**

#### Lỗ hổng 3: Đối chiếu xung đột chỉ đọc tiêu đề văn bản cũ (`doc.title`), bỏ qua toàn văn
- **Vị trí:** `auth-service/services/policyConflictDetector.js` (dòng 184–185).
- **Code hiện tại:**
  ```javascript
  const docText = `${doc.title} ${doc.doc_code || ''}`;
  const docTopics = extractCoreTopics(docText);
  ```
- **Hậu quả:** Đối với các văn bản đang áp dụng trong hệ thống, detector **chỉ đọc đúng tiêu đề và mã số** để tìm chủ đề. Nếu một văn bản có tiêu đề chung như *"Nội quy lao động"* nhưng bên trong có quy định về *phụ cấp*, *nghỉ phép*, *trang phục bảo hộ*... thì hệ thống hoàn toàn không biết văn bản đó chứa các quy định này, dẫn đến bỏ sót xung đột nằm sâu trong các điều khoản.
- **Mức độ rủi ro:** **P0 — NGHIÊM TRỌNG (Gây lọt xung đột chính sách trong doanh nghiệp).**

#### Lỗ hổng 4: Thiếu kiểm soát xung đột tại Backend API (`POST /api/documents`)
- **Vị trí:** `auth-service/routes/documents.js` (dòng 550–650).
- **Hiện trạng:**
  - Việc kiểm tra xung đột chỉ được gọi chủ động từ Frontend thông qua API `POST /api/documents/detect-conflicts`.
  - Tại endpoint tạo tài liệu `POST /api/documents`, hệ thống **chỉ kiểm tra duy nhất mã băm SHA-256** để chống trùng file; hoàn toàn **không gọi `detectPolicyConflicts`** và không có bất kỳ rào cản ngăn chặn nào nếu tài liệu được gửi trực tiếp qua API hoặc công cụ tự động.
- **Mức độ rủi ro:** **P2 — TRUNG BÌNH.**

---

### III. BẢNG SO SÁNH GIỮA THỰC TRẠNG VÀ CHUẨN NGHIỆP VỤ

| Tiêu chí nghiệp vụ | Trạng thái hệ thống hiện tại | Chuẩn nghiệp vụ doanh nghiệp | Đánh giá khoảng cách |
| :--- | :--- | :--- | :---: |
| **Phát hiện trùng tệp 100%** | Dùng SHA-256, chặn tức thì tại client & server | Bắt buộc có | **ĐẠT (L4)** |
| **Phát hiện trùng mã hiệu văn bản** | Query CSDL theo `doc_code ILIKE` | Bắt buộc có | **ĐẠT (L3)** |
| **Phân biệt trùng thông tin vs mâu thuẫn** | Đánh đồng toàn bộ thành `POLICY_CONTRADICTION` | Phải phân biệt rõ để không cản trở ban hành văn bản | **CHƯA ĐẠT (L1)** |
| **Nhận diện thông tin bổ sung** | Gom chung vào topic và báo xung đột trực tiếp | Nhận diện quan hệ `supplements` tương hỗ | **CHƯA ĐẠT (L1)** |
| **Nhận diện văn bản đặc thù / ngoại lệ** | Có code nhưng bị lỗi logic `isFullyOverlappingScope` | Tự động đề xuất `exception_to` cho đơn vị hẹp | **LỖI LOGIC (L2)** |
| **Phát hiện mâu thuẫn số liệu (Entity)** | Không có module bóc tách số học (VND, Ngày, Giờ) | So sánh giá trị số để phát hiện chênh lệch | **CHƯA CÓ (L0)** |
| **Phạm vi chủ đề quét xung đột** | Giới hạn cứng trong 5 regex hardcoded | Quét toàn diện mọi chủ đề quy chế doanh nghiệp | **THIẾU SÓT (L1)** |
| **Độ sâu phân tích văn bản hiện hành** | Chỉ đọc `title` và `doc_code` của văn bản cũ | Phải quét toàn bộ chunks nội dung điều khoản | **NGHIÊM TRỌNG (L1)** |

---

### IV. KẾT QUẢ KHẮC PHỤC GIAI ĐOẠN 1 (HOTFIX ENGINE NGÀY 04/11/2026)

Hệ thống đã triển khai thành công bản vá cho `auth-service/services/policyConflictDetector.js` và nghiệm thu thực tế:

1. **Khắc phục Lỗ hổng 1 (Chuẩn hóa chữ "đ"):**
   - Đã tích hợp hàm `normalizeVietnamese()` chuẩn hóa `đ/Đ` thành `d`.
   - Kết quả: Tiêu đề *"An toàn lao động (Bản cập nhật)"* trích xuất chuẩn xác topic `['an_toan_lao_dong']`, khôi phục 100% năng lực đối soát an toàn.

2. **Khắc phục Lỗ hổng 2 (Lỗi logic phạm vi đặc thù):**
   - Đã tách bạch `isIdenticalScope` và `isNarrowerScope`.
   - Khi văn bản mới áp dụng cho phòng ban/nhóm nhân sự hẹp hơn quy chế chung `{all}`, hệ thống phân loại đúng `UNLINKED_SPECIALIZATION` (Cảnh báo MEDIUM) và gợi ý thiết lập quan hệ `exception_to`.
   - Nghiệm thu: Cả 2 kịch bản **TC10 (Kho bãi)** và **TC13 (Lái xe container)** đều đã chuyển sang **PASS**.

3. **Khắc phục Lỗ hổng 3 (Độ sâu phân tích điều khoản):**
   - Đã mở rộng truy vấn SQL quét thêm `chunk_content` (tối đa 12.000 ký tự từ các chunks đã lưu trong PostgreSQL).
   - Minh chứng trích dẫn (`evidenceQuote`) tự động tìm và ưu tiên trích lục chính xác đoạn văn bản (`section_path` & nội dung) khớp với chủ đề chung thay vì chỉ hiển thị tiêu đề chung.

4. **Tích hợp kiểm tra trùng lặp tập tin & mã hiệu:**
   - Bổ sung phát hiện trực tiếp `EXACT_DUPLICATE_FILE` (SHA-256) và `DUPLICATE_DOC_CODE` (Mã hiệu văn bản) ngay trong báo cáo xung đột trước khi lưu.

---
*Tài liệu này là phụ lục kỹ thuật đi kèm Báo cáo kiểm toán toàn diện `COMPREHENSIVE_DOCUMENT_GOVERNANCE_BUSINESS_AUDIT.md`.*
