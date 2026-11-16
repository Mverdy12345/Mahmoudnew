/**
 * إخفاء المفاتيح إلزامي في كل الاستجابات والسجلات:
 * أول 7 أحرف + •••••••• + آخر 4 — وللمفاتيح القصيرة أول 3 + ••••
 */
export function maskKey(key: string): string {
  const k = String(key || "");
  if (k.length < 16) {
    return k.slice(0, 3) + "••••";
  }
  return k.slice(0, 7) + "••••••••" + k.slice(-4);
}

/** تنظيف نص الخطأ من أي مفتاح كامل قد يرد داخل الرسالة قبل تسجيله */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = String(text || "");
  for (const s of secrets) {
    if (s && s.length > 6 && out.includes(s)) {
      out = out.split(s).join(maskKey(s));
    }
  }
  return out;
}
