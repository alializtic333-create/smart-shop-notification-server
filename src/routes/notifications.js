const express = require('express');
const {
  handleNewComment,
  handleNewReply,
  handleRegisterWatcher,
  handleAdminBroadcast,
} = require('../services/notifications');

// const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// router.use(requireAuth);

function parseBody(req, fields) {
  const missing = fields.filter((f) => !req.body[f]);
  if (missing.length) {
    const err = new Error(`حقول مطلوبة: ${missing.join(', ')}`);
    err.status = 400;
    throw err;
  }
}

//
// =======================================================
// TEST ENDPOINT
// =======================================================
//
router.post('/test', async (req, res) => {
  try {
    const { getDb, getMessaging } = require('../firebase');

    const userId = req.body.userId;

    if (!userId) {
      return res.status(400).json({ error: "userId required" });
    }

    const userSnap = await getDb()
      .collection('users')
      .doc(userId)
      .get();

    if (!userSnap.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userSnap.data();
    const token = userData?.fcmToken;

    if (!token) {
      return res.status(400).json({ error: "No FCM token found for user" });
    }

    console.log("📩 Sending test notification to:", userId);

    const response = await getMessaging().send({
      token,
      notification: {
        title: "Test Notification",
        body: "الإشعار يعمل الآن"
      }
    });

    console.log("✅ FCM sent successfully:", response);

    res.json({
      ok: true,
      sentTo: userId,
      messageId: response
    });

  } catch (err) {
    console.error("❌ FCM ERROR:", err);

    res.status(500).json({
      error: err.message || 'خطأ داخلي',
      details: err.code || null
    });
  }
});

//
// =======================================================
// COMMENT
// =======================================================
//
router.post('/comment', async (req, res) => {
  try {
    parseBody(req, ['restaurantId', 'commentId']);

    const result = await handleNewComment({
      restaurantId: req.body.restaurantId,
      commentId: req.body.commentId,
      actorUserId: req.body.userId || "test-user",
    });

    res.json(result);
  } catch (err) {
    console.error("COMMENT ERROR:", err);
    res.status(err.status || 500).json({ error: err.message || 'خطأ داخلي' });
  }
});

//
// =======================================================
// REPLY
// =======================================================
//
router.post('/reply', async (req, res) => {
  try {
    parseBody(req, ['restaurantId', 'commentId', 'replyId']);

    const result = await handleNewReply({
      restaurantId: req.body.restaurantId,
      commentId: req.body.commentId,
      replyId: req.body.replyId,
      actorUserId: req.body.userId || "test-user",
    });

    res.json(result);
  } catch (err) {
    console.error("REPLY ERROR:", err);
    res.status(err.status || 500).json({ error: err.message || 'خطأ داخلي' });
  }
});

//
// =======================================================
// WATCHER
// =======================================================
//
router.post('/watcher', async (req, res) => {
  try {
    parseBody(req, ['restaurantId']);

    const result = await handleRegisterWatcher({
      restaurantId: req.body.restaurantId,
      userId: req.body.userId || "test-user",
    });

    res.json(result);
  } catch (err) {
    console.error("WATCHER ERROR:", err);
    res.status(err.status || 500).json({ error: err.message || 'خطأ داخلي' });
  }
});

//
// =======================================================
// ADMIN BROADCAST
// =======================================================
//
router.post('/admin/broadcast', async (req, res) => {
  try {
    parseBody(req, ['broadcastId']);

    const result = await handleAdminBroadcast({
      broadcastId: req.body.broadcastId,
      adminUserId: req.uid,
    });

    res.json(result);
  } catch (err) {
    console.error("BROADCAST ERROR:", err);
    res.status(err.status || 500).json({ error: err.message || 'خطأ داخلي' });
  }
});

module.exports = router;