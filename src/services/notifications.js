const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getDb, getMessaging } = require('../firebase');

const WATCH_HOURS = 4;
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

function watcherDocId(userId, restaurantId) {
  return `${userId}_${restaurantId}`;
}

function expiresInHours(hours) {
  return Timestamp.fromDate(new Date(Date.now() + hours * 60 * 60 * 1000));
}

async function isDuplicate(dedupeKey) {
  if (!dedupeKey) return false;
  const ref = getDb().collection('notification_dedupe').doc(dedupeKey);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const createdAt = snap.data().createdAt;
  if (!createdAt) return false;
  const age = Date.now() - createdAt.toMillis();
  return age < DEDUPE_WINDOW_MS;
}

async function markDedupe(dedupeKey) {
  if (!dedupeKey) return;
  await getDb().collection('notification_dedupe').doc(dedupeKey).set({
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)),
  });
}

async function saveInboxItem(toUserId, payload) {
  await getDb()
    .collection('notifications')
    .doc(toUserId)
    .collection('items')
    .add({
      ...payload,
      isRead: false,
      createdAt: FieldValue.serverTimestamp(),
    });
}

async function clearInvalidToken(userId) {
  try {
    await getDb().collection('users').doc(userId).update({
      fcmToken: FieldValue.delete(),
      fcmTokenUpdatedAt: FieldValue.serverTimestamp(),
    });
  } catch (_) {
    /* ignore */
  }
}

async function sendFcm(toUserId, { title, body, data }) {
  const userSnap = await getDb().collection('users').doc(toUserId).get();
  if (!userSnap.exists) return { sent: false, reason: 'no_user' };

  const token = (userSnap.data().fcmToken || '').toString().trim();
  if (!token) return { sent: false, reason: 'no_token' };

  try {
    await getMessaging().send({
      token,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data || {}).map(([k, v]) => [k, String(v ?? '')]),
      ),
      android: {
        priority: 'high',
        notification: {
          channelId: 'khuth_alsafi_main',
          sound: 'default',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    });
    return { sent: true };
  } catch (err) {
    const code = err.code || err.errorInfo?.code || '';
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/invalid-argument'
    ) {
      await clearInvalidToken(toUserId);
    }
    console.error('FCM send failed', toUserId, code, err.message);
    return { sent: false, reason: code || 'fcm_error' };
  }
}

async function deliverNotification({
  toUserId,
  fromUserId,
  title,
  body,
  type,
  restaurantId = '',
  commentId = '',
  dedupeKey = '',
}) {
  if (!toUserId || toUserId === fromUserId) {
    return { skipped: true, reason: 'self_or_empty' };
  }

  if (await isDuplicate(dedupeKey)) {
    return { skipped: true, reason: 'duplicate' };
  }

  const payload = {
    toUserId,
    fromUserId: fromUserId || '',
    title,
    body,
    type,
    restaurantId,
    commentId,
  };

  await saveInboxItem(toUserId, payload);
  await markDedupe(dedupeKey);

  const fcm = await sendFcm(toUserId, {
    title,
    body,
    data: {
      type,
      restaurantId,
      commentId,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
  });

  return { skipped: false, fcm };
}

async function upsertWatcher(userId, restaurantId) {
  if (!userId || !restaurantId) return;
  const ref = getDb()
    .collection('restaurant_comment_watchers')
    .doc(watcherDocId(userId, restaurantId));

  const existing = await ref.get();
  const data = {
    userId,
    restaurantId,
    expiresAt: expiresInHours(WATCH_HOURS),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (!existing.exists) {
    data.createdAt = FieldValue.serverTimestamp();
  }
  await ref.set(data, { merge: true });
}

async function notifyActiveWatchers({
  restaurantId,
  actorUserId,
  actorName,
  commentId,
  excludeUserIds = [],
}) {
  const now = Timestamp.now();
  const snap = await getDb()
    .collection('restaurant_comment_watchers')
    .where('restaurantId', '==', restaurantId)
    .where('expiresAt', '>', now)
    .get();

  const excluded = new Set([actorUserId, ...excludeUserIds]);
  const tasks = [];

  for (const doc of snap.docs) {
    const watcherUserId = doc.data().userId;
    if (!watcherUserId || excluded.has(watcherUserId)) continue;

    const dedupeKey = `new_comment_${restaurantId}_${commentId}_${watcherUserId}`;
    tasks.push(
      deliverNotification({
        toUserId: watcherUserId,
        fromUserId: actorUserId,
        title: 'تعليق جديد على مطعم تتابعه',
        body: `${actorName} علّق على مطعم تفاعلت معه مؤخراً`,
        type: 'new_comment',
        restaurantId,
        commentId,
        dedupeKey,
      }),
    );
  }

  await Promise.all(tasks);
  return { notified: tasks.length };
}

async function handleNewComment({ restaurantId, commentId, actorUserId }) {
  const commentSnap = await getDb()
    .collection('restaurants')
    .doc(restaurantId)
    .collection('comments')
    .doc(commentId)
    .get();

  if (!commentSnap.exists) {
    const err = new Error('التعليق غير موجود');
    err.status = 404;
    throw err;
  }

  const data = commentSnap.data();
  if (data.isDeleted === true) {
    const err = new Error('التعليق محذوف');
    err.status = 400;
    throw err;
  }

  const ownerId = (data.userId || '').toString();
  if (ownerId !== actorUserId) {
    const err = new Error('غير مصرح');
    err.status = 403;
    throw err;
  }

  const actorName = (data.userName || 'مستخدم').toString();

  await upsertWatcher(actorUserId, restaurantId);
  const result = await notifyActiveWatchers({
    restaurantId,
    actorUserId,
    actorName,
    commentId,
  });

  return { ok: true, watchersNotified: result.notified };
}

async function handleNewReply({ restaurantId, commentId, replyId, actorUserId }) {
  const replySnap = await getDb()
    .collection('restaurants')
    .doc(restaurantId)
    .collection('comments')
    .doc(commentId)
    .collection('replies')
    .doc(replyId)
    .get();

  if (!replySnap.exists) {
    const err = new Error('الرد غير موجود');
    err.status = 404;
    throw err;
  }

  const reply = replySnap.data();
  const replierId = (reply.userId || '').toString();
  if (replierId !== actorUserId) {
    const err = new Error('غير مصرح');
    err.status = 403;
    throw err;
  }

  const replierName = (reply.userName || 'مستخدم').toString();

  await upsertWatcher(actorUserId, restaurantId);

  const commentSnap = await getDb()
    .collection('restaurants')
    .doc(restaurantId)
    .collection('comments')
    .doc(commentId)
    .get();

  if (!commentSnap.exists) {
    const err = new Error('التعليق الأصلي غير موجود');
    err.status = 404;
    throw err;
  }

  const ownerId = (commentSnap.data().userId || '').toString();
  if (!ownerId) {
    return { ok: true, skipped: true, reason: 'no_owner' };
  }

  const delivery = await deliverNotification({
    toUserId: ownerId,
    fromUserId: replierId,
    title: 'رد جديد على تعليقك',
    body: `${replierName} رد على تعليقك`,
    type: 'reply',
    restaurantId,
    commentId,
    dedupeKey: `reply_${commentId}_${replyId}_${ownerId}`,
  });

  return { ok: true, delivery };
}

async function handleRegisterWatcher({ restaurantId, userId }) {
  await upsertWatcher(userId, restaurantId);
  return { ok: true };
}

async function assertAdmin(userId) {
  const snap = await getDb().collection('users').doc(userId).get();
  if (!snap.exists || snap.data().role !== 'admin') {
    const err = new Error('صلاحيات المشرف مطلوبة');
    err.status = 403;
    throw err;
  }
}

async function handleAdminBroadcast({ broadcastId, adminUserId }) {
  await assertAdmin(adminUserId);

  const ref = getDb().collection('admin_broadcasts').doc(broadcastId);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error('البث غير موجود');
    err.status = 404;
    throw err;
  }

  const data = snap.data();
  if (data.processedAt) {
    return { ok: true, alreadyProcessed: true };
  }

  const title = (data.title || 'إشعار من خذ الصافي').toString();
  const body = (data.body || '').toString();
  const createdBy = (data.createdBy || '').toString();

  if (createdBy !== adminUserId) {
    const err = new Error('غير مصرح');
    err.status = 403;
    throw err;
  }

  const usersSnap = await getDb().collection('users').get();
  const batchSize = 20;
  const docs = usersSnap.docs;
  let sent = 0;
  let skipped = 0;

  for (let i = 0; i < docs.length; i += batchSize) {
    const chunk = docs.slice(i, i + batchSize);
    const results = await Promise.all(
      chunk.map((userDoc) => {
        const uid = userDoc.id;
        if (uid === createdBy) return { skipped: true };
        return deliverNotification({
          toUserId: uid,
          fromUserId: createdBy,
          title,
          body,
          type: 'admin',
          dedupeKey: `admin_${broadcastId}_${uid}`,
        });
      }),
    );
    for (const r of results) {
      if (r?.skipped) skipped += 1;
      else sent += 1;
    }
  }

  await ref.update({
    processedAt: FieldValue.serverTimestamp(),
    recipientCount: docs.length,
    sentCount: sent,
  });

  return { ok: true, recipientCount: docs.length, sent, skipped };
}

module.exports = {
  upsertWatcher,
  handleNewComment,
  handleNewReply,
  handleRegisterWatcher,
  handleAdminBroadcast,
};
