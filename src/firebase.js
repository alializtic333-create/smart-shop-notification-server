const admin = require('firebase-admin');
require('dotenv').config();

let initialized = false;

function initFirebase() {
  if (initialized) return admin;

  let serviceAccount;

  // 1) إذا موجود في ENV (Render / Railway)
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

  // 2) إذا ملف محلي موجود
  } else {
    try {
      serviceAccount = require('../serviceAccountKey.json');
    } catch (e) {
      throw new Error(
        'Firebase credentials missing. ضع serviceAccountKey.json داخل مجلد server أو أضف FIREBASE_SERVICE_ACCOUNT_JSON في .env'
      );
    }
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });

  initialized = true;
  return admin;
}

function getDb() {
  return initFirebase().firestore();
}

function getMessaging() {
  return initFirebase().messaging();
}

function getAuth() {
  return initFirebase().auth();
}

module.exports = { initFirebase, getDb, getMessaging, getAuth };