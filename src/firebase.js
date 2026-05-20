const admin = require("firebase-admin");

function initFirebase() {
  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    serviceAccount = require("../serviceAccountKey.json");
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  return {
    getDb: () => admin.firestore(),
    getMessaging: () => admin.messaging(),
  };
}

module.exports = initFirebase();