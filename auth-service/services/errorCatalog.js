/**
 * SOTRANS HUB - Centralized Error Message Catalog & API Error Contract
 * Standardizes API Error Responses across Document Governance & Logistics AI Platform
 */

const crypto = require('crypto');

const ERROR_CATALOG = {
  // 1. Quản trị trùng lặp & xung đột chính sách
  DUPLICATE_DOCUMENT: {
    status: 409,
    message: 'Tài liệu đã tồn tại trong hệ thống.',
    user_message: 'Tài liệu đã tồn tại. Vui lòng kiểm tra trước khi tải lên.',
    retryable: false,
    severity: 'MEDIUM'
  },
  EXACT_DUPLICATE_FILE: {
    status: 409,
    message: 'Tập tin này có mã băm SHA-256 trùng khớp 100% với văn bản đã có trong hệ thống.',
    user_message: 'Tệp tải lên trùng khớp 100% nội dung (SHA-256) với văn bản đã có trong hệ thống.',
    retryable: false,
    severity: 'MEDIUM'
  },
  IDENTICAL_FILE_SAME_FAMILY: {
    status: 409,
    message: 'Tệp tải lên có nội dung trùng khớp 100% (SHA-256) với phiên bản hiện tại cùng dòng văn bản.',
    user_message: 'Tệp tải lên trùng nội dung 100% với phiên bản hiện tại của văn bản này.',
    retryable: false,
    severity: 'MEDIUM'
  },
  DUPLICATE_DOC_CODE: {
    status: 409,
    message: 'Mã hiệu văn bản đã tồn tại trong hệ thống.',
    user_message: 'Mã hiệu văn bản đã tồn tại. Vui lòng nhập mã hiệu khác hoặc thiết lập quan hệ thay thế.',
    retryable: false,
    severity: 'MEDIUM'
  },
  TRUE_CONFLICT: {
    status: 409,
    message: 'Phát hiện mâu thuẫn quy phạm trực tiếp với văn bản đang áp dụng.',
    user_message: 'Phát hiện mâu thuẫn trực tiếp với văn bản đang áp dụng.',
    retryable: false,
    severity: 'HIGH'
  },
  POTENTIAL_CONFLICT: {
    status: 422,
    message: 'Có khả năng chồng lấn phạm vi áp dụng giữa các văn bản.',
    user_message: 'Có khả năng chồng lấn phạm vi. Cần xác minh trước khi phê duyệt.',
    retryable: false,
    severity: 'MEDIUM'
  },
  INSUFFICIENT_EVIDENCE: {
    status: 422,
    message: 'Chưa đủ chứng cứ điều khoản để kết luận quan hệ chính sách.',
    user_message: 'Chưa đủ nội dung để kết luận. Vui lòng kiểm tra tài liệu gốc.',
    retryable: true,
    severity: 'LOW'
  },
  AMENDS_CLAUSE_SCOPE_REQUIRED: {
    status: 409,
    message: 'Quan hệ sửa đổi (amends) bắt buộc phải khai báo chi tiết danh mục điều khoản sửa đổi (Clause-level Scope).',
    user_message: 'Quan hệ sửa đổi (amends) bắt buộc phải khai báo danh mục điều khoản sửa đổi trước khi phê duyệt.',
    retryable: false,
    severity: 'HIGH'
  },
  MISSING_CLAUSE_SCOPE: {
    status: 400,
    message: 'Quan hệ sửa đổi (amends) bắt buộc phải khai báo ít nhất một điều khoản sửa đổi.',
    user_message: 'Vui lòng khai báo ít nhất một điều khoản sửa đổi cho quan hệ này.',
    retryable: false,
    severity: 'MEDIUM'
  },
  DUPLICATE_CLAUSE_REFERENCE: {
    status: 400,
    message: 'Phát hiện tham chiếu điều khoản bị trùng lặp trong cùng một quan hệ văn bản.',
    user_message: 'Tham chiếu điều khoản bị trùng lặp. Vui lòng kiểm tra lại danh sách điều khoản.',
    retryable: false,
    severity: 'LOW'
  },
  INVALID_CLAUSE_REFERENCE: {
    status: 400,
    message: 'Tham chiếu điều khoản không hợp lệ hoặc thiếu thông tin điều khoản đích.',
    user_message: 'Tham chiếu điều khoản không hợp lệ. Vui lòng nhập đầy đủ thông tin.',
    retryable: false,
    severity: 'LOW'
  },
  APPROVED_RELATIONSHIP_IMMUTABLE: {
    status: 400,
    message: 'Không thể chỉnh sửa hoặc xóa quan hệ/điều khoản đã được phê duyệt chính thức. Để thay đổi, vui lòng sử dụng quy trình thu hồi hoặc thay thế.',
    user_message: 'Quan hệ văn bản này đã được phê duyệt chính thức và không thể thay đổi hoặc xóa.',
    retryable: false,
    severity: 'HIGH'
  },

  // 2. Tệp đính kèm & Lưu trữ
  FILE_URI_MISSING: {
    status: 400,
    message: 'Tài liệu chưa được gắn tệp tin nguồn.',
    user_message: 'Tài liệu chưa được gắn tệp gốc. Vui lòng tải bổ sung.',
    retryable: true,
    severity: 'MEDIUM'
  },
  FILE_NOT_FOUND_ON_DISK: {
    status: 404,
    message: 'Không tìm thấy tệp tin nguồn trong kho lưu trữ vật lý.',
    user_message: 'Không tìm thấy tệp gốc trong kho lưu trữ.',
    retryable: false,
    severity: 'HIGH'
  },
  FILE_TOO_LARGE: {
    status: 413,
    message: 'Dung lượng tệp vượt quá giới hạn tối đa 25MB.',
    user_message: 'Tệp vượt quá dung lượng cho phép 25 MB.',
    retryable: false,
    severity: 'MEDIUM'
  },
  INVALID_PDF_STRUCTURE: {
    status: 400,
    message: 'Cấu trúc tệp PDF không hợp lệ hoặc bị mã hóa hỏng.',
    user_message: 'Tệp PDF không hợp lệ hoặc bị hỏng.',
    retryable: false,
    severity: 'HIGH'
  },
  INVALID_DOCX_STRUCTURE: {
    status: 400,
    message: 'Cấu trúc tệp DOCX không hợp lệ hoặc bị mã hóa hỏng.',
    user_message: 'Tệp DOCX không hợp lệ hoặc bị hỏng.',
    retryable: false,
    severity: 'HIGH'
  },

  // 3. Trích xuất OCR & Chunking
  EXTRACTION_FAILED: {
    status: 500,
    message: 'Tiến trình trích xuất OCR văn bản thất bại.',
    user_message: 'Không thể trích xuất nội dung. Vui lòng thử lại.',
    retryable: true,
    severity: 'HIGH'
  },
  CHUNKING_FAILED: {
    status: 500,
    message: 'Tiến trình phân chia đoạn văn bản (chunking) thất bại.',
    user_message: 'Không thể tạo các đoạn nội dung từ tài liệu.',
    retryable: true,
    severity: 'HIGH'
  },
  ZERO_CHUNK: {
    status: 422,
    message: 'Văn bản chưa sinh được các đoạn trích xuất hợp lệ trong CSDL.',
    user_message: 'Tài liệu chưa có nội dung chunks để xử lý tiếp.',
    retryable: true,
    severity: 'MEDIUM'
  },
  INDEXING_FAILED: {
    status: 500,
    message: 'Đồng bộ vector embedding sang Qdrant thất bại.',
    user_message: 'Tài liệu đã lưu nhưng chưa đồng bộ được dữ liệu tìm kiếm AI.',
    retryable: true,
    severity: 'HIGH'
  },

  // 4. Phê duyệt & Kích hoạt (Governance Lifecycle)
  CANNOT_OVERWRITE_ACTIVE_DOCUMENT: {
    status: 409,
    message: 'Không thể thay thế tệp nguồn của văn bản đang có hiệu lực thi hành.',
    user_message: 'Không thể thay thế tệp của văn bản đang có hiệu lực.',
    retryable: false,
    severity: 'HIGH'
  },
  APPROVE_BLOCKED_CONFLICT: {
    status: 409,
    message: 'Phê duyệt bị chặn do văn bản có xung đột chính sách trực tiếp (TRUE_CONFLICT).',
    user_message: 'Chưa thể phê duyệt do có xung đột cần xử lý.',
    retryable: false,
    severity: 'HIGH'
  },
  APPROVE_BLOCKED_ZERO_CHUNK: {
    status: 409,
    message: 'Không thể phê duyệt văn bản chưa có đoạn trích xuất (0 chunks).',
    user_message: 'Chưa thể phê duyệt vì tài liệu chưa có chunks hợp lệ.',
    retryable: true,
    severity: 'HIGH'
  },

  // 5. Phân quyền & Bảo mật (Security & RBAC)
  PERMISSION_DENIED: {
    status: 403,
    message: 'Người dùng không có quyền hạn cần thiết để thực thi thao tác.',
    user_message: 'Bạn không có quyền thực hiện thao tác này.',
    retryable: false,
    severity: 'HIGH'
  },
  TENANT_SCOPE_VIOLATION: {
    status: 403,
    message: 'Văn bản nằm ngoài phạm vi đơn vị/công ty được phép quản lý.',
    user_message: 'Tài liệu không thuộc phạm vi đơn vị được phép quản lý.',
    retryable: false,
    severity: 'HIGH'
  },

  // 6. Hạ tầng & Hệ thống (System & Network)
  NETWORK_ERROR: {
    status: 503,
    message: 'Không thể kết nối đến dịch vụ hạ tầng mạng.',
    user_message: 'Không thể kết nối máy chủ. Vui lòng thử lại.',
    retryable: true,
    severity: 'HIGH'
  },
  INTERNAL_ERROR: {
    status: 500,
    message: 'Lỗi xử lý nội bộ trong máy chủ ứng dụng.',
    user_message: 'Hệ thống đang gặp sự cố. Vui lòng thử lại hoặc liên hệ quản trị viên.',
    retryable: true,
    severity: 'HIGH'
  },

  // Các mã lỗi bổ trợ tương thích
  DOCUMENT_NOT_FOUND: {
    status: 404,
    message: 'Không tìm thấy tài liệu trong hệ thống.',
    user_message: 'Không tìm thấy tài liệu được yêu cầu.',
    retryable: false,
    severity: 'MEDIUM'
  },
  INVALID_UUID: {
    status: 400,
    message: 'Định dạng mã định danh (UUID) không hợp lệ.',
    user_message: 'Mã văn bản (ID) không đúng định dạng.',
    retryable: false,
    severity: 'LOW'
  },
  DOCUMENT_ACTIVE: {
    status: 409,
    message: 'Văn bản đang áp dụng (Active) không thể xóa trực tiếp.',
    user_message: 'Văn bản đang áp dụng không thể xóa trực tiếp. Vui lòng lưu trữ trước khi chuyển vào thùng rác.',
    retryable: false,
    severity: 'HIGH'
  },
  DOCUMENT_PENDING_APPROVAL: {
    status: 409,
    message: 'Văn bản đang chờ phê duyệt không thể xóa trực tiếp.',
    user_message: 'Văn bản đang chờ phê duyệt không thể xóa trực tiếp. Hãy thu hồi yêu cầu trước khi xóa.',
    retryable: false,
    severity: 'MEDIUM'
  },
  DOCUMENT_SCHEDULED: {
    status: 409,
    message: 'Văn bản đang chờ hiệu lực không thể xóa trực tiếp.',
    user_message: 'Văn bản đang chờ đến ngày hiệu lực không thể xóa trực tiếp. Vui lòng hủy bỏ trước khi chuyển thùng rác.',
    retryable: false,
    severity: 'HIGH'
  },
  HR_STATUS_FORBIDDEN: {
    status: 403,
    message: 'Nhân sự chỉ được phép xóa văn bản ở trạng thái Bản nháp hoặc Bị từ chối.',
    user_message: 'Bạn chỉ được phép xóa văn bản ở trạng thái Bản nháp hoặc Bị từ chối.',
    retryable: false,
    severity: 'HIGH'
  },
  HR_OWNER_FORBIDDEN: {
    status: 403,
    message: 'Nhân sự chỉ được xóa văn bản do chính mình tải lên.',
    user_message: 'Bạn chỉ được phép xóa tài liệu do chính tài khoản của bạn tải lên.',
    retryable: false,
    severity: 'HIGH'
  }
};

/**
 * Xây dựng đối tượng phản hồi lỗi chuẩn hóa (Centralized Error Contract)
 */
function buildErrorResponse(errorCode, customOverrides = {}, req = null) {
  const cat = ERROR_CATALOG[errorCode] || ERROR_CATALOG.INTERNAL_ERROR;
  const requestId = (req && (req.id || req.headers['x-request-id'])) || crypto.randomUUID();

  const userMessage = customOverrides.user_message || customOverrides.error || cat.user_message;
  const technicalMessage = customOverrides.message || cat.message;

  return {
    status: customOverrides.status || cat.status,
    body: {
      success: false,
      error_code: errorCode,
      code: errorCode, // Backwards compatibility
      message: technicalMessage,
      user_message: userMessage,
      error: userMessage, // Backwards compatibility for existing UI toast / callers
      details: customOverrides.details || null,
      ...customOverrides,
      request_id: requestId,
      retryable: typeof customOverrides.retryable === 'boolean' ? customOverrides.retryable : cat.retryable,
      timestamp: new Date().toISOString()
    }
  };
}

/**
 * Helper gửi response lỗi trực tiếp từ controller
 */
function sendError(res, errorCode, customOverrides = {}, req = null) {
  const { status, body } = buildErrorResponse(errorCode, customOverrides, req || res.req);
  return res.status(status).json(body);
}

module.exports = {
  ERROR_CATALOG,
  buildErrorResponse,
  sendError
};
