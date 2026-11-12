const express = require('express');
const router = express.Router();
const http = require('http');
const crypto = require('crypto');
const db = require('../db');
const { verifyToken } = require('../middleware/auth');
const ocrDocumentPipeline = require('../services/ocrDocumentPipeline');

// In-memory Policy Response Cache with Doc-Version Bound Invalidation
const policyCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour max TTL
const MAX_CACHE_ENTRIES = 500;

let cachedDocHash = null;
let lastDocHashCheck = 0;
const DOC_HASH_TTL_MS = 5000; // Recheck DB doc version hash at most every 5 seconds

async function getActiveDocVersionHash(includeTesting = false) {
  const now = Date.now();
  if (!includeTesting && cachedDocHash && (now - lastDocHashCheck < DOC_HASH_TTL_MS)) {
    return cachedDocHash;
  }
  try {
    const statusFilter = includeTesting ? "status IN ('active', 'testing')" : "status = 'active'";
    const q = `
      SELECT md5(COALESCE(string_agg(
        concat_ws(':', doc_version_id::text, version::text, status::text, file_sha256, title),
        ',' ORDER BY doc_version_id
      ), '')) as doc_hash
      FROM documents
      WHERE ${statusFilter}
    `;
    const res = await db.query(q);
    const hash = res.rows[0]?.doc_hash || 'empty';
    if (!includeTesting) {
      cachedDocHash = hash;
      lastDocHashCheck = now;
    }
    return hash;
  } catch (err) {
    console.warn('Failed to compute doc version hash:', err.message);
    return 'fallback_' + Math.floor(now / 60000);
  }
}

function computeCacheKey(normalizedQuery, historyKey, company, role, scope, docHash) {
  const raw = `${normalizedQuery}|${historyKey}|${company}|${role}|${scope}|${docHash}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// POST /api/policy/cache/clear - Clear in-memory policy cache (Admin / Internal test use)
router.post('/cache/clear', verifyToken, (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Only ADMIN can clear policy cache.' });
  }
  const clearedCount = policyCache.size;
  policyCache.clear();
  cachedDocHash = null;
  lastDocHashCheck = 0;
  return res.json({ success: true, message: `Cleared ${clearedCount} cached policy responses.` });
});

// POST /api/policy/chat - Strictly scoped Policy Chat endpoint
router.post('/chat', verifyToken, async (req, res) => {
  const { message, company_id, scope, conversation_id, history, no_cache } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ success: false, error: 'Vui lòng nhập nội dung câu hỏi tra cứu quy định.' });
  }

  // Chặn vai trò USER (Guest/Khách) tra cứu quy định nội bộ doanh nghiệp
  if (req.user.role === 'USER') {
    return res.status(403).json({
      success: false,
      error: '403 Forbidden: Tra cứu Quy định & Chính sách nội bộ chỉ dành cho Nhân viên hoặc Quản trị viên doanh nghiệp. Tài khoản Khách (Guest) không có quyền truy cập.'
    });
  }

  const BRANCH_MAP = {
    'STL': 'sotrans_logistics',
    'VTX': 'vietranstimex',
    'SWC': 'sowatco'
  };

  // Strictly enforce server-verified claims from JWT & Database (immune to client tampering)
  let verifiedCompany = req.user.company_id || 'STL';
  let targetBranch = 'sotrans_logistics';

  if (req.user.role === 'ADMIN') {
    if (company_id && ['STL', 'VTX', 'SWC'].includes(String(company_id).toUpperCase())) {
      verifiedCompany = String(company_id).toUpperCase();
      targetBranch = BRANCH_MAP[verifiedCompany] || 'all';
    } else {
      verifiedCompany = 'ALL';
      targetBranch = 'all';
    }
  } else {
    // Non-admin is strictly locked to their assigned company
    verifiedCompany = req.user.company_id || 'STL';
    targetBranch = BRANCH_MAP[verifiedCompany] || 'sotrans_logistics';
  }

  // Enforce Testing/Draft vs Production/Approved scope (Section 6)
  // Only ADMIN and HR are authorized to query testing/draft documents
  const requestedScope = String(scope || '').toLowerCase().trim();
  const isPrivilegedTester = ['ADMIN', 'HR'].includes(req.user.role);

  let includeTesting = false;
  let finalScope = 'production';

  if (requestedScope === 'testing' || requestedScope === 'draft') {
    if (!isPrivilegedTester) {
      return res.status(403).json({
        success: false,
        error: '403 Forbidden: Chỉ Quản trị viên và Quản lý Nhân sự mới có quyền truy cập phạm vi kiểm thử tài liệu (Testing/Draft).'
      });
    }
    includeTesting = true;
    finalScope = 'testing';
  }

  const verifiedRole = (req.user.role || 'EMPLOYEE').toLowerCase();
  const verifiedEmpCode = req.user.employee_code || req.user.username;
  const verifiedEmpName = req.user.employee_name || req.user.username;

  // Resolve Conversation History (Multi-turn Context Support)
  let conversationHistory = [];
  if (Array.isArray(history) && history.length > 0) {
    conversationHistory = history.slice(-6).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 1000)
    }));
  } else if (conversation_id && /^[0-9a-fA-F-]{36}$/.test(String(conversation_id))) {
    try {
      const histRes = await db.query(
        `SELECT role, content FROM ai_messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC LIMIT 6`,
        [conversation_id]
      );
      conversationHistory = histRes.rows.reverse().map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '').slice(0, 1000)
      }));
    } catch (err) {
      console.warn('Could not fetch conversation history:', err.message);
    }
  }

  const cleanMessage = String(message).trim();
  const normalizedQuery = cleanMessage.toLowerCase().replace(/\s+/g, ' ');
  const historyKey = conversationHistory.map(h => `${h.role}:${h.content}`).join('|');

  // Check Policy Version-Bound Cache
  const skipCache = no_cache === true || req.headers['x-skip-cache'] === 'true';
  const docHash = await getActiveDocVersionHash(includeTesting);
  const cacheKey = computeCacheKey(normalizedQuery, historyKey, verifiedCompany, verifiedRole, finalScope, docHash);

  if (!skipCache && policyCache.has(cacheKey)) {
    const cachedEntry = policyCache.get(cacheKey);
    if (Date.now() - cachedEntry.cachedAt < CACHE_TTL_MS) {
      return res.status(200).json({
        ...cachedEntry.result,
        cached: true,
        cache_key: cacheKey,
        doc_version_hash: docHash
      });
    } else {
      policyCache.delete(cacheKey);
    }
  }

  const n8nPayload = {
    message: cleanMessage,
    history: conversationHistory,
    role: verifiedRole,
    branch: targetBranch,
    company_id: verifiedCompany,
    user_id: verifiedEmpCode,
    user_name: verifiedEmpName,
    include_testing: includeTesting,
    scope: finalScope
  };

  const postData = JSON.stringify(n8nPayload);

  const options = {
    hostname: 'n8n',
    port: 5678,
    path: '/webhook/hr-policy-chat',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    },
    timeout: 120000
  };

  const n8nReq = http.request(options, (n8nRes) => {
    let raw = '';
    n8nRes.on('data', chunk => { raw += chunk; });
    n8nRes.on('end', () => {
      try {
        const parsed = JSON.parse(raw);
        // Only cache valid answerable responses
        if (n8nRes.statusCode === 200 && parsed && parsed.answerable === true && !skipCache) {
          if (policyCache.size >= MAX_CACHE_ENTRIES) {
            const firstKey = policyCache.keys().next().value;
            policyCache.delete(firstKey);
          }
          policyCache.set(cacheKey, { result: parsed, cachedAt: Date.now() });
        }
        return res.status(n8nRes.statusCode).json({
          ...parsed,
          cached: false,
          cache_key: cacheKey,
          doc_version_hash: docHash
        });
      } catch (e) {
        return res.status(n8nRes.statusCode).send(raw);
      }
    });
  });

  n8nReq.on('timeout', () => {
    n8nReq.destroy();
    if (!res.headersSent) {
      res.status(504).json({ success: false, error: 'Hết thời gian chờ phản hồi từ Trợ lý Quy định (120s).' });
    }
  });

  n8nReq.on('error', async (err) => {
    console.warn('[Policy Chat Fallback] n8n unavailable, executing direct RAG retrieval:', err.message);
    try {
      const ragRes = await ocrDocumentPipeline.queryRagWithCitations({
        query: cleanMessage,
        branch: targetBranch,
        role: verifiedRole,
        scope: finalScope,
        limit: 5
      });
      return res.status(200).json({
        answerable: ragRes.answerable,
        reply: ragRes.answerable ? (ragRes.context ? `Dựa trên quy định nội bộ SOTRANS:

${ragRes.context}` : ragRes.answer) : ragRes.answer,
        citations: ragRes.citations,
        sources: ragRes.citations.map(c => ({
          title: c.title,
          doc_number: c.doc_number,
          page: c.page,
          section_path: c.section_path,
          evidence_quote: c.evidence_quote
        })),
        cached: false,
        fallback_direct_rag: true
      });
    } catch (directErr) {
      if (!res.headersSent) {
        res.status(502).json({ success: false, error: 'Không thể kết nối tới dịch vụ Quy định & Chính sách: ' + err.message });
      }
    }
  });

  n8nReq.write(postData);
  n8nReq.end();
});


// POST /api/policy/rag-direct - Tra cứu RAG trực tiếp có trích dẫn trang & tenant isolation
router.post('/rag-direct', verifyToken, async (req, res) => {
  const { message, company_id, scope, limit = 5 } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ success: false, error: 'Vui lòng nhập nội dung câu hỏi.' });
  }

  if (req.user.role === 'USER') {
    return res.status(403).json({
      success: false,
      error: '403 Forbidden: Tra cứu Quy định & Chính sách nội bộ chỉ dành cho Nhân viên hoặc Quản trị viên doanh nghiệp.'
    });
  }

  const BRANCH_MAP = {
    'STL': 'sotrans_logistics',
    'VTX': 'vietranstimex',
    'SWC': 'sowatco'
  };

  let targetBranch = 'sotrans_logistics';
  if (req.user.role === 'ADMIN') {
    if (company_id && ['STL', 'VTX', 'SWC'].includes(String(company_id).toUpperCase())) {
      targetBranch = BRANCH_MAP[String(company_id).toUpperCase()] || 'all';
    } else {
      targetBranch = 'all';
    }
  } else {
    targetBranch = BRANCH_MAP[req.user.company_id || 'STL'] || 'sotrans_logistics';
  }

  const requestedScope = String(scope || '').toLowerCase().trim();
  const isPrivilegedTester = ['ADMIN', 'HR'].includes(req.user.role);
  let finalScope = 'production';
  if ((requestedScope === 'testing' || requestedScope === 'draft') && isPrivilegedTester) {
    finalScope = 'testing';
  }

  const verifiedRole = (req.user.role || 'EMPLOYEE').toLowerCase();

  try {
    const ragRes = await ocrDocumentPipeline.queryRagWithCitations({
      query: String(message).trim(),
      branch: targetBranch,
      role: verifiedRole,
      scope: finalScope,
      limit: parseInt(limit, 10) || 5
    });

    return res.json({
      success: true,
      answerable: ragRes.answerable,
      reply: ragRes.answerable ? (ragRes.context ? `Dựa trên quy định nội bộ SOTRANS:

${ragRes.context}` : ragRes.answer) : ragRes.answer,
      citations: ragRes.citations,
      hits_count: ragRes.hits_count,
      scope: finalScope,
      branch: targetBranch
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Lỗi tra cứu RAG: ' + err.message });
  }
});

module.exports = router;
