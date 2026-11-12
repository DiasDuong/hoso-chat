# BÁO CÁO HOÀN THIỆN: GIAO DIỆN TRANG CHỦ DOANH NGHIỆP SOTRANS & SỬA LỖI ĐĂNG XUẤT

**Mã Task:** `SOTRANS-CORPORATE-HOMEPAGE-CLEAN-02`  
**Dự án:** `D:\hoso-chat`  
**Môi trường:** Production SOTRANS Hub (Gateway port 8082 / Domain Tailscale `hr-n8n.taila8e1d8.ts.net`)  
**Ngày thực hiện:** 31/10/2026

---

## 1. TỔNG QUAN YÊU CẦU ĐÃ XỬ LÝ

1. **Loại bỏ hoàn toàn 6 thẻ chức năng nội bộ khỏi giao diện trang chủ:**
   - Người dùng yêu cầu: *"ở ngoài giao diện chỉ có các thông tin giới thiệu về công ty như trang Sotrans, không cần giới thiệu các chức năng hiện có trong hệ thống như này"*.
   - Khắc phục: Xóa bỏ hoàn toàn khu vực `#section-apps` ("Bàn Làm Việc & Ứng Dụng SOTRANS Hub" bao gồm 6 thẻ: Trợ lý General AI 3.1, Quản lý Hồ sơ, Quy định & Thỏa ước, My Agents, Quản trị Người dùng, Quản lý Đơn vị).
   - Trang chủ hiện tại 100% là trang giới thiệu doanh nghiệp và nhận diện thương hiệu tập đoàn logistics chuẩn theo [sotrans.com.vn](https://sotrans.com.vn/).

2. **Khắc phục triệt để lỗi không đăng xuất được tài khoản:**
   - Người dùng yêu cầu: *"không đăng xuất được tài khoản, các nút chức năng đều lỗi"*.
   - Nguyên nhân gốc: Trùng lặp phần tử DOM giữa `publicAuthView` và `homeViewWrap` khiến hàm `logoutUser()` và sự kiện click `#homeBtnLogout` bị bắt sai container. Nút đăng xuất cũ là icon nhỏ 34px không có nhãn văn bản.
   - Khắc phục:
     * Loại bỏ toàn bộ container trùng lặp, chỉ sử dụng duy nhất một container trang chủ chuẩn `#homeViewWrap`.
     * Thiết kế lại nút **Đăng xuất** với phong cách nổi bật: có biểu tượng mở cửa + chữ "Đăng xuất" rõ ràng (`.home-btn-logout-styled`), màu nhấn đỏ nhạt sang trọng.
     * Hàm `logoutUser()` xóa toàn bộ token khỏi `localStorage` và `sessionStorage` (`HR_ADMIN_TOKEN`, `HR_CHAT_TOKEN`, `HR_AUTH_TOKEN`, `HR_USER_DATA`,...), reset user về khách và cập nhật navbar ngay lập tức, kèm thông báo Toast.

3. **Luồng vào Không gian làm việc (Workspace):**
   - Khi đã đăng nhập, ở thanh điều hướng trên cùng có nút nổi bật: **"Vào Trợ lý AI"** (`#homeBtnWorkspace`) và ở Hero Banner có nút CTA: **"Vào Không Gian Làm Việc (Trợ lý AI)"**.
   - Khi click, hệ thống chuyển mượt mà vào màn hình làm việc `#chat/general` với đầy đủ Sidebar bên trái, danh sách bot và công cụ nghiệp vụ theo đúng quyền hạn tài khoản (Admin, HR, Nhân viên).
   - Khi muốn quay lại Trang chủ giới thiệu SOTRANS, chỉ cần click vào Logo **SOTRANS HUB** ở góc trên bên trái sidebar (`#brandLink`).

---

## 2. KẾT QUẢ KIỂM THỬ TỰ ĐỘNG (E2E & SECURITY)

### Bộ kiểm thử 1: `scratch/test_corporate_clean_flow.js` (Playwright E2E)
- **TEST 1 (Khách truy cập):** Không có 6 thẻ nghiệp vụ, hiển thị nút "Đăng nhập SOTRANS Hub", không lộ chức năng đăng xuất -> **PASS**
- **TEST 2 (Đăng nhập nhân viên `emp_stl`):** Hiển thị huy hiệu `🏢 STL`, tên `emp_stl (Nhân viên)`, nút "Vào Trợ lý AI" và nút "Đăng xuất" đỏ nổi bật -> **PASS**
- **TEST 3 (Chuyển vào Workspace):** Click "Vào Trợ lý AI" -> Mở workspace `#chat/general`, sidebar mở đầy đủ -> **PASS**
- **TEST 4 (Quay về Trang chủ):** Click logo `brandLink` -> Trở về `#home` mượt mà -> **PASS**
- **TEST 5 (Đăng xuất):** Click nút "Đăng xuất" -> Xóa sạch token, ẩn nút đăng xuất, hiển thị lại trạng thái khách -> **PASS**
- **Lỗi giao diện / Console log:** `0 errors (PERFECT!)`

### Bộ kiểm thử 2: `scratch/run_auth_gai_suite.js` (12 Kiểm thử Bảo mật API & RBAC)
- AUTH-GAI-01: Public page unauthenticated hides General AI -> **PASS**
- AUTH-GAI-02: Direct URL `#chat/general` redirects to `#login` -> **PASS**
- AUTH-GAI-03: API chat without token returns 401 -> **PASS**
- AUTH-GAI-04: API chat with invalid token returns 401 -> **PASS**
- AUTH-GAI-05: SSE stream without token returns 401 -> **PASS**
- AUTH-GAI-06: Valid login unlocks General AI -> **PASS**
- AUTH-GAI-07: Chatting post-login succeeds -> **PASS**
- AUTH-GAI-08: Logout immediately revokes access & blocks API -> **PASS**
- AUTH-GAI-09: Expired token returns 401 -> **PASS**
- AUTH-GAI-10: Personal AI Agents operational -> **PASS**
- AUTH-GAI-11: Admin/HR RBAC permissions preserved -> **PASS**
- AUTH-GAI-12: Public routes healthy -> **PASS**
- **Kết quả:** `12/12 tests passed (100%)`.
