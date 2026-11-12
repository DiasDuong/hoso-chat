const fs = require('fs');
const vm = require('vm');

console.log('=== TEST SUITE: MARKDOWN LIST NUMBERING FIX ===\n');

// 1. Test chat/index.html parseMarkdown
const indexHtml = fs.readFileSync('D:/hoso-chat/chat/index.html', 'utf8');
const startIdx = indexHtml.indexOf('function parseMarkdown(md, isStreaming = false) {');
const endIdx = indexHtml.indexOf('async function initChatWorkspaceOnStartup()', startIdx);
const parseMarkdownCode = indexHtml.slice(startIdx, endIdx);

const sandboxIndex = {
  esc: (s) => s ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '',
  renderMath: (t) => t,
  renderMathFallback: (t) => t
};
vm.createContext(sandboxIndex);
vm.runInContext(parseMarkdownCode, sandboxIndex);

const parseMarkdown = sandboxIndex.parseMarkdown;

// Test cases
const testCases = [
  {
    name: "User Reported Case: Sequential items with sub-bullets and blank lines",
    input: `1. Lương tháng 13:
- Người lao động có hợp đồng chính thức đủ 12 tháng.
- Mức thưởng 01 tháng.

2. Bảo hiểm và Chăm sóc sức khỏe:
- Đóng 100% BHXH, BHYT, BHTN.
- Tặng thẻ PVI.

3. Chế độ nghỉ phép thâm niên:
- 12 ngày phép năm chuẩn.

4. Ngân sách đào tạo:
- Tài trợ 100% chi phí học và thi.

5. Hệ thống Phụ cấp Logistics Đặc thù:
- Độc hại & Kho lạnh đặc thù.`,
    verify: (html) => {
      // Must contain single <ol> wrapper or sequentially numbered items
      const hasItem1 = html.includes('<li value="1">Lương tháng 13:');
      const hasItem2 = html.includes('<li value="2">Bảo hiểm và Chăm sóc sức khỏe:');
      const hasItem3 = html.includes('<li value="3">Chế độ nghỉ phép thâm niên:');
      const hasItem4 = html.includes('<li value="4">Ngân sách đào tạo:');
      const hasItem5 = html.includes('<li value="5">Hệ thống Phụ cấp Logistics Đặc thù:');
      const nestedUls = (html.match(/<ul><li>/g) || []).length;
      return hasItem1 && hasItem2 && hasItem3 && hasItem4 && hasItem5 && nestedUls >= 4;
    }
  },
  {
    name: "Standard CommonMark tight ordered list",
    input: `1. Bước 1\n2. Bước 2\n3. Bước 3`,
    verify: (html) => {
      return html.includes('<li value="1">Bước 1') &&
             html.includes('<li value="2">Bước 2') &&
             html.includes('<li value="3">Bước 3');
    }
  },
  {
    name: "Loose ordered list with blank lines between items",
    input: `1. Mục A\n\n2. Mục B\n\n3. Mục C`,
    verify: (html) => {
      return html.includes('<li value="1">Mục A') &&
             html.includes('<li value="2">Mục B') &&
             html.includes('<li value="3">Mục C');
    }
  },
  {
    name: "Unordered list with multiple bullet styles (*, -, •, +)",
    input: `* Sao\n- Gạch\n• Chấm tròn\n+ Cộng`,
    verify: (html) => {
      return html.includes('<ul>') &&
             html.includes('<li>Sao</li>') &&
             html.includes('<li>Gạch</li>') &&
             html.includes('<li>Chấm tròn</li>') &&
             html.includes('<li>Cộng</li>');
    }
  },
  {
    name: "Alphabetical sub-list under numeric item",
    input: `1. Quy trình tuyển dụng:
a) Nộp hồ sơ
b) Phỏng vấn
c) Thử việc`,
    verify: (html) => {
      return html.includes('<li value="1">Quy trình tuyển dụng:') &&
             html.includes('<ol type="a">') &&
             html.includes('<li>Nộp hồ sơ</li>');
    }
  },
  {
    name: "Interrupted list by paragraph keeps numbering",
    input: `1. Phần một
- Ghi chú 1

Đoạn văn phân tích nằm ở giữa.

2. Phần hai
- Ghi chú 2`,
    verify: (html) => {
      return html.includes('<li value="1">Phần một') &&
             html.includes('<p>Đoạn văn phân tích nằm ở giữa.</p>') &&
             html.includes('<li value="2">Phần hai');
    }
  }
];

let allPassed = true;

testCases.forEach((tc, idx) => {
  const resultHtml = parseMarkdown(tc.input);
  const ok = tc.verify(resultHtml);
  console.log(`[${ok ? 'PASS' : 'FAIL'}] Test ${idx + 1}: ${tc.name}`);
  if (!ok) {
    allPassed = false;
    console.log('Result HTML:', resultHtml);
  }
});

// 2. Test chat/hr-admin.html formatAdminReplyMarkdown
console.log('\n--- Testing chat/hr-admin.html ---');
const adminHtml = fs.readFileSync('D:/hoso-chat/chat/hr-admin.html', 'utf8');
const adminStart = adminHtml.indexOf('function formatAdminReplyMarkdown(text) {');
const adminEnd = adminHtml.indexOf('function renderReply(reply, sources){', adminStart);
const adminCode = adminHtml.slice(adminStart, adminEnd);

const sandboxAdmin = {
  esc: (s) => s ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''
};
vm.createContext(sandboxAdmin);
vm.runInContext(adminCode, sandboxAdmin);

const adminResult = sandboxAdmin.formatAdminReplyMarkdown(`1. Đầu tiên:\n- Sub 1\n2. Thứ hai:\n- Sub 2`);
const adminPass = adminResult.includes('<li value="1">Đầu tiên') &&
                  adminResult.includes('<li value="2">Thứ hai') &&
                  adminResult.includes('<ul><li>Sub 1');

console.log(`[${adminPass ? 'PASS' : 'FAIL'}] HR Admin reply markdown list rendering`);
if (!adminPass) {
  allPassed = false;
  console.log('Admin Result:', adminResult);
}

console.log('\n=======================================');
if (allPassed) {
  console.log('ALL TESTS PASSED! Markdown list numbering is completely resolved.');
} else {
  console.error('SOME TESTS FAILED!');
  process.exit(1);
}
