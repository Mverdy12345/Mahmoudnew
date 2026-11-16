/** واجهة المزودات الموحدة — أي خطأ يُرمى كـ ProviderError ليُصنَّف في طبقة المفاتيح */
import type { ProviderId } from "../types";

export interface ProviderInput {
  prompt: string;
  /** رابط صورة عامة كإطار أول (image-to-video) */
  image_url?: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  /** مدة الفيديو بالثواني */
  duration?: number;
  /** الصوت مولَّد دائمًا مع grok-imagine-video — لا يُرسل للمزود */
  enable_audio?: boolean;
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export class ProviderError extends Error {
  constructor(
    public status: number | undefined,
    message: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ProviderAdapter {
  id: ProviderId;
  /** مهمة غير متزامنة: تعيد providerTaskId */
  createTask(key: string, model: string, input: ProviderInput): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (تعيد النتيجة فورًا) */
  createImageSync?(key: string, model: string, input: ProviderInput): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(key: string, providerTaskId: string): Promise<CheckResult>;
}
