/**
 * مزود CometAPI (الثاني) وفق التوثيق الرسمي المقاس على apidoc.cometapi.com:
 * - الصور: متزامنة عبر POST /v1/images/generations (متوافقة مع OpenAI، تعيد الرابط فورًا).
 * - الفيديو (grok imagine): POST /grok/v1/videos/generations → {request_id}
 *   ثم الاستقصاء GET /grok/v1/videos/{request_id} → {status: done|failed|expired, video:{url}}
 */
import { ProviderError, type CheckResult, type ProviderAdapter, type ProviderInput } from "./types";

const BASE = (process.env.COMETAPI_BASE || "https://api.cometapi.com").replace(/\/$/, "");

function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function failFromResponse(res: Response, data: unknown): Promise<never> {
  const d = data as { error?: { message?: string } | string; message?: string } | null;
  const msg =
    (typeof d?.error === "object" ? d?.error?.message : d?.error) ||
    d?.message ||
    `HTTP ${res.status}`;
  throw new ProviderError(res.status, typeof msg === "string" ? msg : JSON.stringify(msg));
}

export const cometapiAdapter: ProviderAdapter = {
  id: "cometapi",

  // صور متزامنة — النتيجة ترد فورًا (url أو b64_json)
  async createImageSync(key, model, input) {
    const payload: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      n: 1,
      response_format: "url", // نطلب رابطًا — لا ننزّل أي وسائط إلى سيرفرنا
    };
    if (input.aspect_ratio && input.aspect_ratio !== "auto") payload.aspect_ratio = input.aspect_ratio;
    if (input.resolution && input.resolution !== "1K") payload.resolution = input.resolution.toLowerCase();

    let res: Response;
    try {
      res = await fetch(`${BASE}/v1/images/generations`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new ProviderError(undefined, `تعذر الاتصال بـ CometAPI: ${e instanceof Error ? e.message : e}`);
    }
    const data = (await res.json().catch(() => null)) as
      | { data?: Array<{ url?: string; b64_json?: string }> }
      | null;
    if (!res.ok) await failFromResponse(res, data);
    const item = data?.data?.[0];
    let urls: string[] = [];
    if (item?.url) urls = [String(item.url)];
    else if (item?.b64_json) {
      // b64 نمرره كـ data URI — لا تنزيل ولا تخزين وسائط على السيرفر
      urls = [`data:image/png;base64,${item.b64_json}`];
    }
    if (!urls.length) throw new ProviderError(500, "لم يُعَد رابط صورة من CometAPI");
    return { urls };
  },

  // فيديو غير متزامن عبر نقطة grok — تعيد request_id فقط
  async createTask(key, model, input) {
    const payload: Record<string, unknown> = { model, prompt: input.prompt };
    if (input.image_url) payload.image = { url: input.image_url };
    if (input.aspect_ratio && input.aspect_ratio !== "auto") payload.aspect_ratio = input.aspect_ratio;
    if (input.resolution && input.resolution !== "480p") payload.resolution = input.resolution;
    if (input.duration) payload.duration = input.duration;
    // ملاحظة: الصوت مولَّد دائمًا مع grok imagine — enable_audio لا يُرسل

    let res: Response;
    try {
      res = await fetch(`${BASE}/grok/v1/videos/generations`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new ProviderError(undefined, `تعذر الاتصال بـ CometAPI: ${e instanceof Error ? e.message : e}`);
    }
    const data = (await res.json().catch(() => null)) as
      | { request_id?: string; id?: string }
      | null;
    if (!res.ok) await failFromResponse(res, data);
    const id = data?.request_id || data?.id;
    if (!id) throw new ProviderError(500, "لم يُعَد معرّف مهمة من CometAPI");
    return { providerTaskId: String(id) };
  },

  async checkTask(key, providerTaskId): Promise<CheckResult> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/grok/v1/videos/${encodeURIComponent(providerTaskId)}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
    } catch {
      return { status: "processing" };
    }
    const data = (await res.json().catch(() => null)) as
      | {
          status?: string;
          video?: { url?: string };
          error?: { message?: string } | string;
        }
      | null;
    if (res.status === 404) return { status: "processing" }; // قد تتأخر المهمة في الظهور
    if (!res.ok) await failFromResponse(res, data);

    const d = data as {
      status?: string;
      video?: { url?: string };
      error?: { message?: string } | string;
    } | null;
    const status = String(d?.status || "").toLowerCase();
    if (status === "done") {
      const url = d?.video?.url;
      if (!url || !/^https?:\/\//i.test(url)) {
        return { status: "failed", error: "اكتملت المهمة دون رابط نتيجة" };
      }
      return { status: "completed", urls: [url] };
    }
    if (status === "failed" || status === "expired") {
      const err =
        (typeof d?.error === "object" ? d?.error?.message : d?.error) ||
        `فشل التوليد لدى المزود (${status})`;
      return { status: "failed", error: String(err) };
    }
    return { status: "processing", progress: status === "processing" ? 50 : 15 };
  },
};
