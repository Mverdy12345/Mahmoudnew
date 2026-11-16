/**
 * عميل خدمة دمج الفيديو v2 — بلا مفاتيح أو توثيق، روابط فقط ولا تنزيل أي وسائط.
 * العنوان من MERGER_API_BASE. المخرجات MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18.
 * القيود: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية، والحذف بعد 24 ساعة.
 */
const BASE = () => (process.env.MERGER_API_BASE || "").trim().replace(/\/+$/, "");

export function mergerConfigured(): boolean {
  const b = BASE();
  return b.length > 0 && /^https?:\/\//i.test(b) && !/xxxx/i.test(b);
}

/** خطأ معلن من خدمة الدمج (HTTP 4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة */
export class MergerFail extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergerFail";
  }
}

/** 404 من الخدمة: المهمة حُذفت أو انتهت صلاحيتها */
export class MergerGone extends Error {
  constructor() {
    super("مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
    this.name = "MergerGone";
  }
}

interface MergerResponse {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
}

async function req(path: string, init?: RequestInit, timeoutMs = 20000): Promise<MergerResponse> {
  let res: Response;
  try {
    res = await fetch(`${BASE()}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // أخطاء شبكتنا نحن — مؤقتة ويُسمح بالاستمرار بالاستعلام
    throw new Error(`تعذر الاتصال بخدمة الدمج: ${e instanceof Error ? e.message : e}`);
  }
  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

export function isMergerDeclaredError(e: unknown): boolean {
  return e instanceof MergerFail || e instanceof MergerGone;
}

export async function createMergeJob(videos: string[]): Promise<string> {
  const r = await req("/api/jobs", { method: "POST", body: JSON.stringify({ videos }) });
  const data = r.data as { jobId?: string; error?: string } | null;
  if (!r.ok || !data?.jobId) {
    // أي خطأ معلن من الخدمة عند الإنشاء = فشل نهائي (روابط تالفة مثلًا)
    throw new MergerFail(String(data?.error || `HTTP ${r.status}`));
  }
  return String(data.jobId);
}

/** قفل في الذاكرة حتى لا يتزامن استدعاء process مع get_task (مرة واحدة فقط لكل مهمة) */
const processInFlight = new Set<string>();

export function isProcessInFlight(jobId: string): boolean {
  return processInFlight.has(jobId);
}

/** إطلاق process خلفيًا وبمرة واحدة فقط — النتيجة تُقرأ لاحقًا من GET /api/jobs/{id} */
export function startMergeProcess(jobId: string): void {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  void req(
    `/api/jobs/${jobId}/process`,
    { method: "POST" },
    330000 // العملية نفسها قد تستغرق دقائق — الخدمة تحدّث التقدم في قاعدة بياناتها
  )
    .catch(() => {
      /* خطأ الشبكة هنا لا ينهي المهمة — الاستقصاء على GET يكشف الحالة لاحقًا */
    })
    .finally(() => {
      processInFlight.delete(jobId);
    });
}

const DONE = /^(done|completed|complete|success|succeeded|finished)$/i;
const FAILED = /^(error|failed|failure|cancelled|canceled)$/i;

export interface MergerJobStatus {
  status: string;
  done: boolean;
  failed: boolean;
  progress?: number;
  videoUrl?: string;
  error?: string;
}

/** progress يأتي أحيانًا كسرًا 0..1 → اضربه في 100 */
function normalizeProgress(p: unknown): number | undefined {
  if (typeof p !== "number" || !isFinite(p) || p < 0) return undefined;
  return p <= 1 ? Math.round(p * 100) : Math.round(Math.min(p, 100));
}

export async function getMergeJob(jobId: string): Promise<MergerJobStatus> {
  const r = await req(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (r.status === 404) throw new MergerGone();
  const d = r.data as
    | { status?: string; progress?: number; videoUrl?: string; downloadUrl?: string; error?: string }
    | null;
  if (!r.ok) {
    // انتبه: قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا (فشل نهائي معلن)
    const msg = String(d?.error || `HTTP ${r.status}`);
    throw new MergerFail(msg);
  }
  const rawStatus = String(d?.status || (d?.error ? "failed" : "")).toLowerCase();
  const failed = FAILED.test(rawStatus) || (!!d?.error && !DONE.test(rawStatus));
  // رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط رابط البث المباشر
  const videoUrl =
    (d?.videoUrl as string) ||
    (d?.downloadUrl as string) ||
    (jobId ? `${BASE()}/api/jobs/${jobId}/video` : undefined);
  return {
    status: rawStatus,
    done: DONE.test(rawStatus),
    failed,
    progress: normalizeProgress(d?.progress),
    videoUrl: videoUrl || undefined,
    error: d?.error ? String(d.error) : undefined,
  };
}

export function mergerBase(): string {
  return BASE();
}
