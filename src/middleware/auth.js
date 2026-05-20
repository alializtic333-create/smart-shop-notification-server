const { getAuth } = require('../firebase');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'مطلوب تسجيل الدخول (Bearer token)' });
  }

  try {
    const decoded = await getAuth().verifyIdToken(match[1]);
    req.uid = decoded.uid;
    return next();
  } catch (err) {
    console.error('Auth verify failed:', err.message);
    return res.status(401).json({ error: 'رمز الدخول غير صالح أو منتهي' });
  }
}

function optionalApiSecret(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) return next();

  const key = req.headers['x-api-key'];
  if (key !== secret) {
    return res.status(403).json({ error: 'مفتاح API غير صالح' });
  }
  return next();
}

module.exports = { requireAuth, optionalApiSecret };
