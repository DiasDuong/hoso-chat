const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

const OUTPUT_BASE_DIR = path.join(__dirname, '..', 'data', 'agent_outputs');
if (!fs.existsSync(OUTPUT_BASE_DIR)) {
  try { fs.mkdirSync(OUTPUT_BASE_DIR, { recursive: true }); } catch (e) {}
}

/**
 * Excel Export Service for Personal AI Agents
 * Tạo tệp Excel .xlsx chuẩn, lưu vào phân vùng bảo mật và đăng ký metadata vào agent_output_files.
 */
async function generateExcelReport(options = {}) {
  const {
    userId,
    agentId,
    conversationId,
    fileName = 'Bao_cao_tong_hop.xlsx',
    sheets = [],
    metadata = {}
  } = options;

  if (!userId || !agentId) {
    throw new Error('Thiếu thông tin userId hoặc agentId để xuất tệp.');
  }

  const cleanFileName = path.basename(fileName).replace(/[^a-zA-Z0-9._\- \u00C0-\u1EF9]/g, '_');
  const fileId = crypto.randomUUID();
  const now = new Date();
  const yearDir = path.join(OUTPUT_BASE_DIR, String(userId), String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'));

  if (!fs.existsSync(yearDir)) {
    fs.mkdirSync(yearDir, { recursive: true });
  }

  const diskFileName = `${fileId}_${cleanFileName}`;
  const diskPath = path.join(yearDir, diskFileName);

  // Tạo workbook SheetJS
  const workbook = XLSX.utils.book_new();

  if (!Array.isArray(sheets) || sheets.length === 0) {
    // Sheet mặc định nếu không truyền
    const defaultSheet = XLSX.utils.aoa_to_sheet([['STT', 'Nội dung', 'Ghi chú']]);
    XLSX.utils.book_append_sheet(workbook, defaultSheet, 'Sheet1');
  } else {
    for (const sh of sheets) {
      const sName = (sh.sheetName || 'Sheet').slice(0, 31);
      let ws;

      if (Array.isArray(sh.rows) && sh.rows.length > 0) {
        if (typeof sh.rows[0] === 'object' && !Array.isArray(sh.rows[0])) {
          ws = XLSX.utils.json_to_sheet(sh.rows);
        } else {
          const header = sh.columns || [];
          const aoa = header.length ? [header, ...sh.rows] : sh.rows;
          ws = XLSX.utils.aoa_to_sheet(aoa);
        }
      } else {
        const header = sh.columns || ['STT', 'Tiêu đề'];
        ws = XLSX.utils.aoa_to_sheet([header]);
      }

      // Tự động tính độ rộng cột (col width)
      if (sh.columns && Array.isArray(sh.columns)) {
        ws['!cols'] = sh.columns.map(c => ({ wch: Math.max(String(c).length + 4, 15) }));
      }

      XLSX.utils.book_append_sheet(workbook, ws, sName);
    }
  }

  // Ghi file nhị phân ra đĩa
  const fileBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
  fs.writeFileSync(diskPath, fileBuffer);

  const fileSize = fileBuffer.length;
  const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // Đăng ký vào bảng agent_output_files với hạn 7 ngày
  const insertSql = `
    INSERT INTO public.agent_output_files (
      id, user_id, agent_id, conversation_id, file_name, storage_path,
      mime_type, file_size, checksum_sha256, status, download_count, metadata,
      created_at, expires_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      $7, $8, 'READY', 0, $9,
      NOW(), NOW() + INTERVAL '7 days'
    ) RETURNING *;
  `;

  const metaObj = {
    ...metadata,
    sheetNames: workbook.SheetNames,
    generator: 'DataEngine ExcelExportService v1.0'
  };

  const res = await db.query(insertSql, [
    fileId, userId, agentId, conversationId || null,
    cleanFileName, diskPath, fileSize, checksum, JSON.stringify(metaObj)
  ]);

  const outputRecord = res.rows[0];

  return {
    fileId: outputRecord.id,
    fileName: outputRecord.file_name,
    fileSize: outputRecord.file_size,
    mimeType: outputRecord.mime_type,
    checksum: outputRecord.checksum_sha256,
    expiresAt: outputRecord.expires_at,
    downloadUrl: `/api/agents/files/${outputRecord.id}/download`
  };
}

module.exports = {
  generateExcelReport,
  OUTPUT_BASE_DIR
};
