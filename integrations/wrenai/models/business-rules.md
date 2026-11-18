# SOTRANS BI — quy tắc ngữ nghĩa khởi đầu, chưa duyệt nghiệp vụ

1. Câu hỏi về 17 KPI chuẩn tiếp tục dùng Analytics Engine hiện tại. Wren bổ trợ ad-hoc; không thay định nghĩa KPI đã có.
2. Tổng văn bản là COUNT(DISTINCT doc_version_id) trên scope được phép, loại deleted_at khác null. Không mặc định COUNT(*) tương đương. Hiệu lực cần status, effective_date và expiry_date, không chỉ status.
3. Tài liệu group-wide branch_scope chứa all được xem cùng tài liệu của đơn vị được cấp quyền. Scope chỉ do backend chọn từ STL/VTX/SWC/ALL; ALL chỉ dành cho ADMIN có yêu cầu rõ ràng.
4. Một intake batch không phải một hồ sơ nhân sự; total_files là số file của lô, không phải số employee. completed không chứng minh mọi file/hồ sơ đã chuyển đổi.
5. Một staged record không phải một nhân viên đang làm việc. Không trả headcount/payroll từ hub_staged_records. Nếu câu hỏi thiếu nguồn/định nghĩa phải hỏi lại.
6. suspected_duplicate là dấu nghi ngờ, không phải trùng lặp đã xác nhận.
7. Không suy diễn failure rate/duration/policy conflict từ trạng thái tùy ý. Ba KPI đang BLOCKED phải tiếp tục có unavailable reason cho tới khi source được duyệt.
8. AVG phải đúng trọng số; MEDIAN và DISTINCT_COUNT không cộng các nhóm chồng lặp. Growth/comparison phải theo timeline đã sort, xử lý kỳ thiếu và mẫu số bằng 0 rõ ràng.
9. Ngày nghiệp vụ theo UTC+7, khoảng kỳ cần start-inclusive/end-exclusive. Timestamp metadata của prototype cần kiểm với kiểu vật lý PostgreSQL ở Staging.
10. Không sinh truy vấn tên thật, CCCD, email, điện thoại, lương hoặc credential từ các model này. Không truy cập bảng vật lý bằng tên/schema do người dùng cung cấp.
11. File upload là nguồn riêng có owner/grants/expiry/version. Không tự join file với PostgreSQL khi chưa có key/cardinality và quyền trên mọi nguồn.
12. Planned SQL không phải dữ liệu đã truy vấn. Không hiển thị số liệu nếu chưa có execution result có provenance; không dùng SELECT literal làm bằng chứng dữ liệu.
