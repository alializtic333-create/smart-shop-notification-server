const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

let db = null;
let messaging = null;
let initialized = false;
let projectId = null;

/**
 * Parse service account JSON from Render/Railway env.
 * Supports: raw JSON, base64-encoded JSON, escaped newlines in private_key.
 */
function parseServiceAccountJson(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is empty');
  }

  let trimmed = raw.trim();

  // Strip wrapping quotes if the whole value was quoted in the dashboard
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1);
  }

  // Base64-encoded JSON (optional)
  if (!trimmed.startsWith('{')) {
    try {
      trimmed = Buffer.from(trimmed, 'base64').toString('utf8');
    } catch {
      /* not base64 — continue */
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (firstErr) {
    try {
      parsed = JSON.parse(JSON.parse(trimmed));
    } catch {
      throw new Error(
        `Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${firstErr.message}`,
      );
    }
  }

  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error(
      'Service account JSON missing project_id, client_email, or private_key',
    );
  }

  if (typeof parsed.private_key === 'string') {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }

  return parsed;
}

function loadServiceAccount() {
  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (jsonEnv) {
    return parseServiceAccountJson(jsonEnv);
  }

  const credPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(__dirname, '..', 'serviceAccountKey.json');

  if (fs.existsSync(credPath)) {
    const raw = fs.readFileSync(credPath, 'utf8');
    return parseServiceAccountJson(raw);
  }

  throw new Error(
    'Firebase credentials missing. Set FIREBASE_SERVICE_ACCOUNT_JSON on Render ' +
      'or GOOGLE_APPLICATION_CREDENTIALS / serviceAccountKey.json locally.',
  );
}

function initFirebase() {
  if (initialized) return { projectId };

  const serviceAccount = loadServiceAccount();
  projectId = serviceAccount.project_id;

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });
  }

  db = admin.firestore();
  messaging = admin.messaging();
  initialized = true;

  console.log(`Firebase Admin OK — project: ${projectId}`);
  return { projectId };
}

function getDb() {
  if (!initialized) initFirebase();
  return db;
}

function getMessaging() {
  if (!initialized) initFirebase();
  return messaging;
}

function getAuth() {
  if (!initialized) initFirebase();
  return admin.auth();
}

async function verifyFirebaseConnection() {
  initFirebase();
  await getDb().collection('users').limit(1).get();
  return { projectId, firestore: 'ok' };
}

module.exports = {
  initFirebase,
  getDb,
  getMessaging,
  getAuth,
  verifyFirebaseConnection,
};
