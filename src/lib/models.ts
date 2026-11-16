/**
 * سجل الموديلات — الموديلان المدمجان مثبتان كما هما مع قبول الصيغ البديلة بالنقاط
 * (نوحّد gpt-image-2.6 → gpt-image-2-6 وغيرها)، وأسماء الموديلات لدى كل مزود
 * قابلة للتجاوز بمتغيرات البيئة.
 */
import type { MediaType, ProviderId } from "./types";

export interface ModelDef {
  /** الاسم كما يراه عميل MCP */
  canonical: string;
  /** صيغ بديلة نقبلها ونوحدّها */
  aliases: string[];
  type: MediaType;
  /** المزودون القادرون على خدمته — تُجرَّب مفاتيحهم كلها بالترتيب */
  providers: ProviderId[];
  /** اسم الموديل كما يُرسل لكل مزود */
  providerModel: Record<ProviderId, string>;
}

const KIE_IMAGE = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const COMETAPI_IMAGE = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const KIE_VIDEO = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
// وفق التوثيق المقاس لـ CometAPI: نقطة grok تقبل الموديل باسم grok-imagine-video-1.5
// (قابل للتجاوز بمتغير البيئة COMETAPI_VIDEO_MODEL)
const COMETAPI_VIDEO = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1.5";

/** توحيد الاسم: استبدال النقاط بشرطات لمطابقة الصيغ البديلة */
export function normalizeModelName(name: string): string {
  return name.trim().replace(/\./g, "-");
}

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: [
      "gpt-image-2-6/flare-text-to-image",
      "gpt-image-2.6/flare-text-to-image",
      normalizeModelName(KIE_IMAGE),
    ],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE, cometapi: COMETAPI_IMAGE },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: [
      "grok-imagine-video-1-5-preview",
      "grok-imagine-video-1.5-preview",
      normalizeModelName(KIE_VIDEO),
    ],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO, cometapi: COMETAPI_VIDEO },
  },
];

export function resolveModel(name: string | undefined, type: MediaType): ModelDef | null {
  const fallback = type === "image" ? MODELS[0] : MODELS[1];
  const target = name ? normalizeModelName(name) : fallback.canonical;
  return (
    MODELS.find(
      (m) =>
        m.type === type &&
        (normalizeModelName(m.canonical) === target ||
          m.aliases.some((a) => normalizeModelName(a) === target))
    ) ?? null
  );
}

/** شكل الموديلات في /api/health */
export function healthModels() {
  return MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers }));
}
