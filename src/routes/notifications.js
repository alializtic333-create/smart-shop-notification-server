const express = require('express');
const {
  handleNewComment,
  handleNewReply,
  handleRegisterWatcher,
  handleAdminBroadcast,
} = require('../services/notifications');

// ملاحظة: تم تعطيل auth للاختبار فقط
// const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// router.use(requireAuth); // تعطيل مؤقت للاختبار

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
// TEST ENDPOINT (مهم جداً للاختبار)
// =======================================================
//
router.post('/test', async (req, res) => {
  try {
    const { getDb, getMessaging } = require('../firebase');

    const userId = req.body.userId;

    if (!userId) {
      return res.status(400).json({ error: "userId required" });
    }

    const user = await getDb().collection('users').doc(userId).get();
    const token = user.data()?.fcmToken;

    if (!token) {
      return res.status(400).json({ error: "No FCM token found for user" });
    }

    await getMessaging().send({
      token,
      notification: {
        title: "Test Notification",
        body: "الإشعار يعمل الآن"
      }
    });

    res.json({ ok: true, sentTo: userId });

  } catch (err) {
    res.status(500).json({ error: err.message || 'خطأ داخلي' });
  }
});

//
// =======================================================
// EXISTING ROUTES
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
    res.status(err.status || 500).json({ error: err.message || 'خطأ داخلي' });
  }
});

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
    res.status(err.status || 500).json({ error: err.message || 'خطأ داخلي' });
  }
});

router.post('/watcher', async (req, res) => {
  try {
    parseBody(req, ['restaurantId']);

    const result = await handleRegisterWatcher({
      restaurantId: req.body.restaurantId,
      userId: req.body.userId || "test-user",
    });

    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'خطأ داخلي' });
  }
});

router.post('/admin/broadcast', async (req, res) => {
  try {
    parseBody(req, ['broadcastId']);

    const result = await handleAdminBroadcast({
      broadcastId: req.body.broadcastId,
      adminUserId: req.uid,
    });

    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'خطأ داخلي' });
  }
});

module.exports = router;