'use strict';
const express = require('express');
const XLSX = require('xlsx');
const { verifyToken } = require('../middleware/auth');
const { verifyReport } = require('../services/biExportToken');
const { assertValidDashboardPayload, MAX_ROWS_PER_DATASET } = require('../services/biDashboardSchemaValidator');
const { getDataset, canUserAccessDataset } = require('../services/biDatasetRegistry');
const { sanitizeBiData } = require('../services/biPrivacy');
const { sanitizeFormulaInjection } = require('../services/biFileSecurityService');
const { logBiAuditEvent } = require('../services/biAuditLogger');
const router = express.Router();

router.post('/', verifyToken, async (req, res) => {
  try {
    const payload = req.body.payload;
    if (!verifyReport(payload, req.user)) return res.status(403).json({ success: false, code: 'INVALID_EXPORT_TOKEN', error: 'Báo cáo không hợp lệ hoặc đã hết thời gian xuất. Vui lòng tạo lại báo cáo.' });
    assertValidDashboardPayload(payload, req.user);
    if (payload.source_type === 'FILE_DATASET') {
      const access = canUserAccessDataset(getDataset(payload.provenance?.file_id), req.user, 'query');
      if (!access.allowed) return res.status(403).json({ success: false, code: 'DATASET_ACCESS_REVOKED' });
    }
    const filters = req.body.filters || {};
    if (typeof filters !== 'object' || Array.isArray(filters) || Object.keys(filters).length > 20) return res.status(400).json({ success: false, code: 'INVALID_FILTERS' });
    const ranges = req.body.ranges || {};
    if (typeof ranges !== 'object' || Array.isArray(ranges) || Object.keys(ranges).length > 20 || Object.values(ranges).some(r => !r || typeof r !== 'object' || ['from', 'to'].some(k => r[k] && !/^\d{4}-\d{2}-\d{2}$/.test(r[k])))) return res.status(400).json({ success: false, code: 'INVALID_RANGES' });
    const dateKey = value => {
      const v = String(value ?? '');
      if (/^\d{4}$/.test(v)) return `${v}-01-01`;
      if (/^\d{4}-Q[1-4]$/.test(v)) return `${v.slice(0, 4)}-${String((Number(v.at(-1)) - 1) * 3 + 1).padStart(2, '0')}-01`;
      return /^\d{4}-\d{2}$/.test(v) ? `${v}-01` : v.slice(0, 10);
    };
    const workbook = XLSX.utils.book_new();
    let totalRows = 0;
    let i = 0;
    for (const rows of Object.values(payload.data_store || {})) {
      const selected = sanitizeBiData(rows).filter(row => Object.entries(filters).every(([key, value]) => !(key in row) || value === '' || String(row[key]) === String(value)) && Object.entries(ranges).every(([key, range]) => !(key in row) || ((!range.from || dateKey(row[key]) >= range.from) && (!range.to || dateKey(row[key]) <= range.to))));
      const safe = selected.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? sanitizeFormulaInjection(v).sanitized : v])));
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(safe), `Data_${++i}`);
      totalRows += safe.length;
    }
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ title: payload.title, generated_at: payload.generated_at, source: payload.source_type, scope: payload.provenance?.tenant_scope || payload.provenance?.file_id, snapshot: true, filters: JSON.stringify(filters), ranges: JSON.stringify(ranges), row_scope: `All filtered groups in report snapshot; maximum ${MAX_ROWS_PER_DATASET} per data source` }]), 'Provenance');
    const file = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    await logBiAuditEvent({ event: 'REPORT_EXPORT', userContext: req.user, fileId: payload.provenance?.file_id, details: { row_count: totalRows } });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="sotrans-bi-report.xlsx"');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(file);
  } catch (_) { return res.status(400).json({ success: false, code: 'EXPORT_FAILED', error: 'Không thể xuất báo cáo.' }); }
});
module.exports = router;
