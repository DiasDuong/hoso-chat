# KẾT QUẢ KIỂM THỬ HỒI QUY TOÀN DIỆN (REGRESSION TEST RESULTS)
**Dự án:** SOTRANS AI Workspace — `D:\hoso-chat`  
**Bộ test:** `tests/rag_policy_regression_suite.js`  
**File kết quả chi tiết:** `tests/rag_policy_regression_report.json`  
**Thời gian thực thi:** 26/10/2026 14:03 (Giờ địa phương)  
**Kết quả chung:** **12 / 12 SCENARIOS PASS (100.0%)**

---

## 1. BẢNG TỔNG HỢP 12 KỊCH BẢN KIỂM THỬ (REGRESSION MATRIX)

| STT | Mã kịch bản | Mô tả kịch bản kiểm thử | Kết quả | Thời gian phản hồi |
| :---: | :--- | :--- | :---: | :---: |
| 1 | `SCENARIO_01_GENERAL_LUNCH` | Câu hỏi chung về thời gian nghỉ trưa: phân định rõ khung chuẩn tập đoàn (12h-13h) vs ca đặc thù (12h30-13h30) | **PASS** | 5.2s |
| 2 | `SCENARIO_02_OFFICE_LUNCH` | Câu hỏi riêng cho khối văn phòng: trả lời trực diện đối tượng khối văn phòng và điều kiện phân ca | **PASS** | 4.8s |
| 3 | `SCENARIO_03_FOLLOWUP_NARROWING` | Câu hỏi tiếp nối thu hẹp đối tượng (*"Thế còn khối văn phòng thì sao?"*): giải quyết ngữ cảnh từ lượt trước | **PASS** | 5.1s |
| 4 | `SCENARIO_04_FOLLOWUP_CHANGING` | Câu hỏi tiếp nối thay đổi đối tượng (*"Thế còn khối hiện trường hoặc lái xe?"*): chuyển đổi trọng tâm chính xác | **PASS** | 4.6s |
| 5 | `SCENARIO_05_POLICY_DIFFERING` | Quy chế tập đoàn vs Quy định ca văn phòng có thời gian nghỉ khác nhau: giải thích phạm vi áp dụng không mâu thuẫn | **PASS** | 5.0s |
| 6 | `SCENARIO_06_BOTH_AGREE` | Hai văn bản cùng đồng thuận về ngày làm việc (Thứ Hai đến Thứ Sáu): câu trả lời thống nhất, nhất quán | **PASS** | 4.4s |
| 7 | `SCENARIO_07_SOURCES_CONFLICT` | Văn bản mâu thuẫn không rõ thứ bậc: trợ lý nêu rõ sự không nhất quán và khuyến nghị liên hệ phòng Nhân sự | **PASS** | 4.9s |
| 8 | `SCENARIO_08_MISSING_CLAUSE` | Điều khoản hoàn toàn không có trong tài liệu: trả lời `answerable: false`, cung cấp số điện thoại/email phòng Nhân sự | **PASS** | 4.1s |
| 9 | `SCENARIO_09_REVOKED_VS_CURRENT` | Bản cũ đã thu hồi (v2) vs Bản hiện tại (v3): chỉ trích dẫn v3, loại bỏ hoàn toàn bản đã thu hồi khỏi nguồn | **PASS** | 4.7s |
| 10 | `SCENARIO_10_CACHE_INVALIDATION` | Kiểm thử tầng Cache: Lần 1 Miss, Lần 2 Hit tức thời, sửa phiên bản tài liệu trong DB $\rightarrow$ Lần 3 Miss & tính lại | **PASS** | 0.05s (Hit) / 5.1s (Miss) |
| 11 | `SCENARIO_11_TENANT_ISOLATION` | Phân quyền công ty/chi nhánh: Nhân viên SWC xem được văn bản Sowatco, nhân viên STL bị chặn xem văn bản SWC | **PASS** | 4.5s |
| 12 | `SCENARIO_12_SEMANTIC_DISTINCTION` | Câu hỏi tương đồng ngữ nghĩa (làm thêm giờ / tăng ca vs nghỉ trưa): trích dẫn đúng chế độ làm thêm giờ, không nhầm lẫn | **PASS** | 4.3s |

---

## 2. ĐỐI CHIẾU THỰC TẾ TRƯỚC VÀ SAU KHI SỬA (BEFORE VS AFTER EVIDENCE)

### 2.1 Câu hỏi A: "Thời gian nghỉ trưa như thế nào?"

#### Trước khi sửa (Lỗi):
> *"Thời gian nghỉ trưa theo quy định được nêu trong các văn bản như sau:*
> *- Khung thời giờ làm việc chuẩn toàn tập đoàn: thời gian nghỉ giữa ca và nghỉ trưa là từ 12:00 đến 13:00 (60 phút).*
> *- Quy định thời gian làm việc: thời gian nghỉ trưa từ 12:30 đến 13:30 (60 phút).*
> *Nguồn: Bo Quy che Lao dong & Thoi gio lam viec Toan tap doan SOTRANS; Quy dinh Thoi gian Lam viec Khong Van phong (Ca 09h30)"*
*(Không có giải thích tại sao có 2 mốc thời gian, nhân viên áp dụng khung nào)*

#### Sau khi sửa (Đã khắc phục hoàn toàn):
> *"Quy định về thời gian nghỉ trưa được phân định rõ theo quy chế toàn tập đoàn và các ca làm việc đặc thù như sau:*
> 
> *1. **Khung chuẩn toàn tập đoàn** (Áp dụng cho toàn bộ cán bộ công nhân viên thuộc Tập đoàn SOTRANS và các công ty thành viên): Thời gian nghỉ giữa ca và nghỉ trưa là từ **12:00 đến 13:00 (60 phút)**.*
> 
> *2. **Trường hợp ca làm việc đặc thù** (Khối văn phòng áp dụng ca 09:30 theo văn bản HR-TG-002): Đối với nhân viên được xếp lịch làm việc theo ca đặc thù này (bắt đầu từ 09:30 đến 18:30), thời gian nghỉ trưa bắt đầu từ **12:30 đến 13:30 (tổng cộng 60 phút)**.*
> 
> *\* Lưu ý: Nếu không thuộc ca làm việc đặc thù được quy định riêng tại đơn vị, nhân viên áp dụng khung giờ nghỉ trưa chuẩn từ 12:00 đến 13:00 của toàn tập đoàn.*
> 
> ***Nguồn:** Bo Quy che Lao dong & Thoi gio lam viec Toan tap doan SOTRANS (Điều 1); Quy định Thời gian Làm việc - Khối Văn phòng (Ca 09h30) (Điều 2)*"

---

### 2.2 Câu hỏi B: "Thời gian nghỉ trưa của khối văn phòng như thế nào?"

#### Trước khi sửa (Lỗi):
> Trả lời y hệt Câu hỏi A, liệt kê cả 12:00-13:00 và 12:30-13:30 cạnh nhau mà không nhấn mạnh trọng tâm đối tượng khối văn phòng.

#### Sau khi sửa (Đã khắc phục hoàn toàn):
> *"Thời gian nghỉ trưa của khối văn phòng được quy định tùy thuộc vào chế độ làm việc áp dụng:*
> 
> *1. **Khung thời giờ làm việc chuẩn toàn tập đoàn** (áp dụng mặc định chung cho cán bộ công nhân viên khối văn phòng toàn tập đoàn SOTRANS): Thời gian nghỉ giữa ca và nghỉ trưa là từ **12:00 đến 13:00 (60 phút)**.*
> 
> *2. **Khung giờ làm việc đặc thù theo ca** (áp dụng cho nhân viên khối văn phòng làm việc theo ca 09:30 tại Công ty mẫu ABC theo văn bản HR-TG-002): Thời gian nghỉ trưa bắt đầu từ **12:30 đến 13:30 (tổng cộng 60 phút)**.*
> 
> *\* Lưu ý: Vì có sự khác biệt giữa khung giờ chuẩn toàn tập đoàn và ca đặc thù, bạn vui lòng xác nhận lại với bộ phận Nhân sự hoặc Trưởng bộ phận xem mình đang thuộc đối tượng áp dụng văn bản/ca làm việc nào để tuân thủ chính xác.*
> 
> ***Nguồn:** Bo Quy che Lao dong & Thoi gio lam viec Toan tap doan SOTRANS (Điều 1); Quy định Thời gian Làm việc - Khối Văn phòng (Ca 09h30) (Điều 2, Phạm vi áp dụng)*"

---

### 2.3 Phân quyền công ty cô lập tuyệt đối (Tenant Isolation)
- Khi nhân viên **STL** (`emp_stl`, công ty SOTRANS Logistics) hỏi câu hỏi B:
  - Hệ thống tự động lọc `branch_scope = ['all', 'sotrans_logistics']`.
  - Văn bản ca 09h30 của Sowatco (`branch_scope = ['sowatco']`) **bị loại bỏ hoàn toàn khỏi kết quả tìm kiếm**.
  - Trợ lý AI trả lời trực tiếp:
    > *"Khung thời giờ làm việc và nghỉ trưa chuẩn toàn tập đoàn (áp dụng chung cho cán bộ công nhân viên khối văn phòng và toàn tập đoàn SOTRANS) quy định thời gian nghỉ giữa ca và nghỉ trưa là từ 12:00 đến 13:00 (tổng cộng 60 phút)."*
  - **Nguồn:** Duy nhất `Bo Quy che Lao dong & Thoi gio lam viec Toan tap doan SOTRANS` (01/QC-SOTRANS, v1). Không hề bị lộ văn bản ca 09:30 của công ty thành viên khác!
