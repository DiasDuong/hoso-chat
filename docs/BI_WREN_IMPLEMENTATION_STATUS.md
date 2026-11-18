# BI General AI + WrenAI — trạng thái triển khai 16/11/2026

## Kết quả đang chạy

Wren đã được tích hợp bổ trợ General AI trên workspace `D:\hoso-chat`, sử dụng source người dùng cung cấp tại `D:\WrenAI-main`. Sidecar `wrenai-wren-bi-1` đang chạy trên `hrbot_net`, cổng host chỉ bind `127.0.0.1:8091`. `hr-auth` đã được restart để nạp mã mới; gateway tiếp tục phục vụ giao diện tại `http://127.0.0.1:8082/chat/`.

Đây là một bản triển khai có phạm vi giới hạn; chưa tuyên bố hoàn thành toàn bộ BI hoặc nghiệm thu nghiệp vụ. Chưa cập nhật workspace Staging riêng `D:\hoso-chat-staging`; chưa kiểm thử đăng nhập General AI bằng tài khoản người dùng thật trong đợt này.

## Phần đã triển khai

1. **Nền tính toán:** KPI tổng hợp tính trên toàn bộ dòng phù hợp trước top-N; không cộng AVG/MEDIAN/distinct của các nhóm. Growth tính theo thời gian và riêng từng chuỗi; so sánh kỳ ghi rõ `PREVIOUS_OBSERVED_PERIOD`, chưa tự điền kỳ thiếu. OCR đo một phần tạo trạng thái CONDITIONAL, không đổi thiếu dữ liệu thành 0. Ngày không tồn tại bị từ chối.
2. **Quản trị file:** kiểm expiry/trạng thái trước quyền owner/admin; chặn dataset mất JSON; registry refresh theo dấu thời gian và serialize atomic writes, trả lỗi khi persist thất bại. File API/preview/profile/Markdown/v2 dùng masking thống nhất; không cho tính MIN/MAX/SUM/AVG định danh cá nhân. Registry hiện phù hợp một tiến trình ghi; chưa có distributed lock cho nhiều replica.
3. **Wren source:** trích 41 tệp nguyên bản, có SHA-256 và attribution. 17 tệp runtime; bản nguồn khai báo `wrenai 0.18.0`, binding `wren-core-py 0.8.2`. Không cài Wren UI/launcher cũ, không sửa bytes upstream. Docker khóa base digest và 16 phiên bản dependency Linux.
4. **Executor:** replan trên server; kiểm model/cột/hàm, một SELECT, nguồn vật lý thuộc danh sách ba bảng; không nhận MDL/connection/planned SQL từ trình duyệt. Psycopg chạy READ ONLY, statement timeout 3 giây, tối đa 500 dòng/4 query, role không superuser/bypass/create. Tài khoản BI riêng hiện hữu, không fallback operational credentials. Không chạy migration/GRANT.
5. **General AI:** Gemini hiện hữu lập SQL trên semantic catalog; Wren kiểm tra và chạy. KPI cố định giữ Analytics Engine. Kết quả v2 có nguồn/phạm vi/hash/model; lưu context Wren cho lượt hỏi tiếp. Quyền hội thoại kiểm tra trước khi đọc history; conversation có ID dùng history server thay cho metadata client. HTTP và SSE đã kiểm thử trên fixture.
6. **File BI:** nhận một spreadsheet mỗi lượt, tối đa 25 MiB; tối đa 10 sheet/50.000 dòng cho workbook. Persist từng sheet, truy vấn theo schema sheet đã chọn. Một báo cáo có nhiều KPI/measures/charts. Dataset cũ chỉ lưu sheet đầu cần tải lại để dùng sheet khác.
7. **Dashboard:** category/date filters; file filters gọi lại API để tính summary; chart cross-filter/drill trên chiều có trong kết quả; bảng tìm/sắp xếp/phân trang; Excel có chữ ký chống sửa, kiểm quyền lại khi xuất, kèm provenance; PDF qua chức năng In của trình duyệt. Treemap/area/donut/stacked producer/renderer được nối. Chart/ResizeObserver được dispose khi thay báo cáo hoặc rời hội thoại.
8. **Vận hành:** Wren có bearer service token riêng, config/file env được giữ ngoài Git và ACL Windows giới hạn; container không đặc quyền, read-only filesystem, memory/CPU/PID limits và healthcheck. Audit thành công/thất bại có scope/request/model hash/số dòng, không lưu raw SQL/rows. BI credential pool không dùng thông tin operational làm fallback. Cleanup lúc khởi động API chuyển thành opt-in `RETENTION_RUN_ON_STARTUP=true`; lịch retention hằng ngày hiện hữu vẫn giữ.

## Bằng chứng kiểm thử

- 21 Python tests: planner Wren thật + query service với DB fixture (không ghi DB).
- 14 Node adapter tests: scope, process protocol, engine thật, timeout và output limit.
- 8 Node orchestration tests: scope, bounded retry, clarification, numeric metadata và chữ ký export.
- 1 General AI HTTP test chạy nhiều lượt: JWT fixture, lưu context, follow-up multipart, từ chối hội thoại khác, SSE, guest. DB/Gemini/private service dùng fixture.
- 14 foundation tests: summary/growth/date/multi-sheet/ACL/persist concurrent failure/privacy/OCR/audit và null/nonfinite xuyên suốt phép tính.
- 35 kiểm thử hồi quy helper BI có mock engine, không thay cho live E2E.
- 10 kiểm tra browser Edge thật, workbook mẫu + route query/export thật và auth fixture. Tạo ba biểu đồ, bốn KPI; filter làm SUM 944 → 116 → 35; Excel còn đúng 2 dòng; sửa payload bị 403. Null trên biểu đồ giữ khoảng trống; pie có số âm chuyển bar, không ép thành 0. Có ảnh dashboard thật ở `reports/BI_WREN_RELEASE_BROWSER.png`.
- 12 đối chiếu trên PostgreSQL thật: DOC_TOTAL/INTAKE_UPLOADS/DATA_INTEGRITY × STL/VTX/SWC/ALL, tất cả khớp truy vấn đối chiếu READ ONLY.
- 1 luồng với Gemini thật → SQL model → Wren → PostgreSQL thật, tổng các nhóm trạng thái STL khớp nguồn. Chỉ schema/câu hỏi gửi tới provider, không gửi dữ liệu dòng DB.
- 7 kiểm tra health/assets/auth boundary sau restart: health API trực tiếp và qua gateway, JS/CSS mới, health Wren đều 200; API file/export chưa đăng nhập trả 401.

Các bộ test mới đã cấu hình kho tạm riêng và kiểm tra đường dẫn trước khi dọn tệp fixture. Các lần chạy đầu của test orchestration/route đã để lại audit fixture trong log BI trước khi được cô lập; không xóa/sửa lịch sử audit này. Không có thay đổi bảng nhân viên hoặc nghiệp vụ do các bài đối chiếu readonly.

Bằng chứng máy đọc nằm ở `reports/BI_WREN_RELEASE_BROWSER.json`, `reports/BI_WREN_DEPLOYMENT_HEALTH.json`, `reports/BI_WREN_DATASET_INVENTORY.json`. Snapshot candidate source và hash ở `reports/bi-wren-release-20261116/manifest.json`; đây là snapshot phiên bản mới, không phải backup trước thay đổi. Chưa commit/stage/push.

## Cách dùng ngay

Đăng nhập ADMIN hoặc HR trong General AI. Để thử nguồn hệ thống, bỏ chọn dataset file nếu đang có file active, sau đó hỏi:

- “Dùng Wren phân tích số lô tiếp nhận theo trạng thái của STL.”
- “Dùng Wren thống kê văn bản theo loại và trạng thái của STL.”
- Hỏi tiếp: “Còn tháng trước?” hoặc “Đổi sang biểu đồ cột.”

HR chỉ được dùng công ty của mình. ADMIN phải nêu STL/VTX/SWC/ALL; chưa rõ sẽ hỏi lại. Câu hỏi KPI chuẩn vẫn dùng BI engine; câu hỏi quy định thông thường theo luồng General AI/RAG hiện có.

Với file: tải một Excel/CSV, chọn dataset, hỏi SUM/AVG/COUNT theo các cột, dùng slicer để lọc, click biểu đồ để drill. Chọn sheet trong report để dùng cho câu hỏi tiếp theo. Với file vừa tải mà chưa có report, có thể nêu `target_sheet` qua API; giao diện chọn sheet hiện xuất hiện khi report có query_context.

Excel xuất toàn bộ nhóm còn trong snapshot sau bộ lọc, tối đa 500 nhóm mỗi nguồn; tìm kiếm/phân trang bảng chỉ ảnh hưởng bảng hiển thị. PDF in biểu đồ và trang bảng hiện tại, không phải bộ xuất PDF server. Với báo cáo Wren/KPI hệ thống, bộ lọc giao diện chỉ lọc nhóm kết quả đã trả về; KPI toàn phạm vi truy vấn giữ nguyên và có chú thích. Hỏi câu mới để tính lại số liệu hệ thống cho phạm vi khác.

## Tắt Wren hoặc kiểm tra lại

Từ `D:\hoso-chat`:

```powershell
node deploy/set-wren-bi.js disabled
node deploy/set-wren-bi.js enabled
docker exec hr-auth node scripts/verifyWrenReadOnly.js
# Tùy chọn kiểm tra provider thật, có một API call Gemini:
docker exec hr-auth node scripts/verifyWrenReadOnly.js --with-gemini
docker compose -f integrations/wrenai/compose.wren.yml ps
```

Toggle được đọc mỗi request, không cần restart cho lần bật/tắt tiếp theo. `WREN_BI_ENABLED=false` trong environment có ưu tiên cao hơn file config. Tắt Wren đưa các câu hỏi còn phù hợp về luồng hiện hữu; không rollback các bản sửa nền BI. Không đưa `.env.runtime` hoặc `auth-service/storage/bi_wren_config.json` vào Git/log/report.

## Công việc còn cần hoàn tất

- **Unified BI:** chờ người dùng xác nhận chỉ số, khóa ghép, cardinality, đơn vị/thời gian và quyền trên mọi nguồn. Không tự ghép file với nhân viên/staging hoặc dùng staging làm headcount.
- **Ba KPI chưa có dữ liệu nguồn:** INTAKE_FAILURE, INTAKE_DURATION, POLICY_CONFLICT tiếp tục unavailable. Cần bổ sung telemetry/định nghĩa và backfill khi có dữ liệu thật.
- **18 dataset mất JSON:** kiểm kê lúc 12:19 giờ Việt Nam cho thấy registry 20 entries, 2 READY/18 MISSING_DATA; không thấy bản gốc ứng viên trong kho hiện tại. Giữ registry, không tái tạo từ preview. Cần bản gốc hoặc backup được xác minh; chưa tìm toàn bộ ổ đĩa ngoài kho này.
- **Nghiệm thu:** tài khoản người dùng thật, bộ câu hỏi nghiệp vụ có expected result, layout mobile, chia sẻ/thu hồi và refresh hội thoại trên bản Staging đồng nhất. Một câu hỏi qua provider thật chưa chứng minh độ chính xác NL cho mọi báo cáo.
- **Lưu state:** context phân tích qua hội thoại đã lưu; slicer/search/page là state trong phiên giao diện, chưa persist giữa lần reload. Hỏi tiếp dùng plan server đã lưu của lượt chat, không tự dùng bộ lọc tạm trên dashboard.
- **Ranh giới dữ liệu:** không có RLS mới trong PostgreSQL; scope được gắn bằng manifest và kiểm quyền ở Hub, private service không public qua gateway. File engine vẫn dùng JSON, chưa chạy file bằng Wren/DuckDB.

Chỉ đánh dấu hoàn tất toàn bộ chức năng khi các mục thuộc phạm vi được chọn đã có bằng chứng nghiệp vụ tương ứng.
