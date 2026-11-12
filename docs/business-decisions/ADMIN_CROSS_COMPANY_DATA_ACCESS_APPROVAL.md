# SOTRANS HUB — HỒ SƠ PHÊ DUYỆT PHẠM VI TRUY CẬP DỮ LIỆU NHÂN SỰ & PII LIÊN CÔNG TY CỦA VAI TRÒ ADMIN
## CROSS-COMPANY ADMIN PII & SALARY ACCESS SCOPE REVIEW
**Mã tài liệu:** `SOTRANS-ADMIN-PII-ACCESS-08`  
**Dự án:** `D:\hoso-chat`  
**Phân hệ:** Quản lý Hồ sơ Nhân sự, HR Staging, RBAC & API Data Sanitization  
**Trạng thái thẩm định:** **`BUSINESS/SECURITY SIGN-OFF REQUIRED` (CHƯA ĐƯỢC PHÊ DUYỆT BỞI BAN LÃNH ĐẠO)**  
**Căn cứ pháp lý & tuân thủ:** Nghị định 13/2023/NĐ-CP về Bảo vệ dữ liệu cá nhân; Quy chế bảo mật thông tin nội bộ Tập đoàn SOTRANS.

---

## 1. NGUYÊN TẮC PHÂN QUYỀN HIỆN HÀNH & VẤN ĐỀ ĐẶT RA

### 1.1. Nguyên tắc bình đẳng quyền quản trị của vai trò ADMIN
Theo chính sách RBAC hợp nhất (Unified Admin Policy) hiện tại của SOTRANS Hub:
- Mọi tài khoản có vai trò `ADMIN` hoặc `SUPER_ADMIN` (bao gồm `admin_stl`, `admin_swc`, `admin_vtx`, `superadmin`) đều dùng chung một bộ quyền chức năng:
  - Có quyền quản trị hồ sơ nhân sự, xem danh sách tiếp nhận staging toàn Tập đoàn.
  - Có thẩm quyền phê duyệt hồ sơ hợp lệ và phối hợp điều chuyển nhân sự giữa các đơn vị.

### 1.2. Vấn đề rủi ro bảo mật: Không đồng nhất giữa quyền quản trị và quyền xem thông tin nhạy cảm
Bình đẳng về quyền quản trị **không đồng nghĩa với việc mọi tài khoản ADMIN đều được phép xem toàn bộ các trường dữ liệu cá nhân nhạy cảm (PII), đặc biệt là mức thu nhập và lương (`salary_info`) của các đơn vị thành viên khác**.

Hiện tại trong mã nguồn backend:
1. **Tại endpoint `GET /api/hoso/intake/staging/:id` ([intake.js](file:///d:/hoso-chat/auth-service/routes/intake.js#L2028-L2045)):**
   - Vai trò `HR` bị làm mờ (sanitized) hoàn toàn thông tin đối soát liên công ty.
   - Nhưng vai trò `ADMIN` (bất kể thuộc công ty nào) được nhận nguyên vẹn đối tượng `matched_record`, bao gồm: `full_name`, `employee_code`, `company_id`, `status` và trường `salary` (nếu có trong dữ liệu trích xuất hoặc đối soát).
2. **Tại endpoint `GET /api/employees/:id` ([employees.js](file:///d:/hoso-chat/auth-service/routes/employees.js#L507-L520)):**
   - Chỉ tài khoản vai trò `EMPLOYEE` mới bị ẩn thông tin lương (`social_insurance_salary`, `total_income`, `base_salary`, các loại phụ cấp).
   - Tài khoản `ADMIN` của Công ty A (ví dụ: STL) khi truy cập chi tiết nhân viên của Công ty B (ví dụ: SWC) vẫn nhận đầy đủ 10 trường lương và phụ cấp, cùng toàn bộ số CCCD không che.

---

## 2. BẢNG CHI TIẾT CÁC TRƯỜNG DỮ LIỆU NHẠY CẢM VÀ ĐÁNH GIÁ RỦI RO

| Nhóm dữ liệu | Trường dữ liệu cụ thể | Đối tượng trả về hiện tại | Mức độ nhạy cảm | Rủi ro bảo mật & kinh doanh |
|---|---|---|:---:|---|
| **Lương & Thu nhập** | `base_salary`, `social_insurance_salary`, `total_income`, `productivity_responsibility_pay`, `attendance_bonus`, các loại phụ cấp tàu/trách nhiệm | Trả về cho mọi `ADMIN` kể cả khác đơn vị | **TỐI MẬT (P0)** | Lộ bí mật quỹ lương, cơ chế đãi ngộ đặc thù giữa các đơn vị thành viên độc lập (STL vs SWC vs VTX). Nguy cơ khiếu nại nội bộ. |
| **Định danh cá nhân (PII)** | `citizen_id` (nguyên bản 12 số), `citizen_id_issue_date`, `citizen_id_issue_place`, `date_of_birth` | Trả về unmasked cho mọi `ADMIN` | **CAO (P1)** | Rủi ro tuân thủ Nghị định 13/2023/NĐ-CP nếu không có thỏa thuận xử lý dữ liệu giữa các pháp nhân thành viên. |
| **Thông tin cư trú & nguồn gốc** | `permanent_address`, `temporary_address`, `birth_registration_place`, `place_of_origin` | Trả về cho mọi `ADMIN` | **TRUNG BÌNH (P2)** | Dữ liệu đời tư nhân sự không cần thiết cho mục đích điều chuyển ban đầu. |
| **Thông tin liên lạc** | `phone_number`, `email` | Trả về cho mọi `ADMIN` | **THẤP (P3)** | Cần thiết để liên hệ xác minh nghiệp vụ. |

---

## 3. CÁC PHƯƠNG ÁN PHÂN QUYỀN TRÌNH BAN LÃNH ĐẠO XEM XÉT

### Phương án 1 (Strict Tenant Data Isolation for Salary — Khuyến nghị):
- **Nguyên tắc:** ADMIN chỉ được xem thông tin Lương & Thu nhập của nhân sự thuộc **chính đơn vị mình**.
- **Khi xem hồ sơ đơn vị khác:**
  - Nhóm `salary_info` bị làm mờ hoàn toàn: hiển thị nhãn `"Thông tin thu nhập thuộc thẩm quyền bảo mật của đơn vị [Tên Công ty]".`
  - CCCD được che bớt: `079***010`.
  - Giữ lại: `employee_code`, `full_name`, `company_id`, `department`, `position` để đủ thông tin phục vụ điều chuyển.
- **Ngoại lệ:** Chỉ tài khoản `SUPER_ADMIN` cấp Tập đoàn (Tổng Giám đốc / Trưởng ban Nhân sự Tập đoàn) mới xem được toàn bộ lương liên công ty.

### Phương án 2 (Consolidated Corporate Admin — Giữ nguyên trạng):
- **Nguyên tắc:** Coi tất cả ADMIN là thành viên Ban Nhân sự Tập đoàn, có toàn quyền xem mọi dữ liệu bao gồm lương của tất cả các công ty thành viên.
- **Yêu cầu bắt buộc:** Tất cả người dùng giữ tài khoản `ADMIN` phải ký Bản cam kết bảo mật thông tin nhân sự và thu nhập Tập đoàn (Non-Disclosure Agreement - NDA).

---

## 4. MA TRẬN PHÊ DUYỆT CỦA CÁC CHỦ SỞ HỮU NGHIỆP VỤ (SIGN-OFF MATRIX)

| Hạng mục quyết định | Trạng thái hiện tại | Thẩm quyền phê duyệt | Nguồn văn bản / Quyết định | Trạng thái ký duyệt |
|---|:---:|---|---|:---:|
| **Quyền xem thông tin Lương liên công ty của ADMIN** | `PENDING` | Tổng Giám đốc Tập đoàn / Trưởng ban Nhân sự Tập đoàn | Chưa ban hành | **BUSINESS/SECURITY SIGN-OFF REQUIRED** |
| **Quyền xem số CCCD đầy đủ liên công ty của ADMIN** | `PENDING` | Cán bộ Phụ trách An toàn Thông tin (DPO / CISO) | Chưa ban hành | **BUSINESS/SECURITY SIGN-OFF REQUIRED** |
| **Cơ chế ẩn danh hóa PII đối với vai trò HR** | `APPROVED IN CODE` | Đội ngũ Kỹ thuật & Nghiệp vụ HR | `FINAL-08` / TEST-4 / TEST-B5 | **VERIFIED IMPLEMENTED** |
| **Quy định bảo vệ dữ liệu cá nhân theo NĐ 13/2023/NĐ-CP** | `PENDING` | Ban Pháp chế Tập đoàn | Chưa ban hành | **PENDING LEGAL REVIEW** |

---

## 5. KẾT LUẬN & KHUYẾN NGHỊ VẬN HÀNH

Cho đến khi có văn bản phê duyệt chính thức từ Ban Lãnh đạo Tập đoàn:
1. **KHÔNG** tuyên bố hệ thống đã hoàn tất phê duyệt an toàn thông tin về quyền truy cập dữ liệu PII/Lương liên công ty.
2. Hệ thống phải ghi nhận trạng thái **`BUSINESS/SECURITY SIGN-OFF REQUIRED`**.
3. Để đảm bảo an toàn tối đa trước khi Go-Live, khuyến nghị Ban Lãnh đạo áp dụng **Phương án 1 (Ẩn lương liên công ty đối với ADMIN đơn vị)**.
