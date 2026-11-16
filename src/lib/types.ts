// أنواع مشتركة للمشروع كله — أسماء الحقول مطابقة لمخطط قاعدة البيانات حرفيًا
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type KeyStatus = "active" | "exhausted" | "disabled";

export interface TaskRow {
  id: string;
  provider: TaskProvider | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: MediaType;
  prompt: string;
  params_json: string;
  status: TaskStatus;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskAttempt {
  provider?: string;
  keyId?: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface KeyRow {
  id: string;
  provider: ProviderId;
  label: string;
  api_key: string;
  status: KeyStatus;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface PublicTask {
  id: string;
  provider: string | null;
  model: string;
  type: MediaType;
  status: TaskStatus;
  progress: number;
  prompt: string;
  resultUrls: string[];
  error: string | null;
  attemptsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicKey {
  id: string;
  provider: ProviderId;
  label: string;
  maskedKey: string;
  status: KeyStatus;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}
