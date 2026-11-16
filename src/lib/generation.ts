/**
 * منسّق التوليد — قلب التشغيل:
 * 1) تسجيل المهمة في Turso قبل أي نداء خارجي.
 * 2) تجربة المرشحين بالترتيب التسلسلي الصارم حتى نجاح الإنشاء.
 * 3) تبديل تلقائي فوري عند أي خطأ مفتاح/رصيد دون توقف — نفس المهمة بنفس task_id.
 * 4) نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا.
 */
import { randomUUID } from "crypto";
import {
  classifyProviderError,
  fetchKeyPool,
  KEY_BALANCE_FAIL_PATTERN,
  recordKeyFailure,
  recordKeySuccess,
} from "./keys";
import { maskKey, scrubSecrets } from "./mask";
import { MODELS, resolveModel, type ModelDef } from "./models";
import { PROVIDERS, ProviderError, type ProviderInput } from "./providers";
import {
  createMergeJob,
  getMergeJob,
  isMergerDeclaredError,
  isProcessInFlight,
  MergerFail,
  MergerGone,
  mergerBase,
  mergerConfigured,
  startMergeProcess,
} from "./merger";
import {
  getTask,
  getKeyById,
  insertTask,
  updateTask,
  type TaskPatch,
} from "./turso";
import type { KeyRow, MediaType, TaskRow } from "./types";

export class ToolError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export interface RunCallbacks {
  /** بث التقدم الحي (progress notifications كل ~3 ثوانٍ) */
  onProgress?: (progress: number, message: string) => Promise<void> | void;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      done();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** وقت sqlite بصيغة UTC بدون منطقة زمنية — نضيف Z صراحة */
function parseSqliteTime(s: string | null | undefined): number {
  if (!s) return 0;
  const t = Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(t) ? 0 : t;
}

export function parseUrls(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

function taskParams(t: TaskRow): { input?: ProviderInput; videos?: string[]; processStartedAt?: string } {
  try {
    return JSON.parse(t.params_json || "{}");
  } catch {
    return {};
  }
}

interface DispatchResult {
  providerTaskId?: string;
  urls?: string[];
  paramsFailure?: boolean;
  lastError?: string;
}

/**
 * تجربة مرشحي المفاتيح بالترتيب الصارم: أول نجاح يربط المهمة بالمزود والمفتاح.
 * كل محاولة (نجاح أو فشل + الفئة) تُسجَّل في attempts_json وعدّادات المفتاح تُحدَّث دائمًا.
 */
async function dispatchToPool(
  taskId: string,
  def: ModelDef,
  input: ProviderInput
): Promise<DispatchResult> {
  const pool = await fetchKeyPool(def.providers);
  let lastError = "";

  for (const key of pool) {
    const adapter = PROVIDERS[key.provider];
    if (!adapter) continue;
    const providerModel = def.providerModel[key.provider];
    try {
      if (def.type === "image" && adapter.createImageSync) {
        // مزود يدعم الصور المتزامنة — النتيجة فورية
        const { urls } = await adapter.createImageSync(key.api_key, providerModel, input);
        await recordKeySuccess(key);
        await updateTask(taskId, {
          newAttempt: { provider: key.provider, keyId: key.id, keyLabel: key.label, ok: true, at: new Date().toISOString() },
        });
        await updateTask(taskId, {
          provider: key.provider,
          key_id: key.id,
          status: "completed",
          result_urls: urls,
          progress: 100,
          completed: true,
        });
        return { urls };
      }
      const { providerTaskId } = await adapter.createTask(key.api_key, providerModel, input);
      await recordKeySuccess(key);
      await updateTask(taskId, {
        provider: key.provider,
        key_id: key.id,
        provider_task_id: providerTaskId,
        status: "processing",
        progress: 5,
        newAttempt: { provider: key.provider, keyId: key.id, keyLabel: key.label, ok: true, at: new Date().toISOString() },
      });
      return { providerTaskId };
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError(undefined, e instanceof Error ? e.message : String(e));
      const cls = classifyProviderError(pe);
      const safe = scrubSecrets(pe.message, pool.map((k) => k.api_key));
      lastError = safe;
      await updateTask(taskId, {
        newAttempt: { provider: key.provider, keyId: key.id, keyLabel: key.label, ok: false, errorClass: cls, error: safe, at: new Date().toISOString() },
      });
      await recordKeyFailure(key, cls, safe);
      if (cls === "params") {
        // توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات
        await updateTask(taskId, { status: "failed", error_message: safe, completed: true });
        return { paramsFailure: true, lastError: safe };
      }
      // disabled/exhausted/provider/temporary → انتقل للمفتاح التالي فورًا دون توقف
      continue;
    }
  }
  return { lastError };
}

/** إعادة إنشاء نفس المهمة بنفس task_id على المفاتيح التالية (التبديل الصامت) */
async function redispatch(taskId: string, def: ModelDef): Promise<void> {
  const t = await getTask(taskId);
  if (!t) return;
  const input = taskParams(t).input ?? { prompt: t.prompt };
  const d = await dispatchToPool(taskId, def, input);
  if (!d.providerTaskId && !d.urls) {
    // فشل على كل المفاتيح — تبقى processing بانتظار مفتاح صالح وتُعاد مع get_task
    await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
  }
}

/**
 * نافذة الانتظار: استقصاء كل 3 ثوانٍ مع بث تقدم حي.
 * يعيد روابط النتائج عند الاكتمال أو null إذا انتهت النافذة والنتيجة لم تظهر.
 */
async function waitForTask(
  taskId: string,
  waitSeconds: number,
  cb?: RunCallbacks
): Promise<string[] | null> {
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    if (cb?.signal?.aborted) return null;
    await sleep(3000, cb?.signal);
    if (Date.now() >= deadline) break;
    let t = await getTask(taskId);
    if (!t) return null;
    if (t.status === "completed") return parseUrls(t.result_urls_json);
    if (t.status === "failed") return null;
    t = await refreshTask(taskId);
    if (!t) return null;
    if (t.status === "completed") return parseUrls(t.result_urls_json);
    if (t.status === "failed") return null;
    const p = Math.min(t.progress, 95);
    await cb?.onProgress?.(p, `قيد التوليد… ${p}%`);
  }
  return null;
}

/**
 * تحديث المهمة الجارية حيًا من المزود (أو خدمة الدمج) مع نفس منطق
 * إعادة المحاولة/التبديل — يُستدعى من نافذة الانتظار ومن أداة get_task.
 */
export async function refreshTask(taskId: string): Promise<TaskRow | null> {
  const t = await getTask(taskId);
  if (!t || t.status !== "processing") return t;

  if (t.type === "merge" || t.provider === "merger") {
    return refreshMergeTask(t);
  }

  const def = resolveModel(t.model, t.type === "image" ? "image" : "video");
  if (!def) return t;

  // 1) مهمة مربوطة بمزود → استقصاء حي
  if (t.provider && t.provider !== "merger" && t.provider_task_id) {
    const adapter = PROVIDERS[t.provider];
    const key = t.key_id ? await getKeyById(t.key_id) : null;
    if (adapter && key) {
      let check;
      try {
        check = await adapter.checkTask(key.api_key, t.provider_task_id);
      } catch (e) {
        const pe = e instanceof ProviderError ? e : new ProviderError(undefined, e instanceof Error ? e.message : String(e));
        const cls = classifyProviderError(pe);
        if (cls === "disabled" || cls === "exhausted") {
          // المفتاح مرفوض/مستنزف أثناء الاستقصاء → علّمه وانتقل للتالي بنفس task_id
          await recordKeyFailure(key, cls, scrubSecrets(pe.message, [key.api_key]));
          await redispatch(taskId, def);
          return getTask(taskId);
        }
        // مؤقت — المهمة تبقى جارية ونعيد المحاولة في الدورة التالية
        return t;
      }

      if (check.status === "completed") {
        return updateTask(taskId, {
          status: "completed",
          result_urls: check.urls ?? [],
          progress: 100,
          completed: true,
        });
      }
      if (check.status === "failed") {
        const msg = check.error || "فشل التوليد لدى المزود";
        if (KEY_BALANCE_FAIL_PATTERN.test(msg)) {
          // فشل في منتصف المهمة بسبب مفتاح/رصيد → أعد إنشاء نفس المهمة على المفتاح التالي بنفس task_id
          const cls = classifyProviderError({ status: undefined, message: msg });
          await recordKeyFailure(key, cls, scrubSecrets(msg, [key.api_key]));
          await updateTask(taskId, {
            provider: null,
            key_id: null,
            provider_task_id: null,
            newAttempt: { provider: key.provider, keyId: key.id, keyLabel: key.label, ok: false, errorClass: cls, error: scrubSecrets(msg, [key.api_key]), at: new Date().toISOString() },
          });
          await redispatch(taskId, def);
          return getTask(taskId);
        }
        // فشل حقيقي (انتهاك سياسة/معطيات)
        return updateTask(taskId, { status: "failed", error_message: msg, completed: true });
      }
      // processing → حدّث التقدم في القاعدة فورًا
      const p = Math.max(t.progress, check.progress ?? 0);
      if (p > t.progress) return updateTask(taskId, { progress: Math.min(p, 95) });
      return t;
    }
  }

  // 2) مهمة غير مربوطة بمزود (فشل الإنشاء على كل المفاتيح) → تهدئة ~45 ثانية ثم إعادة محاولة تلقائية
  const idleMs = Date.now() - parseSqliteTime(t.updated_at);
  if (idleMs >= 45000) {
    await redispatch(taskId, def);
    return getTask(taskId);
  }
  return t;
}

// ---------- الدمج ----------

async function refreshMergeTask(t: TaskRow): Promise<TaskRow> {
  const taskId = t.id;
  const jobId = t.provider_task_id;

  if (!mergerConfigured()) return t; // الخدمة غير مهيأة — لا شيء يمكن عمله الآن

  if (!jobId) {
    // لم تُنشأ المهمة لدى الخدمة بعد (فشل شبكة سابق) → تهدئة ثم إعادة محاولة
    if (Date.now() - parseSqliteTime(t.updated_at) >= 45000) {
      const params = taskParams(t);
      const videos = params.videos ?? [];
      if (videos.length >= 2) {
        try {
          const jid = await createMergeJob(videos);
          await updateTask(taskId, { provider_task_id: jid, progress: 5 });
          await startMergeProcess(jid);
          await updateTask(taskId, { paramsMerge: { processStartedAt: new Date().toISOString() } });
        } catch (e) {
          if (isMergerDeclaredError(e)) {
            return updateTask(taskId, { status: "failed", error_message: e.message, completed: true });
          }
          // مؤقت — تهدئة من جديد
          await updateTask(taskId, { error_message: `تعذر إنشاء مهمة الدمج: ${e instanceof Error ? e.message : e}` });
        }
      }
    }
    return getTask(taskId);
  }

  // نفّذ process الآن إن لم يُنفَّذ بعد (استئناف بعد انقطاع)
  const params = taskParams(t);
  const processStartedAt = params.processStartedAt ? parseSqliteTime(params.processStartedAt) : 0;
  const stale = processStartedAt > 0 && Date.now() - processStartedAt > 180000;

  if ((!params.processStartedAt && !isProcessInFlight(jobId)) || stale) {
    await startMergeProcess(jobId);
    await updateTask(taskId, { paramsMerge: { processStartedAt: new Date().toISOString() } });
  }

  let st;
  try {
    st = await getMergeJob(jobId);
  } catch (e) {
    if (e instanceof MergerFail) {
      // أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة
      return updateTask(taskId, { status: "failed", error_message: `فشل الدمج: ${e.message}`, completed: true });
    }
    if (e instanceof MergerGone) {
      return updateTask(taskId, { status: "failed", error_message: e.message, completed: true });
    }
    return t; // خطأ شبكتنا نحن — مؤقت وتستمر بالاستعلام حتى انتهاء النافذة
  }

  if (st.done) {
    // رابط النتيجة: فضّل videoUrl ثم downloadUrl ثم رابط البث المباشر
    const finalUrl = st.videoUrl || `${mergerBase()}/api/jobs/${jobId}/video`;
    return updateTask(taskId, {
      status: "completed",
      result_urls: [finalUrl],
      progress: 100,
      completed: true,
    });
  }
  if (st.failed) {
    return updateTask(taskId, { status: "failed", error_message: st.error || "فشل الدمج", completed: true });
  }
  const p = Math.max(t.progress, st.progress ?? 0);
  if (p > t.progress) return updateTask(taskId, { progress: Math.min(p, 99) });
  return t;
}

export interface MergeOptions {
  urls?: string[];
  taskIds?: string[];
  waitSeconds: number;
}

/**
 * تدفق الدمج: تحقق صارم من عدد الروابط وصلاحيتها → تسجيل المهمة أولًا →
 * إنشاء job لدى الخدمة → إطلاق process خلفيًا بمرة واحدة → نافذة انتظار مع بث تقدم.
 */
export async function runMerge(
  opts: MergeOptions,
  cb?: RunCallbacks
): Promise<{ task: TaskRow; urls: string[] | null }> {
  const details: string[] = [];
  const resolved: string[] = [];

  for (const raw of opts.taskIds ?? []) {
    const tid = raw.trim();
    const t = tid ? await getTask(tid) : null;
    const u = t && t.status === "completed" ? parseUrls(t.result_urls_json) : null;
    if (t && u && u.length) resolved.push(u[0]);
    else {
      const why = !t ? "غير موجود في قاعدة البيانات" : t.status !== "completed" ? `لم تكتمل بعد (الحالة: ${t.status})` : "لا توجد روابط نتيجة";
      details.push(`• ${tid || "(فارغ)"}: ${why}`);
    }
  }

  const direct = (opts.urls ?? []).map((s) => s.trim()).filter(Boolean);
  // الترتيب: روابط task_ids أولًا ثم urls المباشرة بنفس ترتيبها
  const combined = [...resolved, ...direct];

  if (combined.length < 2) {
    let msg = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (details.length) msg += `\n\nتفاصيل كل معرّف فاشل:\n${details.join("\n")}`;
    throw new ToolError("merge_min", msg);
  }
  if (combined.length > 10) {
    throw new ToolError("merge_max", "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).");
  }
  const bad = combined.filter((u) => !/^https?:\/\/.+/i.test(u) || /^data:/i.test(u));
  if (bad.length) {
    throw new ToolError("params", `❌ روابط غير صالحة للدمج (يلزم روابط http/https مباشرة وعامة): ${bad.join("، ")}`);
  }
  if (!mergerConfigured()) {
    throw new ToolError("no_merger", "❌ خدمة الدمج غير مهيأة — اضبط متغير البيئة MERGER_API_BASE على رابط خدمة الدمج المنشورة ثم أعد المحاولة.");
  }

  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${combined.length} مقاطع`,
    params_json: JSON.stringify({ videos: combined }),
  });

  // إنشاء المهمة لدى الخدمة
  try {
    const jobId = await createMergeJob(combined);
    await updateTask(taskId, { provider_task_id: jobId, progress: 5 });
    await startMergeProcess(jobId);
    await updateTask(taskId, { paramsMerge: { processStartedAt: new Date().toISOString() } });
  } catch (e) {
    if (isMergerDeclaredError(e)) {
      const t = await updateTask(taskId, { status: "failed", error_message: e.message, completed: true });
      return { task: t, urls: null };
    }
    // خطأ شبكتنا نحن — المهمة تبقى processing وتُعاد مع get_task بعد تهدئة
    await updateTask(taskId, {
      error_message: `تعذر إنشاء مهمة الدمج: ${e instanceof Error ? e.message : e}`,
    });
    const t = (await getTask(taskId))!;
    return { task: t, urls: null };
  }

  // نافذة الانتظار (افتراضي 60 ثانية) مع استقصاء كل 3 ثوانٍ وبث تقدم
  const deadline = Date.now() + opts.waitSeconds * 1000;
  while (Date.now() < deadline) {
    if (cb?.signal?.aborted) break;
    await sleep(3000, cb?.signal);
    if (Date.now() >= deadline) break;
    const t = await refreshTask(taskId);
    if (!t) break;
    if (t.status === "completed" || t.status === "failed") return { task: t, urls: parseUrls(t.result_urls_json) };
    const p = Math.min(t.progress, 95);
    await cb?.onProgress?.(p, `جارٍ الدمج… ${p}%`);
  }
  const t = (await getTask(taskId))!;
  return { task: t, urls: parseUrls(t.result_urls_json) };
}

// ---------- التوليد ----------

export interface GenerationOptions {
  model?: string;
  type: "image" | "video";
  prompt: string;
  input: ProviderInput;
  waitSeconds: number;
}

export async function runGeneration(
  opts: GenerationOptions,
  cb?: RunCallbacks
): Promise<{ task: TaskRow; urls: string[] | null }> {
  // 1) وحّد اسم الموديل عبر aliases — غير معروف → خطأ معطيات فوري
  const def = resolveModel(opts.model, opts.type);
  if (!def) {
    throw new ToolError(
      "params",
      `❌ موديل غير معروف: ${opts.model}. المتاح: ${MODELS.map((m) => m.canonical).join("، ")}`
    );
  }

  // 2) تجمع المفاتيح بالترتيب التسلسلي — فارغ → رد no_keys بالرسالة المحددة
  const pool = await fetchKeyPool(def.providers);
  if (!pool.length) {
    throw new ToolError(
      "no_keys",
      `❌ لا توجد مفاتيح نشطة لخدمة ${def.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`
    );
  }

  // 3) سجّل المهمة في Turso قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: def.canonical,
    type: opts.type,
    prompt: opts.prompt,
    params_json: JSON.stringify({ input: opts.input, requestedModel: opts.model ?? def.canonical }),
    status: "processing",
  });

  // 4) جرّب المرشحين بالترتيب (قسم 4.3) حتى نجاح الإنشاء
  const d = await dispatchToPool(taskId, def, opts.input);
  if (d.paramsFailure) {
    const t = (await getTask(taskId))!;
    return { task: t, urls: null };
  }
  if (d.urls) {
    const t = (await getTask(taskId))!;
    return { task: t, urls: d.urls };
  }
  if (!d.providerTaskId) {
    // فشل الإنشاء على كل المفاتيح: تبقى processing برسالة داخلية «بانتظار توفر مفتاح صالح…»
    // وتُعاد المحاولة تلقائيًا مع كل get_task (بتهدئة ~45 ثانية)
    await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
    const t = (await getTask(taskId))!;
    return { task: t, urls: null };
  }

  // 5) نافذة الانتظار مع بث التقدم — انتهت دون نتيجة → يعاد task_id والحالة processing
  const urls = await waitForTask(taskId, opts.waitSeconds, cb);
  const t = (await getTask(taskId))!;
  return { task: t, urls };
}
