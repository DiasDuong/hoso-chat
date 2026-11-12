/**
 * Middleware: In-Memory Sliding Window Rate Limiter
 * Provides resource throttling for Uploads, HR Chatbot, and General AI
 */

function createRateLimiter({ windowMs, maxRequests, message, keyGenerator }) {
  const store = new Map();

  // Periodic cleanup every 2 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [key, records] of store.entries()) {
      const valid = records.filter(ts => now - ts < windowMs);
      if (valid.length === 0) {
        store.delete(key);
      } else {
        store.set(key, valid);
      }
    }
  }, 120000).unref();

  return (req, res, next) => {
    const key = keyGenerator ? keyGenerator(req) : (req.user?.username || req.ip);
    const now = Date.now();

    let timestamps = store.get(key) || [];
    // Filter timestamps within current sliding window
    timestamps = timestamps.filter(ts => now - ts < windowMs);

    if (timestamps.length >= maxRequests) {
      const oldest = timestamps[0];
      const waitMs = windowMs - (now - oldest);
      const waitSec = Math.max(1, Math.ceil(waitMs / 1000));

      res.setHeader('Retry-After', waitSec);
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', 0);

      return res.status(429).json({
        success: false,
        error: message || `429 Too Many Requests: Bạn đã gửi quá nhiều yêu cầu trong thời gian ngắn. Vui lòng chờ ${waitSec} giây trước khi thử lại.`,
        retryAfter: waitSec
      });
    }

    timestamps.push(now);
    store.set(key, timestamps);

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - timestamps.length));

    next();
  };
}

// 1. Upload Limiter: Max 10 upload requests per 5 minutes per user/IP
const uploadRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: 10,
  message: '429 Too Many Requests: Bạn đã vượt quá giới hạn tải lên hồ sơ (tối đa 10 lượt / 5 phút). Vui lòng đợi trong giây lát.',
  keyGenerator: (req) => `upload:${req.user?.username || req.ip}`
});

// 2. HR Chatbot Limiter: Max 120 questions per 1 minute per user
const chatRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 120,
  message: '429 Too Many Requests: Bạn đã gửi tin nhắn quá nhanh. Vui lòng đợi vài giây trước khi gửi tiếp.',
  keyGenerator: (req) => `hoso_chat:${req.user?.username || req.ip}`
});

// 3. General AI Limiter: Max 60 requests per 1 minute per user/IP
const generalAiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: '429 Too Many Requests: Giới hạn gọi mô hình AI tổng quát là 60 lượt / phút. Vui lòng đợi trước khi thử lại.',
  keyGenerator: (req) => `general_ai:${req.user?.username || req.ip}`
});

module.exports = {
  createRateLimiter,
  uploadRateLimiter,
  chatRateLimiter,
  generalAiRateLimiter
};
