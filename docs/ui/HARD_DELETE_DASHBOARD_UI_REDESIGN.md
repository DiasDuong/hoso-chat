# SOTRANS HUB — BÁO CÁO THIẾT KẾ LẠI GIAO DIỆN QUẢN LÝ XÓA VĨNH VIỄN (PRODUCTION)
## Mã công việc: HR-PROD-HARD-DELETE-03 / DASHBOARD-REDESIGN

**Project:** `D:\hoso-chat`  
**Target Module:** Production Employee Hard Delete Dashboard  
**Route:** `/chat/#admin/hard_delete`  
**Frontend Files:** [chat/hr-admin.html](file:///D:/hoso-chat/chat/hr-admin.html), [chat/index.html](file:///D:/hoso-chat/chat/index.html)  
**Base Commit:** `b24c8ddf5228219e44262f3b5b16a23d9acc84c8`  
**Database:** `hrbot` (Production — 5 baseline employees preserved, zero mutations)  
**Verification Date:** 30/10/2026  

---

## 1. TỔNG QUAN VÀ MỤC TIÊU

Giao diện quản lý quy trình **Xóa vĩnh viễn Hồ sơ Nhân sự (Production 4-Eyes)** ban đầu được xây dựng với các khối thống kê dọc chiếm quá nhiều diện tích màn hình, thiếu thanh công cụ lọc trực quan, bảng hiển thị chưa tối ưu hóa phân trang và hộp thoại chi tiết chưa phân cấp thông tin rõ ràng theo chuẩn Enterprise SaaS.

Đợt nâng cấp giao diện này chuyển đổi toàn diện module thành một **Enterprise SaaS Dashboard** chuẩn mực:
- **Thiết kế Header hiện đại:** Bổ sung breadcrumb điều hướng, nhãn cảnh báo `PRODUCTION` kèm hiệu ứng pulse đỏ, nhãn `4-EYES APPROVAL`, thời gian cập nhật dữ liệu (`HH:mm:ss`) và nút làm mới danh sách.
- **KPI Dashboard nằm ngang:** Thay thế 4 khung dọc cũ bằng 4 KPI Cards nằm ngang trên màn hình desktop (Blue, Amber, Green, Slate) với icon Lucide/SVG tinh gọn, số liệu nổi bật và nhãn trạng thái trực quan.
- **Thanh công cụ hợp nhất (Unified Toolbar):** Tối ưu bố cục trên 1 dòng desktop, tích hợp ô tìm kiếm (mã yêu cầu, mã NV, họ tên, người tạo), bộ lọc trạng thái, bộ lọc công ty (STL/SWC/VTX), bộ lọc khoảng thời gian tạo, cùng nút **Lọc** và **Đặt lại**.
- **Bộ lọc nhanh dạng Segmented Pills:** Đồng bộ 2 chiều hoàn hảo với dropdown trạng thái (Tất cả, Chờ duyệt, Đã duyệt, Đang xử lý, Đã hoàn tất, Từ chối / Đã hủy).
- **Bảng dữ liệu Enterprise Table:** Header nền nhẹ (#f8fafc), hover state mượt mà, định dạng ngày tháng tiếng Việt, badge mã yêu cầu monospaced (#REQ-...), thẻ đơn vị (STL/SWC/VTX), trạng thái có chấm tròn màu (dot indicator), phân trang chuẩn SaaS (5, 10, 20, 50 dòng/trang), loading skeleton mượt mà và empty state thân thiện.
- **Hộp thoại Chi tiết Thẩm định (`prodHardDeleteDetailDlg`):** Phân chia khoa học thành 6 nhóm thông tin (A: Snapshot & Lý do; B: Scope Manifest & SHA-256; C: 4-Eyes Maker/Checker; D: 12 Safety Gates Checklist với cảnh báo nổi bật Gate 7 `RETENTION_POLICY_NOT_APPROVED`; E: Backup & Execution; F: Audit Timeline). Che giấu CCCD bảo mật PII.
- **Tích hợp Điều hướng & Định tuyến SPA:** Hỗ trợ trực tiếp URL hash `/chat/#admin/hard_delete`, bổ sung menu mục lục Quản trị trên Sidebar (`navAdminHardDelete`), tự động kích hoạt active state và cập nhật tiêu đề header hệ thống.

---

## 2. DANH SÁCH FILE THAY ĐỔI

| File | Loại thay đổi | Chi tiết cải tiến |
|---|---|---|
| [chat/hr-admin.html](file:///D:/hoso-chat/chat/hr-admin.html) | Frontend Dashboard & Modal | - Bổ sung `'hard_delete'` vào whitelist điều hướng và routing iframe.<br>- Bổ sung bộ CSS Enterprise SaaS dành riêng cho Hard Delete Dashboard.<br>- Tái cấu trúc toàn bộ thẻ `<div id="tabViewHard_delete">` gồm Header, 4 KPI cards, Quick pills, Toolbar và Table.<br>- Nâng cấp logic JavaScript: `loadHardDeleteRequests()`, `renderHardDeleteTable()`, `setHdQuickFilter()`, `resetHdFilters()`, `openProdHardDeleteDetail()`.<br>- Tích hợp component phân trang chuẩn `renderPaginationBar('prodHdPagination', ...)`. |
| [chat/index.html](file:///D:/hoso-chat/chat/index.html) | Shell Navigation & Hash Routing | - Bổ sung style icon `.admin-ico.hard_delete`.<br>- Thêm mục điều hướng `navAdminHardDelete` trong Sidebar `#sbAdminHubList`.<br>- Cập nhật `applyRolePermissions()` hiển thị menu xóa cho ADMIN.<br>- Cập nhật `switchWorkspaceMode()` và `adminTabChanged` lắng nghe route `#admin/hard_delete`, cập nhật Header Bot title và icon 🛡️. |

---

## 3. CÁC THÀNH PHẦN GIAO DIỆN ĐƯỢC CẢI TIẾN

### 3.1. Header Điều hướng & Trạng thái Hệ thống
- **Breadcrumb:** `Hệ thống / Quy trình 4-Eyes / Quản lý yêu cầu xóa vĩnh viễn` giúp người dùng định vị chính xác vị trí trong hệ thống.
- **Nhãn phân loại:**
  - `PRODUCTION`: Nền đỏ nhạt (#fef2f2), viền (#fecaca), chữ đỏ đậm (#991b1b) kèm đèn LED tín hiệu nhấp nháy (pulsing red dot).
  - `4-EYES APPROVAL`: Nền vàng hổ phách (#fef3c7), viền (#fde68a), chữ hổ phách (#92400e) kèm icon khiên bảo vệ.
- **Metadata thời gian:** Hiển thị `Cập nhật: HH:mm:ss` tự động làm mới mỗi khi tải lại dữ liệu.
- **Nút hành động:** Nút "Làm mới danh sách" với icon quay mượt mà, phản hồi ngay lập tức.

### 3.2. Dashboard 4 Chỉ số KPI (Nằm ngang Desktop)
Thay vì các ô thống kê xếp chồng chiếm chiều cao vô ích, giao diện mới dàn trải 4 card ngang đều nhau:
1. **Tổng số yêu cầu (Blue):** Viền trái #0284c7, icon clipboard #e0f2fe, giá trị lớn màu xanh dương, mô tả "Tất cả yêu cầu được lập".
2. **Chờ phê duyệt (Amber):** Viền trái #d97706, icon đồng hồ #fef3c7, giá trị lớn màu hổ phách, mô tả "Cần thẩm định 4-Eyes độc lập".
3. **Đã duyệt – chờ thực thi (Green):** Viền trái #059669, icon check-circle #dcfce7, giá trị lớn màu lục, mô tả "Chờ kiểm tra an toàn Gate 7 & Backup".
4. **Đã xử lý / Đã đóng (Slate):** Viền trái #475569, icon x-circle #f1f5f9, giá trị lớn màu xám đậm, mô tả "Hoàn tất, từ chối hoặc đã hủy".
- **Tương tác trực tiếp:** Bấm vào bất kỳ card KPI nào sẽ tự động áp dụng bộ lọc nhanh tương ứng cho danh sách bảng bên dưới.

### 3.3. Thanh Tìm kiếm, Bộ lọc & Quick Pills
- **Segmented Quick Pills:** Đặt ngay trên bảng gồm các nút: `Tất cả`, `Chờ duyệt`, `Đã duyệt`, `Đang xử lý`, `Đã hoàn tất`, `Từ chối / Đã hủy`. Đồng bộ 2 chiều với dropdown trạng thái, không để xảy ra mâu thuẫn trạng thái lọc.
- **Toolbar một dòng trên desktop:**
  - Ô tìm kiếm đa năng có icon kính lúp: tìm kiếm tức thì theo mã yêu cầu, mã nhân viên, họ tên hoặc username người lập.
  - Dropdown lọc trạng thái chi tiết.
  - Dropdown lọc đơn vị thành viên: `STL`, `SWC`, `VTX`.
  - Bộ chọn khoảng thời gian (Từ ngày → Đến ngày).
  - Nút **Lọc** và nút **Đặt lại** xóa sạch filter về mặc định.

### 3.4. Bảng Dữ liệu Hiện đại & Phân trang
- **Cấu trúc 8 cột tiêu chuẩn:**
  1. *Mã yêu cầu:* Badge monospaced `REQ-...` nền xanh lam nhạt, click mở nhanh chi tiết.
  2. *Nhân sự mục tiêu:* Tên in đậm, mã NV và số CCCD che giấu (`07909******`).
  3. *Đơn vị:* Tag đơn vị nhận diện màu thương hiệu (STL xanh biển, SWC vàng cam, VTX xanh lá).
  4. *Người yêu cầu:* Username Maker (`@username`).
  5. *Người phê duyệt:* Username Checker (`@username` hoặc "Chưa có").
  6. *Ngày tạo:* Định dạng ngày tháng giờ phút Việt Nam (`dd/mm/yyyy hh:mm:ss`).
  7. *Trạng thái:* Badge màu sắc chuẩn hóa kèm dot indicator.
  8. *Thao tác:* Nút "Chi tiết" với icon mắt xem hồ sơ.
- **Trạng thái Trống (Empty State):** Khi không có yêu cầu nào, hiển thị minh họa khiên bảo mật, thông điệp hướng dẫn rõ ràng và nút đặt lại bộ lọc.
- **Loading Skeleton:** Hiệu ứng placeholder animated shimmer khi đang tải dữ liệu từ API.
- **Thanh phân trang chuẩn:** Hiển thị số bản ghi ("Hiển thị X–Y trên tổng số Z yêu cầu"), tùy chọn số dòng (5, 10, 20, 50 dòng/trang) và các nút chuyển trang (« ‹ 1 2 › »).

### 3.5. Chuẩn hóa Status Badges

| Mã trạng thái | Tên hiển thị | Màu chữ / Nền | Màu viền | Dot Indicator |
|---|---|---|---|---|
| `PENDING_APPROVAL` | Chờ phê duyệt | #92400e / #fef3c7 | #fde68a | #f59e0b (Amber) |
| `APPROVED` | Đã phê duyệt | #065f46 / #ecfdf5 | #a7f3d0 | #10b981 (Green) |
| `EXECUTING` | Đang thực thi | #3730a3 / #e0e7ff | #c7d2fe | #6366f1 (Indigo) |
| `COMPLETED` | Hoàn tất | #166534 / #f0fdf4 | #bbf7d0 | #22c55e (Emerald) |
| `REJECTED` | Bị từ chối | #991b1b / #fef2f2 | #fecaca | #ef4444 (Red) |
| `CANCELLED` | Đã hủy | #475569 / #f1f5f9 | #e2e8f0 | #94a3b8 (Slate) |
| `FAILED` | Thất bại | #991b1b / #fef2f2 | #fecaca | #ef4444 (Red) |
| `BLOCKED` | Đang bị chặn | #9a3412 / #fff7ed | #ffedd5 | #f97316 (Orange) |

---

### 3.6. Hộp thoại Thẩm định Chi tiết (`prodHardDeleteDetailDlg`)
Được chia thành 6 khu vực thông tin trực quan:
- **Phần A — Thông tin Yêu cầu:** Grid 6 thông tin cốt lõi (Nhân sự, Đơn vị, Người yêu cầu, Thời điểm tạo, Số CCCD đã che giấu PII `07909******`, Thời hạn thẩm tra 7 ngày) kèm Callout box hiển thị trích dẫn lý do yêu cầu xóa.
- **Phần B — Bảng kê Phạm vi Dữ liệu (Scope Manifest):** 5 counter box thống kê chi tiết số bản ghi bị ảnh hưởng (Hồ sơ chính, Profiles phụ, Tiếp nhận Staging, Tasks đồng bộ, Tệp scan vật lý); thông báo cam kết bảo tồn 100% nhật ký kiểm toán; chuỗi SHA-256 Manifest Hash kèm nút 1-click copy.
- **Phần C — Thẩm tra Phê duyệt 4-Eyes:** Trình bày 2 bước Maker (Người lập) vs Checker (Người duyệt) kèm thông báo quy tắc không thể tự phê duyệt yêu cầu của chính mình.
- **Phần D — Kiểm tra 12 Điều kiện Tiên quyết (12 Safety Gates):**
  - **Cảnh báo Nổi bật Gate 7:** Khung cảnh báo đỏ `GATE 7 BLOCKED: RETENTION_POLICY_NOT_APPROVED` nêu rõ lệnh thực thi bị khóa bảo vệ do chưa có chính sách lưu trữ được phê duyệt.
  - Danh sách checklist 12 điều kiện với biểu tượng trực quan (✓ PASS, ✕ BLOCKED, ○ PENDING/READY).
- **Phần E — Tình trạng Sao lưu & Thực thi:** Hiển thị mã kiểm chứng sao lưu và trạng thái sẵn sàng.
- **Phần F — Nhật ký Thao tác (Chronological Audit Trail):** Danh sách mốc thời gian ghi nhận từ `employee_hard_delete_audit`.
- **Hành động Footer:** Nút Từ chối (Reject), Phê duyệt (Approve), Hủy yêu cầu (Cancel), và nút Thực thi xóa (Execute) bị vô hiệu hóa an toàn do Gate 7 chưa được duyệt.

---

## 4. KẾT QUẢ KIỂM THỬ ĐA THIẾT BỊ (RESPONSIVE VERIFICATION)

Đã chạy kiểm thử Browser E2E trên Google Chrome thực tế với 4 kích thước màn hình và chụp ảnh bằng chứng:

| Viewport | Độ phân giải | Kết quả hiển thị | Screenshot Artifact |
|---|---|---|---|
| **Desktop Ultra/FHD** | 1920 × 1080 | 4 KPI cards trên 1 hàng ngang, Toolbar 1 dòng, Bảng rộng thoáng, không horizontal scrollbar ngoài ý muốn | `screenshots/e2e_hd_redesign_1920_desktop.png` |
| **Laptop HD** | 1366 × 768 | 4 KPI cards co giãn cân đối, Toolbar tự động căn lề hoàn hảo, font chữ sắc nét | `screenshots/e2e_hd_redesign_1366_laptop.png` |
| **Tablet** | 768 × 1024 | 4 KPI cards chuyển thành lưới 2 cột × 2 dòng, Toolbar tự ngắt dòng tự nhiên, bảng scroll ngang mượt mà | `screenshots/e2e_hd_redesign_768_tablet.png` |
| **Mobile** | 390 × 844 | 4 KPI cards chuyển thành 1 cột dọc nhỏ gọn, filter controls chuyển thành full-width, nút bấm tối ưu vùng chạm ngón tay | `screenshots/e2e_hd_redesign_390_mobile.png` |
| **Detail Modal** | 1440 × 900 | Modal căn giữa màn hình, cuộn mượt mà trong giới hạn viewport, 12 Safety Gates hiển thị đầy đủ, không tràn viền | `screenshots/e2e_hd_redesign_detail_modal.png` |
| **Populated Table** | 1920 × 1080 | Hiển thị trọn vẹn dữ liệu mẫu các trạng thái PENDING, APPROVED, EXECUTING, COMPLETED, REJECTED kèm phân trang | `screenshots/e2e_hd_redesign_populated_table.png` |

---

## 5. BẰNG CHỨNG HÌNH ẢNH (SCREENSHOT ARTIFACTS)

````carousel
![Desktop 1920x1080](C:/Users/Admin/.gemini/antigravity/brain/8075309c-9094-41f0-a8ba-aaed531952d1/screenshots/e2e_hd_redesign_1920_desktop.png)
<!-- slide -->
![Laptop 1366x768](C:/Users/Admin/.gemini/antigravity/brain/8075309c-9094-41f0-a8ba-aaed531952d1/screenshots/e2e_hd_redesign_1366_laptop.png)
<!-- slide -->
![Tablet 768x1024](C:/Users/Admin/.gemini/antigravity/brain/8075309c-9094-41f0-a8ba-aaed531952d1/screenshots/e2e_hd_redesign_768_tablet.png)
<!-- slide -->
![Mobile 390x844](C:/Users/Admin/.gemini/antigravity/brain/8075309c-9094-41f0-a8ba-aaed531952d1/screenshots/e2e_hd_redesign_390_mobile.png)
<!-- slide -->
![Detail Modal & 12 Safety Gates](C:/Users/Admin/.gemini/antigravity/brain/8075309c-9094-41f0-a8ba-aaed531952d1/screenshots/e2e_hd_redesign_detail_modal.png)
<!-- slide -->
![Populated Table & Badges](C:/Users/Admin/.gemini/antigravity/brain/8075309c-9094-41f0-a8ba-aaed531952d1/screenshots/e2e_hd_redesign_populated_table.png)
````

---

## 6. CÁC LỖI TÌM THẤY VÀ ĐÃ KHẮC PHỤC

1. **Lỗi chuyển hướng Whitelist Tab (`#admin/hard_delete` redirect về `#admin/docs`):**
   - *Nguyên nhân:* Tại dòng 13 và 12910 của [chat/hr-admin.html](file:///D:/hoso-chat/chat/hr-admin.html), hàm khởi tạo `initAdminPage` chỉ cho phép `['docs', 'users', 'companies', 'employees']`. Khi truy cập tab `hard_delete`, hàm fallback tự động chuyển thành `docs` và postMessage về `index.html`.
   - *Khắc phục:* Bổ sung `'hard_delete'` vào whitelist của [chat/hr-admin.html](file:///D:/hoso-chat/chat/hr-admin.html) ở cả 3 vị trí (redirect script đầu trang, whitelist khởi tạo `initAdminPage`, và router iframe).
2. **Lỗi khai báo biến trùng lặp (`currentLoadedRequestDetails`):**
   - *Nguyên nhân:* Khai báo `let currentLoadedRequestDetails = null;` xuất hiện 2 lần trong file [chat/hr-admin.html](file:///D:/hoso-chat/chat/hr-admin.html).
   - *Khắc phục:* Hợp nhất biến về phạm vi toàn cục dùng chung, xác minh cú pháp 100% bằng Node VM.
3. **Lỗi giao diện tràn chiều ngang trên Tablet và Mobile:**
   - *Nguyên nhân:* Bảng dữ liệu 8 cột gây horizontal scrollbar ngoài ý muốn trên màn hình hẹp.
   - *Khắc phục:* Bổ sung CSS Media Queries ẩn bớt cột phụ trên mobile, chuyển toolbar thành cột dọc full-width, đảm bảo không có layout shift.

---

## 7. CAM KẾT BẢO TOÀN HỆ THỐNG & DỮ LIỆU PRODUCTION

> [!IMPORTANT]
> **Bảo toàn dữ liệu nhân viên Production:** Giữ nguyên chính xác **5 nhân sự cơ sở** (`STL00014`, `SWC00022`, `SWC00023`, `SWC00024`, `SWC00025`), tuyệt đối không có bất kỳ thao tác xóa hay chỉnh sửa dữ liệu thật nào trong quá trình redesign và kiểm thử giao diện.

> [!NOTE]
> **Nghiệp vụ Backend & RBAC:** Không thay đổi bất kỳ logic 4-Eyes nào ở tầng Backend; phân quyền ADMIN STL/SWC/VTX giữ nguyên tính cô lập. Khóa bảo vệ Gate 7 tiếp tục chặn mọi yêu cầu thực thi xóa vật lý khi chưa có văn bản chính sách lưu trữ được duyệt.
