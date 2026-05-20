# خادم الإشعارات — Khuth Alsafi Notification API

بديل **Firebase Cloud Functions** (لا يحتاج Blaze Plan). يستخدم **Firebase Admin SDK** لإرسال FCM HTTP v1 وكتابة Firestore.

## المتطلبات

- Node.js 20+
- مشروع Firebase (Spark مجاني كافٍ لـ FCM + Firestore)
- ملف **Service Account** من: Firebase Console → Project Settings → Service accounts → Generate new private key

## التشغيل المحلي

```bash
cd server
npm install
cp .env.example .env
# ضع serviceAccountKey.json في مجلد server وحدّث .env
npm run dev
```

تحقق: `GET http://localhost:3000/health`

## النشر على Render (مجاني)

1. أنشئ **Web Service** من مستودع Git، Root Directory: `server`
2. Build: `npm install`
3. Start: `npm start`
4. Environment Variables:
   - `FIREBASE_SERVICE_ACCOUNT_JSON` — انظر **إعداد Credentials** أدناه
   - `NODE_ENV` = `production`
   - `ALLOWED_ORIGINS` = `*`
   - `API_SECRET` = مفتاح عشوائي (مطلوب لحماية `/test` على الإنتاج)

5. انسخ رابط الخدمة، مثلاً `https://khuth-api.onrender.com`

### إعداد Credentials على Render (مهم)

1. Firebase Console → Project Settings → **Service accounts** → **Generate new private key**
2. على جهازك (PowerShell):

```powershell
cd server
node -e "const j=require('fs').readFileSync('serviceAccountKey.json','utf8'); console.log(JSON.stringify(JSON.parse(j)))"
```

3. انسخ **السطر الواحد** بالكامل إلى متغير `FIREBASE_SERVICE_ACCOUNT_JSON` في Render
4. **لا** تضف علامات اقتباس خارجية إضافية حول JSON في لوحة Render
5. تأكد أن الحساب له دور **Firebase Admin SDK Administrator Service Agent** (افتراضي عند إنشاء المفتاح)

**تحقق بعد النشر:**

```http
GET https://your-api.onrender.com/health
```

يجب أن يعود: `{ "ok": true, "firebase": { "projectId": "...", "firestore": "ok" } }`

**اختبار إشعار:**

```http
POST https://your-api.onrender.com/api/notifications/test
X-API-Key: YOUR_API_SECRET
Content-Type: application/json

{ "userId": "FIREBASE_UID_WITH_fcmToken" }
```

## النشر على Railway

نفس المتغيرات؛ Start Command: `npm start`.

## واجهات API

كل الطلبات تتطلب:

```
Authorization: Bearer <Firebase ID Token>
Content-Type: application/json
```

| Method | Path | الوصف |
|--------|------|--------|
| GET | `/health` | فحص الخادم + اتصال Firestore |
| POST | `/api/notifications/test` | اختبار FCM (يتطلب `X-API-Key` إن وُجد `API_SECRET`) |
| POST | `/api/notifications/comment` | تعليق جديد + إشعار المتابعين (4 ساعات) |
| POST | `/api/notifications/reply` | رد على تعليق |
| POST | `/api/notifications/watcher` | تسجيل متابعة مطعم (تقييم/تفاعل) |
| POST | `/api/notifications/admin/broadcast` | معالجة بث إداري |

### أمثلة

```json
POST /api/notifications/comment
{ "restaurantId": "abc", "commentId": "xyz" }

POST /api/notifications/reply
{ "restaurantId": "abc", "commentId": "xyz", "replyId": "r1" }

POST /api/notifications/watcher
{ "restaurantId": "abc" }

POST /api/notifications/admin/broadcast
{ "broadcastId": "broadcastDocId" }
```

## الأمان

- التحقق من **Firebase ID Token** على كل طلب
- التحقق من ملكية التعليق/الرد من Firestore
- البث الإداري يتطلب `users/{uid}.role == admin`
- منع التكرار عبر `notification_dedupe`
- حذف `fcmToken` غير الصالح تلقائياً

## ربط تطبيق Flutter

```bash
flutter run --dart-define=NOTIFICATION_API_URL=https://your-api.onrender.com
```

للمحاكي أندرويد (السيرفر على نفس الجهاز):

```bash
flutter run --dart-define=NOTIFICATION_API_URL=http://10.0.2.2:3000
```

لجهاز حقيقي على نفس الشبكة:

```bash
flutter run --dart-define=NOTIFICATION_API_URL=http://192.168.1.10:3000
```

إن استخدمت `API_SECRET` على السيرفر:

```bash
flutter run --dart-define=NOTIFICATION_API_SECRET=your-secret
```
