# BÁO CÁO THIẾT KẾ LẠI GIAO DIỆN TRANG ĐĂNG NHẬP SOTRANS HUB
## CORPORATE LOGISTICS DIGITAL PORTAL REDESIGN

**Mã công việc:** `UI-LANDING-REDESIGN-01`  
**Dự án:** SOTRANS Hub (`D:\hoso-chat`)  
**Mục tiêu:** Cổng đăng nhập & Giới thiệu công khai (`/chat/#login`)  
**Commit Hash:** `b24c8ddf5228219e44262f3b5b16a23d9acc84c8`  
**Ngày thực hiện:** 31/10/2026  
**Trạng thái kiểm thử:** 12/12 AUTH-GAI Test Cases PASS (100%), 5/5 Responsive Viewports PASS (100%), 0 Console/Page Errors.

---

## 1. TỔNG QUAN VÀ ĐỊNH HƯỚNG THIẾT KẾ

### 1.1. Bối cảnh
Trước đây, giao diện trang đăng nhập mang phong cách một landing page giới thiệu công cụ AI chung chung (generic AI marketing), sử dụng các khẩu hiệu chưa được xác thực (99.9% SLA, AES-256), hiển thị các nút tiện ích AI công khai (`Trợ lý AI đa năng`, `Bóc tách OCR 53 cột`, `Quy định & QĐ`, `Đồng bộ NocoDB & Sheets`), đồng thời bố cục dạng một khung đơn lẻ giữa khoảng trống rộng khiến giao diện bị rời rạc, thiếu bản sắc doanh nghiệp vận tải.

### 1.2. Định hướng tái thiết kế
Chuyển đổi toàn diện sang **Corporate Logistics Digital Portal — Nền tảng quản trị số và trí tuệ nhân tạo SOTRANS**:
- **Bản sắc Tập đoàn Logistics:** Tập trung nhận diện thương hiệu SOTRANS Group và 3 đơn vị thành viên cốt lõi: SOTRANS Logistics (`STL`), Vietranstimex (`VTX`), Sowatco (`SWC`).
- **Hình ảnh nghiệp vụ chuỗi cung ứng:** Minh họa trực quan hệ thống logistics đa phương thức (Cảng container, Cẩu giàn STS Gantry, Tàu chở container, Đoàn xe đầu kéo logistics, Bến cảng sông/biển và mạng lưới luân chuyển hàng hóa).
- **Màu sắc doanh nghiệp:**
  - Nền chủ đạo: Corporate Navy sang trọng (`#070d1e`, `#0b152d`, `#0e1b38`).
  - Màu hành động: SOTRANS Action Blue (`#0284c7`, `#2563eb`).
  - Màu điểm nhấn: SOTRANS Brand Orange (`#f97316`, `#ea580c`).
  - Màu nội dung: Trắng & Xám nhạt (`#ffffff`, `#f8fafc`, `#f1f5f9`) tạo độ tương phản cao, dễ đọc trên mọi kích thước màn hình.
  - Trạng thái thành công: Emerald Green (`#10b981`).
- **Bảo mật tuyệt đối:** Không cho phép khách vãng lai gọi hoặc xem General AI trước khi xác thực. Toàn bộ phiên làm việc, RBAC, và hệ thống backend được bảo toàn 100%.

---

## 2. CHI TIẾT CÁC THAY ĐỔI THEO TỪNG THÀNH PHẦN

### 2.1. Thanh điều hướng trên cùng (Corporate Logistics Navbar)
- **Logo & Thương hiệu:**
  - Giữ logo 3D isometric cube chính thức của SOTRANS Hub.
  - Nhãn thương hiệu: `SOTRANS HUB` đi kèm nhãn `Digital Workplace` và định danh phụ `Tập đoàn Logistics & Vận tải Đa phương thức`.
- **Giám sát trạng thái thời gian thực:**
  - Tích hợp kiểm tra sức khỏe trực tiếp từ API hệ thống `/api/health`.
  - Hiển thị badge: `🟢 Hệ thống trực tuyến` (`authNavStatusText` & `authNavStatusDot`).
- **Nút đăng nhập nổi bật:**
  - Nút `[ 🔐 Đăng nhập SOTRANS Hub ]` ở góc phải với độ tương phản cao, kích hoạt hộp thoại đăng nhập chuẩn (`#loginModal`).
- **Loại bỏ hoàn toàn các thành phần sai quy định:**
  - Xóa 4 nút tiện ích công khai cũ: `Trợ lý AI đa năng`, `Bóc tách OCR 53 cột`, `Quy định & QĐ`, `Đồng bộ NocoDB & Sheets`.

### 2.2. Khu vực Hero 2 Cột (Multimodal Logistics Hero)
- **Cột trái (Corporate Value Proposition):**
  - Eyebrow: `SOTRANS GROUP — DIGITAL TRANSFORMATION` với tông cam SOTRANS và hiệu ứng chấm sáng.
  - Tiêu đề chính: `Nền tảng quản trị số và trí tuệ nhân tạo SOTRANS` (36px, font-weight 800, rõ ràng).
  - Mô tả: Nêu bật nghiệp vụ số hóa chuỗi cung ứng logistics đa phương thức, chuẩn hóa cơ sở dữ liệu nhân sự và số hóa quy trình quản trị doanh nghiệp toàn Tập đoàn.
  - Nút CTA chính: `[ Đăng nhập SOTRANS Hub → ]` kích thước 15px đậm, hiệu ứng bóng mờ cao cấp.
  - Nút CTA phụ: `[ ℹ️ Hướng dẫn sử dụng ]` mở modal trợ giúp & hỗ trợ kỹ thuật (`#userGuideModal`).
- **Cột phải (Visual Nghệ thuật Vận tải Đa phương thức):**
  - Minh họa vector SVG chất lượng cao:
    - Bến cảng container với cẩu giàn STS Gantry nâng container màu cam SOTRANS.
    - Tàu container đa tầng neo đậu trên mặt nước.
    - Xe đầu kéo vận tải container gắn thương hiệu SOTRANS di chuyển trên cầu cảng.
    - Mạng lưới telemetry kết nối luồng hàng hóa logistics liên vùng.
  - 3 Thẻ định vị nghiệp vụ trực quan:
    - `🚢 SWC: Vận tải đường thủy nội địa, xà lan & cảng sông`
    - `🏗️ VTX: Vận tải đa phương thức, siêu trường & cẩu tải công trình`
    - `🚛 STL: Hệ thống kho bãi logistics, phân phối & cảng cạn ICD`

### 2.3. Hệ sinh thái Quản trị số (3 Thẻ lớn trên nền Trắng tương phản cao)
Thiết kế 3 thẻ lớn bề mặt thẻ trắng (`#ffffff`), viền tinh tế, chữ sắc nét, độ tương phản tuyệt đối trên nền Navy:
1. **Quản trị nhân sự & số hóa hồ sơ**
   - *Nhãn chức năng:* `Phân hệ Nhân sự & Số hóa`
   - *Mô tả:* Chuẩn hóa cơ sở dữ liệu nhân sự tập trung toàn tập đoàn. Tự động hóa bóc tách hồ sơ scan, định danh CCCD và quy trình staging kiểm duyệt đa tầng trước khi hợp nhất dữ liệu chính thức.
2. **Quản lý quy định & tri thức**
   - *Nhãn chức năng:* `Quy định & Văn bản Doanh nghiệp`
   - *Mô tả:* Hệ thống hóa kho văn bản định chế, quy chế làm việc và thỏa ước lao động tập thể của Tập đoàn. Tra cứu ngữ nghĩa chính xác theo từng điều khoản phục vụ cán bộ nhân viên và quản lý.
3. **Quản trị doanh nghiệp và đơn vị thành viên**
   - *Nhãn chức năng:* `Quản trị Đa đơn vị Tập đoàn`
   - *Mô tả:* Thiết lập chuẩn mực quản trị vận hành thống nhất giữa các đơn vị thành viên STL, VTX, SWC. Kiểm soát phân quyền đa cấp bậc (RBAC) đảm bảo toàn vẹn dữ liệu và an toàn thông tin.

### 2.4. Khối đơn vị thành viên Tập đoàn
Hiển thị 3 đơn vị thành viên với thông tin chính thức đã xác minh:
- **SOTRANS Logistics (`STL`):** Công ty TNHH MTV SOTRANS Logistics — Hệ thống kho bãi chuẩn quốc tế, khai thác cảng cạn ICD và dịch vụ logistics trọn gói.
- **Vietranstimex (`VTX`):** CTCP Vận tải Đa phương thức Vietranstimex — Đơn vị hàng đầu Đông Nam Á về vận tải siêu trường siêu trọng và cẩu lắp công trình.
- **Sowatco (`SWC`):** Tổng CTCP Đường sông Miền Nam — Khai thác cảng sông, đội sà lan thủy nội địa và dịch vụ logistics container kết nối liên vùng.

### 2.5. Chỉ số và Cam kết thực tế (Loại bỏ số liệu chưa chứng minh)
- **Đã gỡ bỏ:** Cam kết `99.9% Uptime SLA` và `Mã hóa AES-256` chưa được kiểm chứng.
- **Giữ lại các thông tin thực tế được xác minh:**
  - `3 Đơn vị Thành viên` (STL • VTX • SWC).
  - `Chuẩn hóa Dữ liệu` (Cơ sở dữ liệu nhân sự tập đoàn).
  - `Phân quyền Tập trung` (Kiểm soát truy cập RBAC đa tầng: ADMIN, HR, EMPLOYEE).

### 2.6. Modal Hướng dẫn sử dụng (`#userGuideModal`)
Khi người dùng bấm nút CTA phụ `Hướng dẫn sử dụng`, hộp thoại chuyên nghiệp hiển thị:
- Hướng dẫn nhập Mã nhân sự (STLxxxxx, VTXxxxxx, SWCxxxxx).
- Cơ chế tự động kích hoạt quyền RBAC (ADMIN, HR, EMPLOYEE) sau đăng nhập.
- Kênh liên hệ hỗ trợ kỹ thuật Trung tâm CNTT & Chuyển đổi số.
- Khuyến nghị an toàn thông tin: Không chia sẻ mật khẩu, đổi mật khẩu lần đầu đăng nhập.

---

## 3. DANH SÁCH FILE THAY ĐỔI

| STT | Tệp tin | Vị trí thay đổi | Mô tả chi tiết |
|:---:|:---|:---|:---|
| 1 | `chat/index.html` | Lines 3538–4040 | Cập nhật bộ CSS Corporate Logistics (Navbar, Hero 2 cột, 3 Thẻ hệ sinh thái, Khối thành viên, Facts strip, Media queries). |
| 2 | `chat/index.html` | Lines 4550–4950 | Thay thế toàn bộ khung HTML `#publicAuthView` theo kiến trúc Logistics Portal; bổ sung dialog `#userGuideModal`. |
| 3 | `chat/index.html` | Lines 6700–6740 | Bổ sung hàm `openUserGuideModal()`, `closeUserGuideModal()`, và hàm kiểm tra sức khỏe `checkPublicLandingHealth()`. |
| 4 | `scratch/apply_corporate_landing.js` | Toàn bộ tệp | Script tự động hóa chuẩn hóa và kiểm tra mã nguồn trang đăng nhập. |
| 5 | `scratch/test_corporate_landing.js` | Toàn bộ tệp | Bộ kiểm thử tự động E2E: 5 Viewports, 2 Modal Dialogs, Luồng đăng nhập Admin, Đăng xuất và DOM Audit. |

---

## 4. KẾT QUẢ KIỂM THỬ TỰ ĐỘNG

### 4.1. DOM Structure Audit
```json
{
  "hasHeader": true,
  "brandText": "SOTRANS HUB",
  "workplaceBadge": "Digital Workplace",
  "statusText": "Hệ thống trực tuyến",
  "hasHero": true,
  "heroH1": "Nền tảng quản trị số và trí tuệ nhân tạo SOTRANS",
  "hasVisual": true,
  "ecoCardsCount": 3,
  "memberCardsCount": 3,
  "factItemsCount": 3,
  "hasFooter": true,
  "removedPillsFound": 0
}
```

### 4.2. Responsive Viewport Verification (5/5 PASS)
1. **1920x1080 (Desktop FHD):** Bố cục 2 cột cân đối hoàn hảo, hình ảnh logistics sắc nét, 3 thẻ lớn dàn ngang đều đặn.
2. **1440x900 (Large Laptop):** Tỷ lệ hiển thị lý tưởng, khoảng cách lề đạt chuẩn 32px, text dễ đọc (>=14px).
3. **1366x768 (Standard Laptop):** Không xuất hiện thanh cuộn ngang, nút đăng nhập luôn dễ thấy.
4. **768x1024 (Tablet):** Hero tự động chuyển sang layout 1 cột tập trung, 3 thẻ sinh thái chia 2 cột cân đối.
5. **390x844 (Mobile iPhone/Android):** Navbar thu gọn thông minh, các nút CTA chuyển sang full-width, thẻ thành viên hiển thị 1 cột mượt mà.

### 4.3. Bảo mật và Phân quyền RBAC (12/12 AUTH-GAI PASS)
- **AUTH-GAI-01:** Khách chưa đăng nhập không thấy General AI chat (`publicAuthView = true`, `chatViewWrap = false`).
- **AUTH-GAI-02:** Truy cập trực tiếp `#chat/general` tự động chuyển hướng về `#login`.
- **AUTH-GAI-03:** Gọi Chat API không có token trả về HTTP 401 Unauthorized.
- **AUTH-GAI-04:** Gọi Chat API với token giả lập trả về HTTP 401 Unauthorized.
- **AUTH-GAI-05:** Kết nối SSE Stream không có token bị từ chối bắt tay HTTP 401.
- **AUTH-GAI-06:** Đăng nhập thành công mở khóa đầy đủ Trợ lý AI và thanh sidebar nghiệp vụ.
- **AUTH-GAI-07:** Gửi tin nhắn General AI sau đăng nhập phản hồi streaming thành công 100%.
- **AUTH-GAI-08:** Đăng xuất xóa token ngay lập tức và đưa người dùng về lại Corporate Landing.
- **AUTH-GAI-09:** Token hết hạn trả về HTTP 401 và yêu cầu đăng nhập lại.
- **AUTH-GAI-10:** Phân hệ My Agents cá nhân hoạt động bình thường sau khi đăng nhập.
- **AUTH-GAI-11:** Phân quyền quản trị viên ADMIN và nhân sự HR được bảo toàn nguyên vẹn.
- **AUTH-GAI-12:** Các endpoint công khai (`/api/health`, `/hr.css`, `/api/auth/login`) hoạt động thông suốt.

---

## 5. HÌNH ẢNH MINH CHỨNG NGHIỆM THU

### 5.1. Bố cục Đa màn hình (Responsive Viewports)
- **Desktop 1920px:** `screenshots/corp_landing_desktop_1920.png`
- **Laptop 1440px:** `screenshots/corp_landing_laptop_1440.png`
- **Laptop 1366px:** `screenshots/corp_landing_laptop_1366.png`
- **Tablet 768px:** `screenshots/corp_landing_tablet_768.png`
- **Mobile 390px:** `screenshots/corp_landing_mobile_390.png`

### 5.2. Tương tác Người dùng & Modal
- **Hộp thoại Hướng dẫn sử dụng:** `screenshots/corp_landing_user_guide_modal.png`
- **Hộp thoại Đăng nhập SOTRANS Hub:** `screenshots/corp_landing_login_modal.png`
- **Bàn làm việc sau khi Đăng nhập:** `screenshots/corp_landing_logged_in_dashboard.png`
- **Giao diện sau khi Đăng xuất:** `screenshots/corp_landing_logout_return.png`

---

## 6. KẾT LUẬN
Giao diện công khai tại `/chat/#login` đã được chuyển đổi thành công thành **Corporate Logistics Digital Portal**, khẳng định vị thế và hình ảnh chuyên nghiệp của Tập đoàn SOTRANS, tối ưu hóa trải nghiệm người dùng trên tất cả thiết bị và bảo toàn 100% tính an toàn của hệ thống xác thực.
