# SOTRANS HUB — BÁO CÁO TÍCH HỢP XÓA VĨNH VIỄN (4-EYES) VÀO MODULE QUẢN LÝ HỒ SƠ NHÂN SỰ
**Mã công việc:** `HR-HARD-DELETE-TAB-INTEGRATION-01`  
**Hệ thống:** SOTRANS Enterprise AI Platform (Production Hub)  
**Database:** Production PostgreSQL `hrbot` (Port 5432)  
**Môi trường:** Production (`http://127.0.0.1:8082`)  
**Ngày hoàn thành:** 30/10/2026  
**Trạng thái nghiệm thu:** ĐÃ HOÀN THÀNH TOÀN DIỆN (15/15 E2E Tests Passed)

---

## 1. TỔNG QUAN & MỤC TIÊU CÔNG VIỆC

Theo yêu cầu chuẩn hóa giao diện và tinh giản kiến trúc quản trị SOTRANS Hub:
1. **Xóa hoàn toàn module độc lập:** Gỡ bỏ mục `Yêu cầu Xóa vĩnh viễn (4-Eyes)` khỏi sidebar bên trái (`#sbAdminHubList`). Sidebar Trung tâm Quản trị chỉ duy trì 4 module nghiệp vụ chính:
   - 📄 Quản lý Quy định & Tài liệu (`#navAdminDocs`)
   - 👥 Người dùng & Phân quyền (`#navAdminUsers`)
   - 🪪 Quản lý Hồ sơ Nhân sự (`#navAdminEmployees`)
   - 🏢 Quản lý Công ty Thành viên (`#navAdminCompanies`)
2. **Hợp nhất vào Quản lý Hồ sơ Nhân sự:** Đưa chức năng **Xóa vĩnh viễn (4-Eyes)** vào bên trong module **Quản lý Hồ sơ Nhân sự & Số hóa OCR** (`/chat/#admin/employees`), trở thành **Tab thứ ba** song song và đồng cấp với:
   - **Tab 1:** 🪪 Hồ sơ nhân sự chính thức (`#btnSubTabOfficial` -> `#empOfficialSection`)
   - **Tab 2:** 📥 Tiếp nhận & Duyệt hồ sơ (Staging) (`#btnSubTabStaging` -> `#empStagingSection`)
   - **Tab 3:** 🛡️ Xóa vĩnh viễn (4-Eyes) (`#btnSubTabHardDelete` -> `#tabViewHard_delete`)
3. **Chuẩn hóa Giao diện Enterprise SaaS (Polished Top Bar):**
   - Thiết kế khối Subtabs Bar `.emp-subtabs-card` với thẻ nền trắng, viền mảnh `#e2e8f0`, đổ bóng tinh tế.
   - Các nút subtabs nằm trong cụm Segmented Control `#f1f5f9` đồng bộ 100% với ngôn ngữ thiết kế chung của SOTRANS Hub.
   - Tab Active nổi bật với gradient xanh SOTRANS Blue (`#0284c7` -> `#0369a1`), chữ trắng đậm, hiệu ứng bóng mờ cao cấp.
   - Tab Inactive có màu xám xanh dịu mắt `#64748b`, hover chuyển nền sáng êm ái.
   - Thêm pill trạng thái `Phân hệ Quản lý Hồ sơ • SOTRANS Hub` với chấm xanh trực quan ở góc phải.
   - Mở rộng độ rộng tối đa của tiêu đề header trên thanh công cụ chính để không bị cắt xén (`...`) trên màn hình laptop.
4. **Đồng bộ Route & Tương thích ngược:**
   - Route chính: `/chat/#admin/employees` (mặc định kích hoạt Tab 1).
   - Deep-linking URL: `#admin/employees?tab=official`, `#admin/employees?tab=staging`, `#admin/employees?tab=hard_delete`.
   - Tương thích ngược (Backward Compatibility): Khi truy cập bookmark/link cũ `/chat/#admin/hard_delete`, hệ thống tự động chuyển hướng và kích hoạt Tab 3 trong module Nhân sự mà không phát sinh lỗi 404 hay màn hình trắng.
   - Hỗ trợ đầy đủ F5 Refresh retention và điều hướng Browser History (Back / Forward).
5. **Bảo toàn 100% nghiệp vụ và kiểm soát an toàn:**
   - Giữ nguyên toàn bộ logic 4-Eyes Approval, Safety Gates, audit trail.
   - RBAC bảo mật nghiêm ngặt: Quyền xem và thao tác Tab 3 chỉ dành cho `ADMIN` / `SUPER_ADMIN`. Tài khoản `HR` (e.g. `hr_stl`) hoàn toàn bị ẩn Tab 3; nếu truy cập deep link sẽ tự động fallback về Tab 1.
   - Giữ nguyên các cờ vận hành Production:
     `PRODUCTION_REQUEST_MODE = ENABLED`  
     `PRODUCTION_EXECUTION_MODE = BLOCKED_AWAITING_LEGAL_RETENTION_POLICY`
   - Không thực hiện thao tác xóa dữ liệu thật và không tạo dữ liệu rác trên Production trong quá trình tích hợp.

---

## 2. KIẾN TRÚC & CÁC THAY ĐỔI MÃ NGUỒN

### 2.1. Cấu trúc Subtabs Bar Chuẩn hóa (`chat/hr-admin.html`)

```html
<div class="emp-subtabs-card">
  <div class="emp-subtabs-nav" role="tablist" aria-label="Phân hệ Quản lý Hồ sơ Nhân sự">
    <button id="btnSubTabOfficial" type="button" class="emp-subtab-btn active" onclick="switchEmpSubTab('official')" role="tab" aria-selected="true" title="Hồ sơ nhân sự chính thức">
      <span class="subtab-icon">🪪</span>
      <span>Hồ sơ nhân sự chính thức</span>
    </button>
    <button id="btnSubTabStaging" type="button" class="emp-subtab-btn" onclick="switchEmpSubTab('staging')" role="tab" aria-selected="false" title="Tiếp nhận & Duyệt hồ sơ (Staging)">
      <span class="subtab-icon">📥</span>
      <span>Tiếp nhận & Duyệt hồ sơ (Staging)</span>
      <span id="stagingBadgeCount" class="emp-subtab-badge" style="display:none">0</span>
    </button>
    <button id="btnSubTabHardDelete" type="button" class="emp-subtab-btn" onclick="switchEmpSubTab('hard_delete')" role="tab" aria-selected="false" title="Quản lý yêu cầu xóa vĩnh viễn theo quy trình 4-Eyes" style="display:none">
      <span class="subtab-icon">🛡️</span>
      <span>Xóa vĩnh viễn (4-Eyes)</span>
      <span id="hardDeleteBadgeCount" class="emp-subtab-badge" style="display:none">0</span>
    </button>
  </div>
  <div class="emp-subtabs-badge-info">
    <span class="hub-pill">
      <span class="hub-pill-dot"></span>
      <span>Phân hệ Quản lý Hồ sơ • SOTRANS Hub</span>
    </span>
  </div>
</div>
```

---

## 3. THIẾT KẾ GIAO DIỆN & TƯƠNG THÍCH ĐA THIẾT BỊ

### 3.1. Hệ màu & Phong cách Nút Tab
- **Khung chứa (`.emp-subtabs-card`):** Nền trắng `#ffffff`, bo tròn 14px, viền mảnh `#e2e8f0`, đổ bóng `0 1px 3px rgba(15, 23, 42, 0.04)`.
- **Thanh Segmented Control (`.emp-subtabs-nav`):** Nền xám nhạt `#f1f5f9`, đệm 5px, bo góc 11px, viền trong tinh tế.
- **Tab kích hoạt (Active):** Nền gradient xanh thương hiệu SOTRANS Blue (`#0284c7` -> `#0369a1`), chữ trắng `#ffffff`, đổ bóng cao cấp `0 2px 8px rgba(2, 132, 199, 0.3)`.
- **Tab không kích hoạt (Inactive):** Màu chữ slate `#64748b`, nền trong suốt, hiệu ứng hover chuyển sang nền trắng đục `rgba(255, 255, 255, 0.85)` và chữ đậm `#0f172a`.
- **Kích thước & Khoảng cách:** Chiều cao 38px, font-size 13.5px, font-weight 600, border-radius 8px, padding 0 18px.

### 3.2. Responsive Across Viewports
- **Desktop (1920x1080):** 3 tab trải dài thoáng đãng, các thẻ KPI và bảng kê dữ liệu mở rộng tối đa.
- **Laptop (1366x768):** Bố cục cân đối hoàn hảo, tiêu đề header không bị cắt ngắn `...`.
- **Tablet (768x1024):** Subtabs co giãn linh hoạt, bảng điều khiển tự động bọc dòng (wrap).
- **Mobile (390x844):** Container `.emp-subtabs-nav` hỗ trợ vuốt cuộn ngang mượt mà (`overflow-x: auto`), không làm vỡ bố cục màn hình dọc.

---

## 4. KẾT QUẢ KIỂM THỬ E2E BROWSER AUTOMATION

| STT | Kịch bản kiểm thử | Kỳ vọng | Kết quả | Trạng thái |
| :---: | :--- | :--- | :--- | :---: |
| **1** | Kiểm tra Sidebar Quản trị | Mục độc lập Xóa vĩnh viễn đã bị xóa; chỉ còn đúng 4 mục nghiệp vụ | 4 items: Docs, Users, Employees, Companies. No standalone item | **PASS ✅** |
| **2** | Nhận diện 3 Subtab tại module Nhân sự | Hiển thị đủ 3 tab với styling SOTRANS Blue; Tab 1 mặc định active | Tab 1, 2, 3 hiển thị đầy đủ; Tab 1 active | **PASS ✅** |
| **3** | Chuyển đổi sang Tab 2 (Staging) | Section Staging hiển thị; URL hash chuyển thành `?tab=staging` | Staging visible; URL hash cập nhật chính xác | **PASS ✅** |
| **4** | Chuyển đổi sang Tab 3 (Hard Delete) | Section Hard Delete hiển thị; URL hash `?tab=hard_delete`; 4 thẻ KPI render | Hard Delete visible; 4 KPI cards & table render đầy đủ | **PASS ✅** |
| **5** | Tương thích ngược route cũ | Mở `/chat/#admin/hard_delete` tự động chuyển về Tab 3 module Nhân sự | Chuyển hướng mượt mà, sidebar active ở Employees | **PASS ✅** |
| **6** | Lưu trạng thái khi F5 Refresh | Refresh trang tại Tab 3 vẫn giữ nguyên Tab 3 không bị nhảy về Tab 1 | F5 reload retains Tab 3 active state | **PASS ✅** |
| **7** | Lịch sử trình duyệt Back / Forward | Bấm nút Back/Forward chuyển đổi chính xác giữa các subtab | Back 1 -> Tab 2; Back 2 -> Tab 1; Forward -> Tab 2 | **PASS ✅** |
| **8** | Kiểm tra RBAC tài khoản HR | Đăng nhập tài khoản `hr_stl` (Role: HR); Tab 3 bị ẩn hoàn toàn | Tab 3 display = none; section display = none | **PASS ✅** |
| **9** | Fallback an toàn cho HR Deep-link | Tài khoản HR cố tình truy cập `?tab=hard_delete` tự động về Tab 1 | Fallback active: Tab 1; Hard Delete view ẩn | **PASS ✅** |
| **10** | Responsive Viewport: Desktop (1920) | Giao diện mở rộng hoàn hảo, không có console errors | Nav present, Table present, 0 errors | **PASS ✅** |
| **11** | Responsive Viewport: Laptop (1366) | Bố cục vừa vặn với kích thước màn hình phổ thông | Nav present, Table present, 0 errors | **PASS ✅** |
| **12** | Responsive Viewport: Tablet (768) | Giao diện co giãn chuẩn, tương tác tốt | Nav present, Table present, 0 errors | **PASS ✅** |
| **13** | Responsive Viewport: Mobile (390) | Subtab cuộn ngang mượt mà, không tràn vỡ màn hình | Nav present, Table present, 0 overflow | **PASS ✅** |
| **14** | Kiểm tra Console Errors | Toàn bộ quy trình chuyển tab không phát sinh JavaScript runtime error | Console errors caught: 0 | **PASS ✅** |
| **15** | Bảo toàn tính toàn vẹn CSDL | Không có bất kỳ bản ghi nhân viên nào bị xóa hoặc biến đổi ngoài ý muốn | 5 nhân viên cơ sở nguyên vẹn (STL00014, SWC00022..25) | **PASS ✅** |

---

## 5. HÌNH ẢNH MINH CHỨNG NGHIỆM THU (SCREENSHOTS)

Các ảnh chụp màn hình độ phân giải cao được ghi nhận tự động tại thư mục `screenshots/hard_delete_tab_integration/`:
1. `01_hr_subtab1_official.png`: Giao diện Tab 1 (Hồ sơ nhân sự chính thức) với Subtabs Navigation chuẩn hóa.
2. `02_hr_subtab2_staging.png`: Giao diện Tab 2 (Tiếp nhận & Duyệt hồ sơ Staging).
3. `03_hr_subtab3_hard_delete.png`: Giao diện Tab 3 (🛡️ Xóa vĩnh viễn 4-Eyes) tích hợp gọn gàng trong cùng module.
4. `04_legacy_redirect_hard_delete.png`: Bằng chứng truy cập route cũ `/chat/#admin/hard_delete` tự động ánh xạ vào Tab 3.
5. `05_hr_role_rbac_restriction.png`: Bằng chứng tài khoản HR (`hr_stl`) bị ẩn hoàn toàn Tab 3 và fallback an toàn về Tab 1.
6. `06_responsive_1920_desktop.png` / `1366_laptop.png` / `768_tablet.png` / `390_mobile.png`: Kiểm chứng hiển thị trên 4 dải độ phân giải.
