const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const companyRoutes = require('./routes/companies');
const userRoutes = require('./routes/users');
const auditRoutes = require('./routes/audit');
const conversationRoutes = require('./routes/conversations');
const generalAiRoutes = require('./routes/general_ai');
const policyRoutes = require('./routes/policy');
const employeeRoutes = require('./routes/employees');
const hosoRoutes = require('./routes/hoso');
const documentRoutes = require('./routes/documents');
const agentFilesRoutes = require('./routes/agent_files');
const chatFilesRoutes = require('./routes/chat_files');
const agentRoutes = require('./routes/agents');
const oneDriveRoutes = require('./routes/onedrive');
const { router: intakeRoutes } = require('./routes/intake');
require('./services/retentionService');
const { startPeriodicReconciliation } = require('./services/qdrantSyncService');
const { startSyncWorker } = require('./services/oneDriveSyncWorker');
const crypto = require('crypto');
const { sendError } = require('./services/errorCatalog');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Correlation ID Middleware
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'hr-auth-service', timestamp: new Date() });
});

// Mount Routes
app.use('/api/auth', authRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/users', userRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/general', generalAiRoutes);
app.use('/api/policy', policyRoutes);
app.use('/api/hoso/intake', intakeRoutes);
app.use('/api/hoso', hosoRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/chat-files', chatFilesRoutes);
app.use('/api/agents/files', agentFilesRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/onedrive', oneDriveRoutes);

// Global Error Handler
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return sendError(res, 'INTERNAL_ERROR', { status: 400, user_message: 'Dữ liệu JSON gửi lên không hợp lệ.' }, req);
  }
  if (err.code === 'LIMIT_FILE_SIZE' || (err.message && err.message.includes('File too large'))) {
    return sendError(res, 'FILE_TOO_LARGE', {}, req);
  }
  console.error('[Unhandled error]:', err.message);
  return sendError(res, 'INTERNAL_ERROR', { details: err.message }, req);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 HR Auth Service running on port ${PORT}`);
  startPeriodicReconciliation(60);
  startSyncWorker();
});
