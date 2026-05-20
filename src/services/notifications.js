const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getDb, getMessaging } = require('../firebase');

/**
 * نافذة الاهتمام: sliding window — تُمدَّد 6 ساعات من آخر تفاعل
 * (تعليق / تقييم / مفضلة / رد) وليست ثابتة من أول تفاعل.
 *
 * المستخدم المهتم = من لديه سجل نشط في restaurant_comment_watchers
 * حيث expiresAt > now (أي lastInteractionAt ضمن 6 ساعات).
 * لا يُستخدم union تاريخي لكل التعليقات/المفضلة القديمة.
 */
const WATCH_HOURS = 6;
const DELIVERY_BATCH_SIZE = 20;
const TEXT_PREVIEW_MAX = 72;
const BROADCAST_FCM_MAX_RETRIES = 2;
const NON_RETRYABLE_FCM_REASONS = new Set([
  'no_token',
  'no_user',
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFcmReason(reason) {
  const r = (reason || '').toString();
  if (NON_RETRYABLE_FCM_REASONS.has(r)) return false;
  return (
    r === 'fcm_error' ||
    r === 'messaging/unavailable' ||
    r === 'messaging/internal-error' ||
    r === 'messaging/server-unavailable'
  );
}

function watcherDocId(userId, restaurantId) {
  return `${userId}_${restaurantId}`;
}

function expiresInHours(hours) {
  return Timestamp.fromDate(new Date(Date.now() + hours * 60 * 60 * 1000));
}

function truncateText(text, max = TEXT_PREVIEW_MAX) {
  const t = (text || '').toString().trim().replace(/\s+/g, ' ');
  if (!t) return '';
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

async function getRestaurantName(restaurantId) {
  const snap = await getDb().collection('restaurants').doc(restaurantId).get();
  if (!snap.exists) return 'مطعم';
  return (snap.data().name || 'مطعم').toString().trim() || 'مطعم';
}

/** منع تكرار إشعار نفس الحدث لنفس المستخدم (دائم لكل حدث) */
async function isDuplicate(dedupeKey) {
  if (!dedupeKey) return false;
  const snap = await getDb().collection('notification_dedupe').doc(dedupeKey).get();
  return snap.exists;
}

async function markDedupe(dedupeKey) {
  if (!dedupeKey) return;
  await getDb().collection('notification_dedupe').doc(dedupeKey).set({
    createdAt: FieldValue.serverTimestamp(),
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
    await getDb().collection('users').doc(userId).set(
      {
        fcmToken: FieldValue.delete(),
        fcmTokenUpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
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
      await clearInvalidToken(userId);
    }
    const reason = code || 'fcm_error';
    console.error('[FCM] failed', { toUserId, reason, message: err.message });
    return { sent: false, reason };
  }
}

async function logDeliveryFailure({
  toUserId,
  type,
  relatedId = '',
  reason = 'unknown',
  attempt = 1,
  broadcastId = '',
}) {
  try {
    await getDb().collection('notification_delivery_logs').add({
      toUserId,
      type,
      relatedId,
      broadcastId,
      reason: reason.toString(),
      attempt,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[FCM] log failure error', err.message);
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
  replyId = '',
  relatedId = '',
  restaurantName = '',
  previewText = '',
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
    replyId,
    relatedId: relatedId || commentId || replyId || restaurantId,
    restaurantName,
    previewText,
  };

  await saveInboxItem(toUserId, payload);
  await markDedupe(dedupeKey);

  const fcmPayload = {
    type,
    restaurantId,
    commentId,
    replyId,
    relatedId: payload.relatedId,
    title,
    body,
    click_action: 'FLUTTER_NOTIFICATION_CLICK',
  };

  const fcm = await sendFcm(toUserId, { title, body, data: fcmPayload });

  if (!fcm.sent) {
    await logDeliveryFailure({
      toUserId,
      type,
      relatedId: payload.relatedId,
      reason: fcm.reason,
      attempt: 1,
    });
  }

  return { skipped: false, fcm, toUserId, title, body, fcmPayload };
}

async function upsertWatcher(userId, restaurantId, source = 'interaction') {
  if (!userId || !restaurantId) return;
  const ref = getDb()
    .collection('restaurant_comment_watchers')
    .doc(watcherDocId(userId, restaurantId));

  const existing = await ref.get();
  const now = FieldValue.serverTimestamp();
  const data = {
    userId,
    restaurantId,
    /** sliding window: يُعاد ضبطه عند كل تفاعل */
    lastInteractionAt: now,
    expiresAt: expiresInHours(WATCH_HOURS),
    updatedAt: now,
    lastSource: source,
  };
  if (!existing.exists) {
    data.createdAt = now;
  }
  await ref.set(data, { merge: true });
}

/**
 * مستخدمون نشطون مهتمون بالمطعم (تعليق/تقييم/مفضلة خلال آخر 6 ساعات).
 */
async function getActiveInterestedUserIds(restaurantId) {
  const now = Timestamp.now();
  const snap = await getDb()
    .collection('restaurant_comment_watchers')
    .where('restaurantId', '==', restaurantId)
    .where('expiresAt', '>', now)
    .get();

  const ids = new Set();
  for (const doc of snap.docs) {
    const uid = (doc.data().userId || '').toString();
    if (uid) ids.add(uid);
  }
  return ids;
}

async function notifyInterestedUsersOnNewComment({
  restaurantId,
  actorUserId,
  actorName,
  commentId,
  commentText,
  restaurantName,
}) {
  const interested = await getActiveInterestedUserIds(restaurantId);
  interested.delete(actorUserId);

  const preview = truncateText(commentText);
  const body = preview
    ? `${actorName}: «${preview}» — ${restaurantName}`
    : `${actorName} علّق على ${restaurantName}`;

  const tasks = [];
  for (const watcherUserId of interested) {
    const dedupeKey = `comment_${restaurantId}_${commentId}_${watcherUserId}`;
    tasks.push(() =>
      deliverNotification({
        toUserId: watcherUserId,
        fromUserId: actorUserId,
        title: `تعليق جديد في ${restaurantName}`,
        body,
        type: 'comment',
        restaurantId,
        commentId,
        relatedId: commentId,
        restaurantName,
        previewText: preview,
        dedupeKey,
      }),
    );
  }

  for (let i = 0; i < tasks.length; i += DELIVERY_BATCH_SIZE) {
    const chunk = tasks.slice(i, i + DELIVERY_BATCH_SIZE);
    await Promise.all(chunk.map((fn) => fn()));
  }
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
  const commentText = (data.text || '').toString();
  const restaurantName = await getRestaurantName(restaurantId);

  await upsertWatcher(actorUserId, restaurantId, 'comment');

  const result = await notifyInterestedUsersOnNewComment({
    restaurantId,
    actorUserId,
    actorName,
    commentId,
    commentText,
    restaurantName,
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
  const replyText = (reply.text || '').toString();

  await upsertWatcher(actorUserId, restaurantId, 'reply');

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

  const restaurantName = await getRestaurantName(restaurantId);
  const preview = truncateText(replyText);
  const body = preview
    ? `${replierName}: «${preview}» — ${restaurantName}`
    : `${replierName} رد على تعليقك في ${restaurantName}`;

  const delivery = await deliverNotification({
    toUserId: ownerId,
    fromUserId: replierId,
    title: `${replierName} رد على تعليقك`,
    body,
    type: 'reply',
    restaurantId,
    commentId,
    replyId,
    relatedId: commentId,
    restaurantName,
    previewText: preview,
    dedupeKey: `reply_${commentId}_${replyId}_${ownerId}`,
  });

  return { ok: true, delivery };
}

async function handleRegisterWatcher({ restaurantId, userId, source = 'interaction' }) {
  await upsertWatcher(userId, restaurantId, source);
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
  const docs = usersSnap.docs.filter((d) => d.id !== createdBy);

  let sent = 0;
  let skipped = 0;
  const pendingRetries = [];

  const tasks = docs.map((userDoc) => () =>
    deliverNotification({
      toUserId: userDoc.id,
      fromUserId: createdBy,
      title,
      body,
      type: 'broadcast',
      relatedId: broadcastId,
      previewText: truncateText(body, 120),
      dedupeKey: `broadcast_${broadcastId}_${userDoc.id}`,
    }),
  );

  for (let i = 0; i < tasks.length; i += DELIVERY_BATCH_SIZE) {
    const chunk = tasks.slice(i, i + DELIVERY_BATCH_SIZE);
    const results = await Promise.all(chunk.map((fn) => fn()));
    for (const r of results) {
      if (r?.skipped) {
        skipped += 1;
        continue;
      }
      if (r?.fcm?.sent) {
        sent += 1;
      } else if (isRetryableFcmReason(r?.fcm?.reason)) {
        pendingRetries.push(r);
      } else {
        await logDeliveryFailure({
          toUserId: r.toUserId,
          type: 'broadcast',
          relatedId: broadcastId,
          broadcastId,
          reason: r?.fcm?.reason || 'not_retryable',
          attempt: 1,
        });
      }
    }
  }

  let stillPending = pendingRetries;
  for (let attempt = 1; attempt <= BROADCAST_FCM_MAX_RETRIES && stillPending.length; attempt++) {
    await sleep(1000 * attempt);
    const nextPending = [];
    for (let i = 0; i < stillPending.length; i += DELIVERY_BATCH_SIZE) {
      const chunk = stillPending.slice(i, i + DELIVERY_BATCH_SIZE);
      const retryResults = await Promise.all(
        chunk.map((item) =>
          sendFcm(item.toUserId, {
            title: item.title,
            body: item.body,
            data: item.fcmPayload,
          }),
        ),
      );
      for (let j = 0; j < chunk.length; j++) {
        const item = chunk[j];
        const fcm = retryResults[j];
        if (fcm.sent) {
          sent += 1;
        } else if (attempt < BROADCAST_FCM_MAX_RETRIES && isRetryableFcmReason(fcm.reason)) {
          nextPending.push(item);
        } else {
          await logDeliveryFailure({
            toUserId: item.toUserId,
            type: 'broadcast',
            relatedId: broadcastId,
            broadcastId,
            reason: fcm.reason,
            attempt: attempt + 1,
          });
        }
      }
    }
    stillPending = nextPending;
  }

  await ref.update({
    processedAt: FieldValue.serverTimestamp(),
    recipientCount: docs.length,
    sentCount: sent,
    skippedCount: skipped,
    failedCount: docs.length - sent - skipped,
  });

  return {
    ok: true,
    recipientCount: docs.length,
    sent,
    skipped,
    failed: docs.length - sent - skipped,
  };
}

module.exports = {
  upsertWatcher,
  handleNewComment,
  handleNewReply,
  handleRegisterWatcher,
  handleAdminBroadcast,
};
