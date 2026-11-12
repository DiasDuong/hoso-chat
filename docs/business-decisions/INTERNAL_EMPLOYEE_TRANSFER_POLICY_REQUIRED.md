# SOTRANS GROUP — YÊU CẦU BAN HÀNH CHÍNH SÁCH ĐIỀU CHUYỂN NHÂN SỰ NỘI BỘ TẬP ĐOÀN
## CORPORATE EMPLOYEE TRANSFER & IDENTITY LIFECYCLE DECISION PACKAGE
**Mã tài liệu:** `POLICY-REQ-INTERNAL-TRANSFER-2026-01`  
**Dự án:** SOTRANS Hub (Hệ thống Thông tin Nhân sự & Quản trị Hồ sơ Tập đoàn)  
**Đơn vị gửi:** Đội ngũ Kỹ thuật Hệ thống SOTRANS Hub  
**Kính gửi:** Ban Giám đốc Tập đoàn, Khối Quản trị Nguồn nhân lực SOTRANS Group  
**Ngày lập:** 29/10/2026  
**Trạng thái hiện tại:** **`PENDING CORPORATE LEADERSHIP APPROVAL` — BẮT BUỘC CHẶN PHÊ DUYỆT TRÊN HỆ THỐNG**

---

## 1. BỐI CẢNH VÀ VẤN ĐỀ CẦN QUYẾT ĐỊNH

### 1.1. Hiện trạng trên hệ thống SOTRANS Hub
Trong đợt nghiệm thu kỹ thuật phân hệ HR Staging Multi-Round và quy chuẩn kiểm soát số định danh cá nhân (**BIZ-CCCD-01**), hệ thống đã phát hiện tình huống nghiệp vụ:
> Một nhân sự đang làm việc hoặc đã có dữ liệu tại một công ty thành viên (ví dụ: Sowatco - SWC), sau đó được nộp hồ sơ tuyển dụng mới hoặc chuyển sang đơn vị thành viên khác (ví dụ: SOTRANS Logistics - STL hoặc Vietranstimex - VTX).

### 1.2. Phân loại 3 trường hợp nghiệp vụ phân biệt
Hệ thống phần mềm phân định rạch ròi 3 tình huống kỹ thuật và nghiệp vụ khác nhau:
1. **Trường hợp 1 — Trùng lặp CCCD do nộp lặp (Duplicate Submission):** Cùng một nhân sự được nộp nhiều lần vào cùng một công ty hoặc nộp lặp tệp scan. Đây là lỗi thao tác của người nộp -> **Xử lý:** Từ chối tiếp nhận, hủy bản ghi lặp.
2. **Trường hợp 2 — Điều chuyển nhân sự nội bộ (Internal Transfer):** Nhân sự đã tồn tại hợp pháp tại công ty thành viên A nhưng được chuyển sang công tác tại công ty thành viên B của Tập đoàn -> **Xử lý:** Cần quy trình điều chuyển nội bộ chính thức, không thể tiếp nhận như một nhân sự mới toanh.
3. **Trường hợp 3 — Sai lệch pháp nhân tiếp nhận (Company Mismatch):** Hồ sơ scan mang pháp nhân của đơn vị A (hợp đồng lao động, quyết định của A) nhưng trên giao diện staging lại chọn đơn vị tiếp nhận B -> **Xử lý:** Chặn phê duyệt cho đến khi HR đính kèm Quyết định tiếp nhận/điều động chính thức hoặc chọn đúng đơn vị.

---

## 2. BẢNG MA TRẬN QUYẾT ĐỊNH NGHIỆP VỤ TRÌNH BAN LÃNH ĐẠO (BUSINESS DECISION TABLE)

Bảng dưới đây liệt kê đầy đủ 7 nhóm nghiệp vụ nhân sự trọng yếu, trạng thái phê duyệt thực tế, người có thẩm quyền ký duyệt, nguồn văn bản căn cứ, điều kiện cho phép và điều kiện bắt buộc chặn:

| STT | Nghiệp vụ cụ thể | Trạng thái phê duyệt | Người có thẩm quyền phê duyệt | Nguồn văn bản phê duyệt | Điều kiện được phép tạo / thực hiện | Điều kiện bắt buộc chặn (Fail-Closed) | Cách lưu lịch sử kiểm toán (Audit Trail) |
|:---:|---|:---:|---|---|---|---|---|
| **1** | **Nhân viên trùng CCCD do hồ sơ nhập lặp** | `APPROVED IN SYSTEM` | Quản trị viên (ADMIN) / Chuyên viên HR sở tại | Báo cáo `FINAL-08` & Quy chuẩn BIZ-CCCD-01 | Cho phép nộp bổ sung tài liệu vào cùng 1 mã hồ sơ (Multi-Round Intake) | Chặn tạo mới nếu trùng CCCD trong cùng công ty hoặc trùng tệp scan gốc | Ghi `auth_audit_logs` với action `intake_duplicate_rejected` kèm staging ID và hash tệp |
| **2** | **Điều chuyển nhân sự giữa STL, SWC và VTX** | **`PENDING`** | Tổng Giám đốc Tập đoàn / Trưởng ban Nhân sự Tập đoàn | *Chưa ban hành (Cần quyết định văn bản)* | Có văn bản Quyết định điều chuyển nội bộ hợp lệ của Tập đoàn được đính kèm | Chặn cứng phê duyệt nếu CCCD đang ACTIVE tại công ty thành viên khác | Ghi log `auth_audit_logs` với action `employee_transfer_blocked` và lý do `CROSS_COMPANY_DUPLICATE` |
| **3** | **Nhân viên nghỉ việc (RESIGNED)** | `APPROVED IN SYSTEM` | Giám đốc Nhân sự đơn vị / Quản trị viên (ADMIN) | Quy chế quản lý lao động SOTRANS | Có ngày nghỉ việc (`resignation_date`) và lý do (`resignation_reason`) | Chặn nếu tài khoản thao tác là HR công ty khác hoặc không cung cấp ngày nghỉ việc | Ghi log `employee_resigned`, tự động khóa tài khoản user liên kết sang `INACTIVE` |
| **4** | **Xóa mềm hồ sơ nhân sự (SOFT DELETE)** | `APPROVED IN SYSTEM` | Quản trị viên hệ thống (ADMIN / SUPER_ADMIN) | Quy chuẩn Quản trị Dữ liệu SOTRANS Hub | Chỉ Quản trị viên toàn hệ thống thao tác khi hồ sơ tạo sai hoặc hủy bỏ | Chặn hoàn toàn vai trò Chuyên viên Nhân sự (HR) không có quyền xóa mềm | Ghi log `employee_deleted`, chuyển trạng thái `DELETED`, thêm nhãn `[ĐÃ XÓA]` |
| **5** | **Khôi phục hồ sơ đã xóa mềm (RESTORE)** | `APPROVED IN SYSTEM` | Quản trị viên hệ thống (ADMIN / SUPER_ADMIN) | Quy chuẩn Khôi phục dữ liệu `FINAL-08` | Hồ sơ đang ở trạng thái `DELETED` và số CCCD không bị chiếm dụng bởi nhân sự ACTIVE khác | Chặn nếu vai trò là HR; chặn nếu số CCCD đang được sử dụng bởi nhân sự ACTIVE khác (HTTP 409) | Ghi log `employee_restored` kèm transaction lock `hashtext('cccd:' || cleanCccd)` |
| **6** | **Tái kích hoạt / Tái tuyển dụng cựu nhân viên (REHIRE)** | **`PENDING POLICY`** (Kỹ thuật: Sẵn sàng) | Giám đốc Nhân sự đơn vị / Quản trị viên (ADMIN) | Quyết định tuyển dụng lại & Văn bản phê duyệt Ban Giám đốc | Hồ sơ đang ở trạng thái `RESIGNED`, có Số quyết định tiếp nhận (`decision_no`), Căn cứ (`rehire_reason`) và CCCD không trùng nhân sự ACTIVE khác | Chặn nếu HR công ty khác thao tác; chặn nếu nhân viên bị ADMIN cho thôi việc; chặn nếu CCCD đang ACTIVE ở đơn vị khác (HTTP 409) | Ghi log `employee_reactivated` kèm metadata quyết định, gỡ nhãn `[NGHỈ VIỆC]`, mở lại tài khoản |
| **7** | **Quyền truy cập thông tin nhân sự & Lương liên công ty** | **`PENDING`** | Ban Pháp chế & Giám đốc Nhân sự Tập đoàn | *Chưa ban hành (Cần ký thỏa thuận bảo mật NDA)* | ADMIN xem được họ tên, mã nhân viên, đơn vị để phối hợp điều chuyển | Chặn HR xem thông tin đơn vị khác (403); Đang chờ phê duyệt việc ADMIN xem Lương liên công ty | Ghi log truy cập chi tiết hồ sơ `employee_view_detail` và `staging_view_detail` |

---

## 3. NHỮNG HÀNH VI HỆ THỐNG BẮT BUỘC TIẾP TỤC CHẶN KHI CHƯA CÓ CHÍNH SÁCH

Để bảo vệ tính toàn vẹn dữ liệu, ranh giới pháp nhân giữa các công ty thành viên độc lập và an toàn pháp lý lao động, **hệ thống SOTRANS Hub hiện đang áp dụng cơ chế chặn cứng (Strict Blocking Guard)**:
1. **Tuyệt đối không tự động tạo mới hồ sơ nhân viên (`employees`)** nếu số CCCD đã tồn tại ở bất kỳ công ty thành viên nào khác.
2. **Tuyệt đối không tự động ghi đè công ty (`company_id`)** của nhân sự hiện có sang công ty mới khi chưa có quyết định điều động.
3. **Tuyệt đối không cấp quyền cho Quản trị viên (ADMIN) bỏ qua chốt chặn (Bypass Guard)** để duyệt hồ sơ trùng CCCD của công ty khác vào danh mục nhân viên chính thức.
4. Nút **"Phê duyệt chính thức"** trên giao diện tiếp nhận Staging bị **VÔ HIỆU HÓA (DISABLED)** và hiển thị rõ lý do: `Bị chặn do trùng CCCD liên công ty (BIZ-CCCD-01)`.

---

## 4. CÁC PHƯƠNG ÁN NGHIỆP VỤ ĐỀ XUẤT ĐỂ BAN LÃNH ĐẠO XEM XÉT

| Tiêu chí | Phương án A: Điều chuyển Lịch sử (Single Master Profile) | Phương án B: Chấm dứt & Tuyển mới (Rehire Lifecycle) | Phương án C: Đa Hợp đồng Đồng thời (Concurrent Employment) |
| :--- | :--- | :--- | :--- |
| **Bản chất nghiệp vụ** | Nhân sự giữ nguyên hồ sơ gốc, chuyển đơn vị công tác và cấp mã nhân viên mới theo đơn vị mới. | Nhân sự chính thức thôi việc tại đơn vị cũ (thanh lý HĐLĐ), sau đó tuyển mới tại đơn vị mới. | Nhân sự kiêm nhiệm hoặc làm việc đồng thời tại 2 đơn vị thuộc tập đoàn. |
| **Mã nhân viên (Employee Code)** | Cấp mã mới theo tiền tố công ty mới (ví dụ: `SWC-088` -> `STL-199`), lưu liên kết mã cũ. | Cấp mã mới tại công ty mới; mã cũ chuyển trạng thái `RESIGNED`. | Có 2 mã nhân viên hoạt động độc lập tương ứng với 2 pháp nhân. |
| **Số CCCD / Hồ sơ cá nhân** | 1 bản ghi duy nhất trong `hr_employee_profiles`, cập nhật `company_id` sang đơn vị mới. | 1 bản ghi `hr_employee_profiles`, ghi nhận lịch sử các giai đoạn công tác. | Bảng `hr_employee_profiles` giữ unique CCCD; bảng `employees` cho phép liên kết 2 hợp đồng. |
| **Lịch sử lương & Hợp đồng** | Tách kỳ tính lương theo thời điểm có hiệu lực của Quyết định điều chuyển. | Kết thúc nghĩa vụ tài chính tại đơn vị cũ, mở sổ bảo hiểm/hợp đồng mới tại đơn vị mới. | Hai bảng lương riêng biệt tại hai pháp nhân. |
| **Quyền truy cập hệ thống** | Tự động chuyển quyền và dữ liệu phòng ban theo đơn vị mới. | Khóa tài khoản cũ, mở tài khoản người dùng gắn với đơn vị mới. | Người dùng có cơ chế chuyển đổi ngữ cảnh (Context Switching) giữa các công ty. |
| **Độ phức tạp kỹ thuật** | Trung bình — Phù hợp nhất với mô hình Tập đoàn SOTRANS. | Thấp — Dùng toàn bộ quy trình thôi việc (`RESIGNED`) và tuyển lại hiện có. | Rất cao — Cần tái cấu trúc toàn diện kiến trúc phân quyền và CSDL. |

---

## 5. CÁC CÂU HỎI MỞ CẦN BAN NHÂN SỰ TRẢ LỜI ĐỂ MỞ KHÓA GOLIVE

1. **Văn bản pháp lý điều chuyển:** Khi nhân sự chuyển từ Sowatco sang SOTRANS Logistics, hợp đồng lao động tại Sowatco được xử lý theo hình thức:
   - *Phụ lục điều chuyển nội bộ tập đoàn (giữ nguyên thâm niên liên tục)*, hay
   - *Thỏa thuận chấm dứt HĐLĐ tại Sowatco và ký HĐLĐ mới tại STL*?
2. **Thời gian bàn giao công việc:** Trong thời gian chuyển giao công việc (1-2 tuần), nhân sự có được phép duy trì trạng thái hoạt động song song tại cả hai đơn vị không?
3. **Thẩm quyền phê duyệt điện tử:** Ai là người có thẩm quyền ký và tải lên "Quyết định điều chuyển công tác" làm căn cứ mở khóa phê duyệt hồ sơ trên SOTRANS Hub?
4. **Phân quyền Lương liên công ty:** Ban Lãnh đạo có đồng ý cho phép Quản trị viên (ADMIN) của đơn vị tiếp nhận xem mức lương cũ của nhân viên tại đơn vị chuyển đi hay không? (Xem chi tiết tại [ADMIN_CROSS_COMPANY_DATA_ACCESS_APPROVAL.md](file:///d:/hoso-chat/docs/business-decisions/ADMIN_CROSS_COMPANY_DATA_ACCESS_APPROVAL.md)).

---

## 6. KẾT LUẬN VÀ KIẾN NGHỊ

Đội ngũ kỹ thuật kiến nghị:
- **Tiếp tục duy trì cơ chế bảo vệ Fail-Closed:** Chặn toàn bộ các thao tác phê duyệt hồ sơ trùng CCCD của công ty khác cho đến khi văn bản Quy trình Điều chuyển Nhân sự Nội bộ Tập đoàn được Ban Lãnh đạo ký ban hành.
- **Không tự ý giả lập hoặc tự điền người phê duyệt:** Toàn bộ các trường thẩm quyền và nguồn văn bản trong Bảng Quyết định giữ trạng thái `PENDING` cho đến khi có văn bản chính thức của Tập đoàn SOTRANS.
