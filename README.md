# MCP Media Generator

خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — مع لوحة إدارة عربية (RTL) ونظام تبديل تسلسلي تلقائي بين مفاتيح API لا يتوقف أبدًا.

يضم المستودع مشروعين يعملان معًا:

| المشروع | المسار | التقنية | الوظيفة |
|---|---|---|---|
| **MCP Media Generator** | الجذر `/` | Next.js 16 + TypeScript + Tailwind + `@modelcontextprotocol/sdk` | خادم MCP على `/mcp` بأدوات خمس + لوحة تحكم عربية + إدارة مفاتيح ومهام |
| **Video Merger API v2** | `merger/` | Node.js خالص (CommonJS) + `ffmpeg-static` + Turso | موقع دمج فيديو بواجهة عامة API جاهز للنشر كمشروع Vercel ثانٍ |

## المزايا الجوهرية

1. **توليد صور** من وصف نصي — الموديل: `gpt-image-2-6/flare-text-to-image` (عبر kie.ai و CometAPI).
2. **توليد فيديو** بصوت متزامن أصلي (الحوار في الوصف يُنطق في الفيديو) مع image-to-video اختياري — الموديل: `grok-imagine-video-1-5-preview`.
3. **دمج عدة مقاطع** في فيديو واحد عالي الجودة (H.264 CRF 18 + AAC، حتى 1080p) بالترتيب المطلوب.
4. **تبديل مفاتيح تسلسلي صارم**: المفاتيح تُجرَّب بترتيب إضافتها بالضبط (`created_at ASC, id ASC`) — عند أي خطأ أو نفاد رصيد ينتقل فورًا للمفتاح التالي ويستأنف **نفس المهمة بنفس `task_id`** دون توقف، ونموذج الذكاء الاصطناعي **لا يرى أخطاء المفاتيح أو الرصيد أبدًا**.
5. **روابط فقط**: لا يُنزَّل أي ملف وسائط على السيرفر إطلاقًا — تُخزَّن روابط النتائج فقط في قاعدة البيانات.
6. **إخفاء المفاتيح إلزامي** في كل الاستجابات والسجلات (`ABCD123••••••••WXYZ`).
7. **بث تقدم حي** عبر Progress notifications أثناء نافذة الانتظار، والمهمة غير المكتملة تُتابَع بـ `get_task` كل ~10 ثوانٍ.
8. مهمة فشل إنشاؤها على كل المفاتيح تبقى `processing` برسالة داخلية «بانتظار توفر مفتاح صالح…» وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة ~45 ثانية) — لو شُحن رصيد أي مفتاح اكتملت المهمة من تلقاء نفسها.

## الأدوات الخمس على `/mcp`

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة، تعيد الرابط جاهزًا إن اكتملت خلال نافذة الانتظار وإلا تعيد `task_id` |
| `generate_video` | توليد فيديو بصوت متزامن (مدة 1–15 ثانية، حتى 1080p) — تعيد `task_id` للمناوبة |
| `merge_videos` | دمج مقطعين إلى 10 عبر `urls` مباشرة أو `task_ids` لمهام مكتملة (بالترتيب) |
| `get_task` | متابعة أي مهمة (توليد أو دمج) وتحديثها حيًا من المزود/خدمة الدمج |
| `list_media` | استرجاع أحدث الوسائط المخزنة بروابطها من قاعدة البيانات |

كل نتائج الأدوات تُصاغ بالعربية، والأوصاف بالإنجليزية ليقرأها عميل MCP.

## ربط عملاء MCP

رابط الخادم دائمًا: `<origin>/mcp` (انسخه من بطاقة «ربط السيرفر» في اللوحة).

**ChatGPT / GPT Agents** (Settings → Connectors → Create → Custom MCP server):

```json
{
  "mcpServers": {
    "media-generator": {
      "url": "https://<your-app>.vercel.app/mcp"
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "media-generator": {
      "type": "http",
      "url": "https://<your-app>.vercel.app/mcp"
    }
  }
}
```

**Cursor / Windsurf / Cline** (`mcp.json`): نفس صيغة ChatGPT أعلاه.

إن ضُبط `MCP_ACCESS_TOKEN` تُضاف:

```json
"headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }
```

> ملاحظة: الفيديو يحتاج دقائق — يعيد السيرفر `task_id` فورًا ويُتابَع بـ `get_task` كل 10 ثوانٍ حتى يظهر الرابط، وأثناء الانتظار يُبَث تقدم حي حتى لا تنقطع العملية. ملفات الدمج تُحذف من خدمة الدمج بعد ~24 ساعة — نزّلها سريعًا.

---

## النشر على Vercel (خطوة بخطوة)

### 1) قاعدة بيانات Turso (مرة واحدة)

```bash
# ثبت واجهة Turso ثم:
turso db create <db-name>
turso db show <db-name> --url          # ← هذه قيمة TURSO_DATABASE_URL
turso db tokens create <db-name>       # ← هذه قيمة TURSO_AUTH_TOKEN
```

### 2) مشروع خدمة الدمج أولًا (لأن التطبيق الرئيسي يحتاج رابطه)

1. ارفع هذا المستودع إلى GitHub (مرفوع مسبقًا على `Mverdy12345/Mahmoudnew`).
2. في Vercel: **Add New → Project** واختر المستودع.
3. في **Root Directory** اختر: `merger`.
4. أضف متغيرَي البيئة (Production + Preview):
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
5. **Deploy** — احفظ رابط المشروع مثل `https://<merger-project>.vercel.app`.

### 3) التطبيق الرئيسي

1. في Vercel: **Add New → Project** لنفس المستودع مرة ثانية.
2. اترك **Root Directory** فارغًا (جذر المستودع).
3. أضف متغيرات البيئة (Production + Preview):

   | المتغير | إلزامي | القيمة |
   |---|---|---|
   | `TURSO_DATABASE_URL` | نعم | `libsql://<db-name>-<org>.turso.io` |
   | `TURSO_AUTH_TOKEN` | نعم | توكن Turso بصلاحيات كتابة |
   | `MERGER_API_BASE` | نعم لعمل الدمج | رابط مشروع خدمة الدمج من الخطوة 2 |
   | `MCP_ACCESS_TOKEN` | اختياري | إن ضُبط يُطلب Bearer token على `/mcp` |
   | `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` / `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | اختياري | تجاوز أسماء الموديلات |

4. **Deploy** — ثم أضف مفاتيح مزودي التوليد من واجهة اللوحة (مدير المفاتيح).

> لا أسرار في المستودع إطلاقًا: ملفات `.env*` مستثناة من Git منذ أول commit، ونفس القيم تُوضع يدويًا في Vercel → Settings → Environment Variables.

### 4) التشغيل المحلي

```bash
# التطبيق الرئيسي
bun install
cp .env.example .env.local     # ثم عبّئ القيم الحقيقية
bun run dev                    # http://localhost:3000

# خدمة الدمج (منفصل)
cd merger
bun install
node dev-server.js             # http://localhost:3010
```

---

## واجهة اللوحة والتطبيق

- **مدير المفاتيح**: إضافة مفتاح لكل مزود (kie.ai / CometAPI) مع تسمية اختيارية ورفض التكرار؛ عرض مقنَّع دائمًا مع شارة حالة (`نشط` أخضر / `مستنزف` كهرماني / `معطّل` رمادي) وعدّادات الاستخدام/النجاح/الفشل وآخر خطأ، وأزرار تعطيل–تنشيط وحذف.
- **لوحة المهام**: شرائح إحصائيات (إجمالي/مكتملة/فاشلة/جارية) وقائمة تتحدث تلقائيًا كل ~5 ثوانٍ مع شريط تقدم وروابط النتائج وعدد المحاولات.
- **ربط السيرفر**: رابط `/mcp` بزر نسخ + تبويبات JSON جاهزة (ChatGPT / Claude Desktop / Cursor) + رقائق الأدوات الخمس.

### نقاط API للتطبيق الرئيسي

| Method | Endpoint | الوظيفة |
|---|---|---|
| GET | `/api/health` | الجهوزية: `ok`, `database`, `models`, `merger.healthy`, `authRequired` |
| GET / POST | `/api/keys` | قائمة المفاتيح المقنّعة / إضافة مفتاح (409 عند التكرار) |
| PATCH / DELETE | `/api/keys/{id}` | تعطيل–تنشيط / حذف |
| GET | `/api/tasks?limit=&type=&status=` | إحصائيات + أحدث المهام للوحة |
| POST / GET / DELETE | `/mcp` | خادم MCP (Streamable HTTP) — أدوات خمس |

> توثيق API خدمة الدمج الكامل (النقاط السبع + أمثلة curl + الاستجابات + الحدود) في [merger/README.md](merger/README.md).

## متغيرات البيئة (كلا المشروعين)

| المتغير | المشروع | إلزامي | الوصف |
|---|---|---|---|
| `TURSO_DATABASE_URL` | كلاهما | نعم | رابط Turso `libsql://...` |
| `TURSO_AUTH_TOKEN` | كلاهما | نعم | توكن كتابة |
| `MERGER_API_BASE` | الرئيسي | للدمج | رابط خدمة الدمج المنشورة |
| `MCP_ACCESS_TOKEN` | الرئيسي | لا | حماية `/mcp` بـ Bearer token |
| `KIE_IMAGE_MODEL` … `COMETAPI_VIDEO_MODEL` | الرئيسي | لا | تجاوز أسماء الموديلات |
| `COMETAPI_BASE` | الرئيسي | لا | افتراضي `https://api.cometapi.com` |
| `FFMPEG_PRESET` | merger | لا | افتراضي `medium` |
| `MAX_SOURCES` / `SOURCE_MAX_MB` / `OUTPUT_MAX_MB` / `MAX_TOTAL_DURATION_SEC` | merger | لا | الحدود (10 / 200 / 150 / 600) |

## الاختبارات

```bash
# بروتوكول MCP كامل (تهيئة، أدوات، إشعارات، أخطاء عربية)
node scripts/mcp-e2e.mjs

# استدعاء أداة مباشرة
node scripts/mcp-e2e.mjs call generate_image '{"prompt":"..."}'

# خدمة الدمج
cd merger
node scripts/test-unit.js     # محرك ffmpeg + تخزين Turso (22 اختبارًا)
node scripts/test-http.js     # دورة HTTP كاملة ضد 127.0.0.1:3010 (27 اختبارًا)
```

نتائج آخر تشغيل محلي كامل: بروتوكول MCP **18/18** · وحدات الدمج **22/22** · HTTP الدمج **27/27** · بناء إنتاج `next build` ناجح مع تشغيل حقيقي لـ `/mcp` و`/api/health` والواجهة على خادم standalone بمتغيرات الإنتاج فقط.

## قواعد ذهبية مطبَّقة في الكود

1. ترتيب المفاتيح تسلسلي صارم بترتيب الإضافة — لا round-robin.
2. المستنزف (`exhausted`) يبقى في القائمة والقاعدة، والاستثناء الوحيد التعطيل اليدوي (`disabled`) — ويعود تلقائيًا إلى «نشط» عند أول نجاح بعد شحن الرصيد.
3. تبديل صامت: العميل يرى «قيد المعالجة» فقط ولا يصل إليه أي ذكر لمفاتيح أو رصيد.
4. أخطاء خدمة الدمج المعلنة (HTTP 4xx/5xx بجسم error) = فشل نهائي فوري؛ أخطاء شبكتنا مؤقتة وتستمر بالاستعلام.
5. لا تخترع أشكال APIs — الأشكال مقاسة من التوثيق الرسمي (kie.ai Jobs API الموحد، CometAPI `apidoc.cometapi.com`).
6. `.env*` مستثنى من Git منذ أول commit ولا تُطبع المفاتيح الكاملة في الردود أو السجلات.

## استكشاف الأخطاء

| المشكلة | السبب والحل |
|---|---|
| `/api/health` يرجع `turso-error` | تحقق من `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN` على Vercel |
| `merger.healthy: false` | خدمة الدمج غير منشورة أو `MERGER_API_BASE` خاطئ — انشر مجلد `merger` أولًا |
| المهمة تبقى «جارية» طويلًا | المفاتيح مستنزفة أو الرصيد فارغ — الشاشة تُظهر حالة كل مفتاح؛ بعد الشحن تكتمل المهمة تلقائيًا مع أول `get_task` |
| المفتاح ظهر «مستنزف» بالخطأ | اضغط «تنشيط» ثم أعد المحاولة |
| ملف الدمج 404 | مضى عليه ~24 ساعة وحُذف من خدمة الدمج — أعد الدمج |
