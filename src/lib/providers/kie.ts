/**
 * مزود kie.ai (الأساسي) — Jobs API الموحد:
 * POST /api/v1/jobs/createTask ثم GET /api/v1/jobs/recordInfo
 * انتبه: resultJson نص JSON داخل JSON يحتاج JSON.parse ثانيًا.
 * الاستجابات بشكل {code, msg, data} — code !== 200 يعني خطأ أعمال حتى لو HTTP 200.
 */
import { ProviderError, type CheckResult, type ProviderAdapter, type ProviderInput } from "./types";

const BASE = "https://api.kie.ai";

function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

/** نبني حقول الإدخال المقبولة رسميًا فقط — القيم الافتراضية (auto) تُحذف حتى لا نخترع حقولًا */
function buildInput(input: ProviderInput, isVideo: boolean): Record<string, unknown> {
  const p: Record<string, unknown> = { prompt: input.prompt };
  if (input.image_url) p.image_url = input.image_url;
  if (input.aspect_ratio && input.aspect_ratio !== "auto") p.aspect_ratio = input.aspect_ratio;
  if (input.resolution) {
    // الفيديو 480p/720p/1080p والصور 1K/2K/4K — الافتراضي يُحذف
    if (isVideo && input.resolution !== "480p") p.resolution = input.resolution;
    if (!isVideo && input.resolution !== "1K") p.resolution = input.resolution;
  }
  if (input.background && input.background !== "auto") p.background = input.background;
  if (input.output_format && input.output_format !== "png") p.output_format = input.output_format;
  if (isVideo && input.duration) p.duration = input.duration;
  // ملاحظة: الصوت مع grok-imagine-video-1-5-preview مولَّد دائمًا ولا يمكن تعطيله — enable_audio لا يُرسل
  return p;
}

export const kieAdapter: ProviderAdapter = {
  id: "kie",

  async createTask(key, model, input): Promise<{ providerTaskId: string }> {
    const isVideo = /video/i.test(model);
    let res: Response;
    try {
      res = await fetch(`${BASE}/api/v1/jobs/createTask`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify({ model, input: buildInput(input, isVideo) }),
      });
    } catch (e) {
      throw new ProviderError(undefined, `تعذر الاتصال بـ kie.ai: ${e instanceof Error ? e.message : e}`);
    }
    const body = (await res
      .json()
      .catch(() => null)) as { code?: number; msg?: string; data?: { taskId?: string } } | null;
    if (!res.ok) throw new ProviderError(res.status, body?.msg || `HTTP ${res.status}`);
    if (!body || body.code !== 200) {
      throw new ProviderError(body?.code ?? res.status, body?.msg || "استجابة غير متوقعة من kie.ai");
    }
    const taskId = body.data?.taskId;
    if (!taskId) throw new ProviderError(500, "لم يُعَد معرّف مهمة من kie.ai");
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key, providerTaskId): Promise<CheckResult> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
    } catch {
      // انقطاع شبكة مؤقت — نبقي المهمة جارية
      return { status: "processing" };
    }
    const body = (await res.json().catch(() => null)) as
      | { code?: number; msg?: string; data?: { state?: string; resultJson?: string; failMsg?: string } }
      | null;
    if (!res.ok || !body || body.code !== 200) {
      // مهمة غير موجودة بعد أو خلل استقصاء — تعامل مؤقتًا لا فشلًا نهائيًا
      return { status: "processing" };
    }
    const rec = (body.data || {}) as {
      state?: string;
      resultJson?: string;
      failMsg?: string;
      resultUrl?: string;
    };
    const state = String(rec.state || "").toLowerCase();
    if (state === "success") {
      let urls: string[] = [];
      try {
        // resultJson نص JSON داخل JSON — يحتاج parse ثانيًا
        const parsed = JSON.parse(rec.resultJson || "{}") as { resultUrls?: unknown };
        if (Array.isArray(parsed.resultUrls)) {
          urls = parsed.resultUrls.filter(
            (u): u is string => typeof u === "string" && /^https?:\/\//i.test(u)
          );
        }
      } catch {
        // تجاهل — نجرب الحقل المباشر أدناه
      }
      if (!urls.length && typeof rec.resultUrl === "string" && /^https?:\/\//i.test(rec.resultUrl)) {
        urls = [rec.resultUrl];
      }
      return { status: "completed", urls };
    }
    if (state === "fail") {
      return { status: "failed", error: rec.failMsg || "فشل التوليد لدى المزود" };
    }
    // تقدير تقدم من الحالة: waiting → queuing → generating
    const progress = state === "generating" ? 55 : state === "queuing" ? 20 : 8;
    return { status: "processing", progress };
  },
};
