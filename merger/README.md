# Video Merger API v2

خدمة دمج فيديوهات كاملة وجاهزة للنشر على Vercel — بدون تسجيل دخول، بدون خطوة بناء، بدون Next.js:
واجهة ثابتة واحدة (`public/index.html`) + دوال Serverless Node.js خالصة (CommonJS) + تخزين كامل في **Turso (libSQL)** + معالجة فيديو عبر **ffmpeg**.

## المزايا

- دمج حتى 10 مصادر: روابط تنزيل مباشرة و/أو ملفات مرفوعة من الجهاز (أجزاء 4MB مع إعادة محاولة تلقائية).
- توحيد تلقائي لكل المصادر: أكبر دقة بين المدخلات (بحد أقصى 1920×1080 وأبعاد زوجية)، `fps=30`، `setsar=1`، `yuv420p`.
- مصدر بلا صوت يُعوَّض بمسار صامت `anullsrc` بنفس مدته بدل أن يفشل الدمج.
- ترميز نهائي عالي الجودة: `libx264` CRF 18 + `AAC 192k/44100Hz` + `+faststart` (MP4 جاهز للبث).
- بث الناتج مع دعم `Range` (تقديم/ترجيع في المشغل) + تحميل مباشر عبر `?download=1`.
- كل شيء مخزَّن في Turso كصفوف BLOB بحجم 2MB (حد HTTP) وتُقرأ بصفحات من 8 صفوف — لا S3 ولا ملفات دائمة.
- حذف تلقائي بعد 24 ساعة: تنظيف كسول عند كل إنشاء/دمج + نقطة cron يومية + حذف فوري عند الطلب.
- واجهة عربية RTL بثيم داكن، مع تقدم حقيقي من الخادم، استئناف عرض عبر `#job=<id>`، وتوثيق API داخل الصفحة.

## هيكل المشروع

```
merger/
├── api/
│   ├── jobs.js            POST   /api/jobs              إنشاء مهمة
│   ├── jobs/[id].js       GET|DELETE /api/jobs/<id>     الحالة / الحذف الشامل
│   ├── jobs/[id]/process.js POST /api/jobs/<id>/process  تنفيذ الدمج (متزامن)
│   ├── jobs/[id]/video.js GET    /api/jobs/<id>/video   بث الناتج (Range + download)
│   ├── upload.js          POST   /api/upload            رفع أجزاء الملفات
│   ├── config.js          GET    /api/config            الحدود + الإصدار
│   └── cron.js            GET    /api/cron              حذف المهام المنتهية
├── lib/
│   ├── db.js              Turso + ensureSchema + عمليات المهام
│   ├── storage.js         تقسيم Blobs 2MB + قراءة صفحات 8 صفوف + Range stream
│   ├── merge.js           محرك ffmpeg (توحيد + concat + تقدم)
│   ├── cleanup.js         حذف المنتهية + حذف شامل
│   └── util.js            ردود JSON/CORS + الحدود + .env + الثنائيات
├── public/index.html      الواجهة (HTML+CSS+JS في ملف واحد)
├── scripts/
│   ├── test-unit.js       اختبارات وحدة (ffmpeg محلي + Turso)
│   └── test-http.js       اختبارات HTTP ضد 127.0.0.1:3010
├── dev-server.js          خادم تطوير يحاكي Vercel على المنفذ 3010
├── vercel.json            maxDuration=300 + cron يومي 03:00 UTC
├── package.json
├── .env                   (محلي فقط — لا يُرفع أبدًا)
└── .env.example           قالب المتغيرات بقيم placeholder
```

## التشغيل محليًا

```bash
cd merger
npm install            # أو bun install
cp .env.example .env   # ثم ضع قيم Turso الحقيقية داخل .env
node dev-server.js     # http://127.0.0.1:3010
```

الاختبارات:

```bash
node scripts/test-unit.js   # توليد فيديوهين محليًا، دمجهما، فحص Turso والحذف
node scripts/test-http.js   # يشغّل dev-server تلقائيًا إن لم يكن يعمل ثم يفحص كل النقاط
```

ملاحظة: خادم التطوير يستخدم المنفذ **3010** ثابتًا (يمكن تجاوزه بمتغير `MERGER_PORT` فقط إن احتجت)، لأن بيئة المعاينة قد تحجز منافذ أخرى.

---

## النشر على Vercel خطوة بخطوة

### 1) إنشاء قاعدة Turso

```bash
# ثبّت Turso CLI من https://docs.turso.dev ثم:
turso db create video-merger
turso db show video-merger --url        # ← هذا هو TURSO_DATABASE_URL
turso db tokens create video-merger     # ← هذا هو TURSO_AUTH_TOKEN
```

### 2) رفع الكود

ضع مجلد `merger/` في مستودع GitHub (احرص على عدم رفع `.env` — ملف `.gitignore` يمنعه)، أو استخدم Vercel CLI مباشرة:

```bash
cd merger
npx vercel          # ربط المشروع أول مرة
npx vercel --prod   # نشر الإنتاج
```

> مهم: إن كان المستودع يحوي مشروعات أخرى، اضبط **Root Directory = merger** في إعدادات المشروع على Vercel. الـ Framework Preset = **Other** (لا توجد خطوة بناء).

### 3) ضبط متغيرات البيئة في Vercel

من **Project Settings → Environment Variables** أضف (Production + Preview):

| المتغير | القيمة |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://video-merger-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | الرمز الناتج من `turso db tokens create` |

ثم أعد النشر (`npx vercel --prod`) لتطبيقها.

### 4) التحقق

```bash
curl https://<your-app>.vercel.app/api/config
# {"version":"1.0.0","maxSources":10,"sourceMaxMB":200,"outputMaxMB":150,
#  "maxTotalDurationSec":600,"uploadChunkBytes":4194304,"expiresHours":24}
```

افتح الموقع في المتصفح، أو استخدم الـ API مباشرة (توثيق كامل بالأسفل).

### 5) التنظيف الدوري (Cron)

محدد في `vercel.json`: `{"path": "/api/cron", "schedule": "0 3 * * *"}` — يعمل يوميًا 03:00 UTC ويحذف المهام الأقدم من 24 ساعة. هذه الجدولة اليومية متوافقة مع خطة Hobby.

---

## متغيرات البيئة

| المتغير | إلزامي | الافتراضي | الوصف |
|---|---|---|---|
| `TURSO_DATABASE_URL` | نعم | — | رابط قاعدة Turso (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | نعم | — | رمز الوصول للقاعدة |
| `FFMPEG_PRESET` | لا | `medium` | سرعة/جودة ترميز x264: `ultrafast`…`slow` |
| `FFMPEG_PATH` | لا | تلقائي | تجاوز مسار ffmpeg (إن لم تعمل ffmpeg-static) |
| `FFPROBE_PATH` | لا | تلقائي | تجاوز مسار ffprobe |
| `MAX_SOURCES` | لا | `10` | أقصى عدد مصادر للمهمة |
| `SOURCE_MAX_MB` | لا | `200` | أقصى حجم لكل مصدر (MB) |
| `OUTPUT_MAX_MB` | لا | `150` | أقصى حجم للناتج (MB) |
| `MAX_TOTAL_DURATION_SEC` | لا | `600` | أقصى مجموع مدد المصادر (ثوان) |
| `UPLOAD_CHUNK_BYTES` | لا | `4194304` | حجم جزء الرفع (4MB) |
| `EXPIRES_HOURS` | لا | `24` | مدة الصلاحية قبل الحذف (ساعات) |
| `FFMPEG_TIMEOUT_MS` | لا | `270000` | مهلة الترميز قبل الإفشال |
| `DOWNLOAD_TIMEOUT_MS` | لا | `120000` | مهلة تنزيل كل رابط مصدر |

الثنائيات: تُستخدم `ffmpeg-static`/`ffprobe-static` أولًا، وإن فقدت صلاحية التنفيذ تُنسخ إلى `/tmp` بصلاحية 755، وإن غابت تمامًا يُستخدم ffmpeg النظامي.

---

## توثيق API الكامل

كل الردود تحمل ترويسات CORS مفتوحة (`Access-Control-Allow-Origin: *` مع دعم OPTIONS)، والأخطاء بصيغة `{"error":"رسالة عربية"}`.

### POST /api/jobs — إنشاء مهمة

```bash
curl -X POST https://<app>.vercel.app/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://example.com/first.mp4","https://example.com/second.mp4"]}'
```

استجابة 201:

```json
{
  "jobId": "k3x9q2m7ab",
  "status": "queued",
  "statusUrl": "https://<app>.vercel.app/api/jobs/k3x9q2m7ab",
  "processUrl": "https://<app>.vercel.app/api/jobs/k3x9q2m7ab/process",
  "expiresAt": "2026-11-17T19:00:00.000Z"
}
```

مع ملفات (صيغة `sources`) تُضاف خطة الرفع:

```bash
curl -X POST https://<app>.vercel.app/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"sources":[{"kind":"url","url":"https://example.com/a.mp4"},{"kind":"file","name":"clip.mp4","size":12345678,"mime":"video/mp4"}]}'
```

```json
{
  "jobId": "k3x9q2m7ab",
  "status": "uploading",
  "statusUrl": "...", "processUrl": "...", "expiresAt": "...",
  "uploadChunkBytes": 4194304,
  "uploads": [
    { "seq": 1, "name": "clip.mp4", "size": 12345678, "chunks": 3,
      "uploadUrl": "https://<app>.vercel.app/api/upload?job=k3x9q2m7ab&seq=1" }
  ]
}
```

الأخطاء: `400` مدخلات تالفة، `413` تجاوز حجم مصدر، `405` طريقة خاطئة، `500` خطأ داخلي.

### POST /api/upload?job=&seq=&chunk= — رفع جزء

جسم الطلب ثنائي خام (`application/octet-stream`) حتى 4MB:

```bash
curl -X POST "https://<app>.vercel.app/api/upload?job=k3x9q2m7ab&seq=1&chunk=0" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @part0.bin
```

استجابة 200: `{"ok":true,"received":4194304}`
الأخطاء: `400` معلمات/فهرس خارج النطاق، `404` مهمة/مصدر غير موجود، `409` المهمة لا تقبل الرفع، `413` تجاوز 4MB.

### POST /api/jobs/<id>/process — تنفيذ الدمج (متزامن)

```bash
curl -X POST https://<app>.vercel.app/api/jobs/k3x9q2m7ab/process
```

استجابة 200 عند النجاح:

```json
{
  "status": "done",
  "jobId": "k3x9q2m7ab",
  "videoUrl": "https://<app>.vercel.app/api/jobs/k3x9q2m7ab/video",
  "downloadUrl": "https://<app>.vercel.app/api/jobs/k3x9q2m7ab/video?download=1",
  "size": 15234918,
  "duration": 4.98,
  "resolution": "640x360",
  "expiresAt": "2026-11-17T19:00:00.000Z"
}
```

- `202` مع `{"status":"processing"}` لو كانت قيد المعالجة فعلهًا (طلب متوازٍ).
- `200` مرة أخرى لو كانت `done`.
- `500` مع رسالة عربية واضحة عند فشل الدمج (تُسجل أيضًا في `job.error`).
- التقدم أثناء المعالجة (0–40 سحب المصادر، 40–90 ترميز، 92–99 حفظ، 100 اكتمال) يُقرأ من نقطة الحالة.

### GET /api/jobs/<id> — الحالة والتقدم

```bash
curl https://<app>.vercel.app/api/jobs/k3x9q2m7ab
```

```json
{
  "jobId": "k3x9q2m7ab",
  "status": "done",
  "progress": 100,
  "videoUrl": "...",
  "downloadUrl": "...",
  "error": null,
  "size": 15234918,
  "duration": 4.98,
  "resolution": "640x360",
  "expiresAt": "2026-11-17T19:00:00.000Z",
  "createdAt": "2026-11-16T19:00:00.000Z"
}
```

الحالات: `queued` → `uploading` → `processing` → `done | failed`. الأخطاء: `400` معرف غير صالح، `404` غير موجودة/منتهية.

### GET /api/jobs/<id>/video — بث الناتج

```bash
# مشاهدة (Inline)
curl -o out.mp4 https://<app>.vercel.app/api/jobs/k3x9q2m7ab/video

# تحميل (Attachment)
curl -o out.mp4 "https://<app>.vercel.app/api/jobs/k3x9q2m7ab/video?download=1"

# مدى بايتي (تقديم/ترجيع في المشغل)
curl -H "Range: bytes=0-1023" https://<app>.vercel.app/api/jobs/k3x9q2m7ab/video -o part.mp4 -D -
```

- بدون `Range`: `200` + `Accept-Ranges: bytes` + `Content-Length`.
- مع `Range`: `206` + `Content-Range: bytes 0-1023/<size>` (وتدعم صيغة اللاحقة `bytes=-N`).
- مدى غير منطقي: `416` مع `Content-Range: bytes */<size>`.
- `?download=1`: يضيف `Content-Disposition: attachment; filename="merger-<id>.mp4"`.
- الأخطاء: `404` غير موجودة، `409` الفيديو غير جاهز بعد.

### DELETE /api/jobs/<id> — حذف فوري شامل

```bash
curl -X DELETE https://<app>.vercel.app/api/jobs/k3x9q2m7ab
```

استجابة 200: `{"ok":true,"deleted":"k3x9q2m7ab"}` — يحذف صفوف المهمة من الجداول الأربعة في batch واحد + مجلد `/tmp`. غير موجودة → `404`.

### GET /api/config — الحدود والإصدار

```bash
curl https://<app>.vercel.app/api/config
```

```json
{"version":"1.0.0","maxSources":10,"sourceMaxMB":200,"outputMaxMB":150,"maxTotalDurationSec":600,"uploadChunkBytes":4194304,"expiresHours":24}
```

### GET /api/cron — حذف المنتهية

```bash
curl https://<app>.vercel.app/api/cron
```

استجابة 200: `{"ok":true,"deleted":3}`

---

## الحدود

| الحد | القيمة | ملاحظات |
|---|---|---|
| عدد المصادر | 10 | لكل مهمة |
| حجم كل مصدر | 200MB | روابط تُفحص أثناء التنزيل بالبايتات، والملفات عند الإنشاء والرفع |
| حجم الناتج | 150MB | يُفحص بعد الترميز وقبل التخزين |
| مجموع المدد | 600 ثانية (10 دقائق) | يُقاس بـ ffprobe قبل الترميز |
| حجم جزء الرفع | 4MB (4194304 بايت) | أجزاء أكبر → 413 |
| صلاحية المهمة | 24 ساعة | حذف كسول + cron يومي |
| صفوف التخزين | 2MB لكل صف BLOB | قراءة بصفحات 8 صفوف |

## ملاحظات حدود الخطة المجانية على Vercel

1. **maxDuration**: `vercel.json` يطلب 300 ثانية. على Hobby الافتراضي أقل وقد يُقص — إن فشلت المهام الطويلة بسبب المهلة خفّف الأعباء (ملفات أقصر/أصغر) أو اضبط `FFMPEG_PRESET=veryfast` أو `ultrafast`. على Pro يُستخدم 300 كاملة.
2. **ذاكرة/CPU**: الترميز x264 على serverless أبطأ من جهاز مخصص — استخدم preset أسرع للفيديوهات الطويلة.
3. **`/tmp` مؤقت** (~512MB): يستخدم أثناء المعالجة فقط ويُنظف في `finally` — لا تخزن دائمًا فيه.
4. **حجم الدالة**: ثنائيات ffmpeg/ffprobe ترفع الحزمة (~150MB مضغوطة أقل) — ضمن حد 250MB غير المضغوطة للدالة.
5. **Turso المجانية**: حد مجاني للصفوف/القراءات — أجزاء 2MB والقراءة الصفحية (8 صفوف) مصممة لتقليل عدد الاستعلامات والضغط على الحدود، والحذف التلقائي بعد 24 ساعة يمنع تراكم البيانات.
6. **Cron على Hobby**: يومي فقط — جدولتنا `0 3 * * *` متوافقة، والتنظيف الكسول عند كل إنشاء/دمج يغطي ما بين الجدولات.
7. **أمن الأسرار**: لا تضع `TURSO_AUTH_TOKEN` في الكود أبدًا؛ فقط في Environment Variables (محليًا في `.env` الذي يمنعه `.gitignore`). رسائل الأخطاء تُنقَّى من الروابط/الرموز قبل العرض أو التخزين.

## استكشاف الأخطاء

- `ffmpeg غير متوفر`: اضبط `FFMPEG_PATH`/`FFPROBE_PATH` أو تأكد من تشغيل postinstall (مع bun أضف الحزم إلى `trustedDependencies` — موجودة في package.json).
- `انتهت المهلة أثناء ترميز الفيديو`: خفّف الحجم أو `FFMPEG_PRESET=veryfast`.
- أخطاء قاعدة البيانات: تحقق من `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` وصلاحية الرمز (التجديد: `turso db tokens create <db>`).
- جزء رفع مرفوض 413: قسّم بأحجام `/api/config → uploadChunkBytes` بالضبط.
