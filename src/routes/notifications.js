const express = require('express');
const { getDb, getMessaging } = require('../firebase');
const {
  handleNewComment,
  handleNewReply,
  handleRegisterWatcher,
  handleAdminBroadcast,
} = require('../services/notifications');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function parseBody(req, fields) {
  const missing = fields.filter((f) => !req.body[f]);
  if (missing.length) {
    const err = new Error(`حقول مطلوبة: ${missing.join(', ')}`);
    err.status = 400;
    throw err;
  }
}

/**
 * اختبار FCM — لا يتطلب Firebase Auth.
 * على الإنتاج: عيّن API_SECRET ومرّر X-API-Key في الهيدر.
 * Body: { "userId": "firebase_uid" }
 */
router.post('/test', async (req, res) => {
  try {
    const userId = (req.body.userId || '').toString().trim();
    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }

    const userSnap = await getDb().collection('users').doc(userId).get();

    if (!userSnap.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const token = (userSnap.data().fcmToken || '').toString().trim();
    if (!token) {
      return res.status(400).json({ error: 'No FCM token found for user' });
    }

    const messageId = await getMessaging().send({
      token,
      notification: {
        title: 'Test Notification',
        body: 'الإشعار يعمل الآن',
      },
      data: {
        type: 'test',
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'khuth_alsafi_main',
          sound: 'default',
        },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
      },
    });

    res.json({ ok: true, sentTo: userId, messageId });
  } catch (err) {
    console.error('FCM test error:', err.code || err.message, err);
    res.status(500).json({
      error: err.message || 'خطأ داخلي',
      code: err.code || err.errorInfo?.code || null,
    });
  }
});

router.use(requireAuth);

router.post('/comment', async (req, res) => {
  try {
    parseBody(req, ['restaurantId', 'commentId']);
    const result = await handleNewComment({
      restaurantId: req.body.restaurantId,
      commentId: req.body.commentId,
      actorUserId: req.uid,
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
      actorUserId: req.uid,
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
      userId: req.uid,
      source: (req.body.source || 'interaction').toString(),
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
