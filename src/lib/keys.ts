/**
 * نظام المفاتيح المتسلسلة — قلب المشروع:
 * ترتيب تسلسلي صارم بترتيب الإضافة + تصنيف موحد للأخطاء + إخفاء المفاتيح إلزامي.
 */
import type { KeyRow, ProviderId } from "./types";
import { getKeyPool, setKeyStatus, bumpKeyCounters } from "./turso";
import { maskKey } from "./mask";

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

/** نمط رسائل فشل مفتاح/رصيد في منتصف المهمة (قسم 4.3.2) */
export const KEY_BALANCE_FAIL_PATTERN =
  /insufficient|balance|credit|quota|402|401|unauthorized/i;

/**
 * تصنيف موحد لأخطاء المزودين:
 * - exhausted يُفحص قبل 400 لأن بعض المزودين يرسلون نفاد الرصيد بحالة 400
 * - disabled: مفتاح مرفوض → تعطيل تلقائي
 * - params: معطيات الطلب → توقف فورًا (تبديل المفاتيح لن يحلها)
 * - temporary: 429/5xx/شبكة → انتقل للتالي مع إبقاء المفتاح سليمًا
 */
export function classifyProviderError(e: { status?: number; message: string }): ErrorClass {
  const msg = String(e.message || "");
  const status = e.status;

  // 1) نفاد الرصيد — قبل فحص 400 عمدًا
  if (status === 402 || /insufficient|quota|balance|credit|out of credits|exhausted|充值/i.test(msg)) {
    return "exhausted";
  }
  // 2) مفتاح مرفوض
  if (status === 401 || status === 403 || /invalid api key|unauthorized|forbidden|authentication/i.test(msg)) {
    return "disabled";
  }
  // 3) الموديل غير مدعوم لدى هذا المزود
  if (/model not found|unsupported model|unknown model/i.test(msg) && (status === 400 || status === 404 || status === 422)) {
    return "provider";
  }
  // 4) معطيات الطلب
  if (status === 400 || status === 422 || status === 404) {
    return "params";
  }
  // 5) 429 و5xx والشبكة وكل ما هو غير متوقع → مؤقت
  return "temporary";
}

export { maskKey };

export function toPublicKey(k: KeyRow) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    maskedKey: maskKey(k.api_key),
    status: k.status,
    usageCount: k.usage_count,
    successCount: k.success_count,
    failCount: k.fail_count,
    lastUsedAt: k.last_used_at,
    lastError: k.last_error,
    createdAt: k.created_at,
  };
}

/**
 * تجلب تجمع المفاتيح بالترتيب التسلسلي الصارم (أول مفتاح أُضيف يُجرَّب أولًا).
 */
export function fetchKeyPool(providers: ProviderId[]) {
  return getKeyPool(providers);
}

/** تعليم المفتاح حسب تصنيف الخطأ + تحديث العدّادات دائمًا */
export async function recordKeyFailure(key: KeyRow, cls: ErrorClass, error: string): Promise<void> {
  await bumpKeyCounters(key.id, { ok: false, error });
  if (cls === "disabled" || cls === "exhausted") {
    await setKeyStatus(key.id, cls, error);
  }
}

export async function recordKeySuccess(key: KeyRow): Promise<void> {
  await bumpKeyCounters(key.id, { ok: true });
  // عند أول نجاح بعد نفاد الرصيد (مثلًا بعد شحن الحساب) يعود المفتاح تلقائيًا إلى «نشط»
  if (key.status === "exhausted") {
    await setKeyStatus(key.id, "active");
  }
}
