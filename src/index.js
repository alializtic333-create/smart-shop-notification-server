require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { initFirebase, verifyFirebaseConnection } = require('./firebase');
const { optionalApiSecret } = require('./middleware/auth');
const notificationsRouter = require('./routes/notifications');

const port = Number(process.env.PORT) || 3000;

try {
  initFirebase();
} catch (err) {
  console.error('FATAL: Firebase initialization failed:', err.message);
  process.exit(1);
}

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (
        !origin ||
        allowedOrigins.includes('*') ||
        allowedOrigins.includes(origin)
      ) {
        callback(null, true);
      } else {
        callback(new Error('CORS not allowed'));
      }
    },
  }),
);
app.use(express.json({ limit: '32kb' }));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.get('/health', async (_req, res) => {
  try {
    const fb = await verifyFirebaseConnection();
    res.json({ ok: true, service: 'khuth-alsafi-notifications', firebase: fb });
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(503).json({
      ok: false,
      error: err.message,
      code: err.code || null,
    });
  }
});

app.use('/api/notifications', optionalApiSecret, notificationsRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'خطأ في الخادم' });
});

app.listen(port, () => {
  console.log(`Notification API listening on port ${port}`);
});
