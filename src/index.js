require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { initFirebase } = require('./firebase');
const { optionalApiSecret } = require('./middleware/auth');
const notificationsRouter = require('./routes/notifications');

const app = express(); // 🔥 هذا هو الناقص عندك

const port = Number(process.env.PORT) || 3000;

console.log("STEP 1 - before firebase init");

initFirebase();

console.log("STEP 2 - after firebase init");

app.use(helmet());

app.use(cors({
  origin: '*'
}));

app.use(express.json({ limit: '32kb' }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/notifications', optionalApiSecret, notificationsRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'server error' });
});

app.listen(port, () => {
  console.log(`Notification API listening on port ${port}`);
});