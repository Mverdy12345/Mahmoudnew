/**
 * طبقة قاعدة البيانات Turso (libSQL عبر HTTP) — متوافقة مع Vercel serverless
 * لأن الاتصال عبر الشبكة لا ملفات SQLite محلية.
 * الجداول تُنشأ عند أول وصول بـ CREATE TABLE IF NOT EXISTS — لا حاجة لأداة migrations.
 */
import { createClient, type Client, type InValue } from "@libsql/client";
import type {
  KeyRow,
  KeyStatus,
  MediaType,
  ProviderId,
  TaskAttempt,
  TaskProvider,
  TaskRow,
  TaskStatus,
} from "./types";

let _client: Client | null = null;

// عميل واحد مشترك — libSQL يتصل عبر HTTP مناسب للبيئات الـ serverless
export function getTurso(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("متغيرات Turso غير مضبوطة (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN)");
    }
    _client = createClient({ url, authToken: token });
  }
  return _client;
}

let schemaPromise: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await getTurso().executeMultiple(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);
    })().catch((e) => {
      schemaPromise = null; // اسمح بإعادة المحاولة في الطلب التالي
      throw e;
    });
  }
  return schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await getTurso().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ---------- المهام ----------

function mapTask(r: Record<string, unknown>): TaskRow {
  return {
    id: String(r.id),
    provider: (r.provider as TaskProvider | null) ?? null,
    provider_task_id: (r.provider_task_id as string | null) ?? null,
    key_id: (r.key_id as string | null) ?? null,
    model: String(r.model ?? ""),
    type: String(r.type) as MediaType,
    prompt: String(r.prompt ?? ""),
    params_json: String(r.params_json ?? "{}"),
    status: String(r.status) as TaskStatus,
    progress: Number(r.progress ?? 0),
    result_urls_json: (r.result_urls_json as string | null) ?? null,
    error_message: (r.error_message as string | null) ?? null,
    attempts_json: String(r.attempts_json ?? "[]"),
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
    completed_at: (r.completed_at as string | null) ?? null,
  };
}

export interface InsertTaskInput {
  id: string;
  model: string;
  type: MediaType;
  prompt: string;
  params_json?: string;
  provider?: TaskProvider | null;
  status?: TaskStatus;
}

export async function insertTask(t: InsertTaskInput): Promise<TaskRow> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status)
          VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
    args: [t.id, t.provider ?? null, t.model, t.type, t.prompt, t.params_json ?? "{}", t.status ?? "processing"],
  });
  return (await getTask(t.id))!;
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const res = await getTurso().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  if (!res.rows.length) return null;
  return mapTask(res.rows[0] as unknown as Record<string, unknown>);
}

export interface TaskPatch {
  provider?: TaskProvider | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  status?: TaskStatus;
  progress?: number;
  result_urls?: string[];
  error_message?: string | null;
  /** true → يضبط completed_at تلقائيًا عند الاكتمال */
  completed?: boolean;
  /** محاولة جديدة تُضاف إلى attempts_json */
  newAttempt?: TaskAttempt;
  /** دمج حقول إضافية داخل params_json (مثل حالة عملية الدمج) */
  paramsMerge?: Record<string, unknown>;
}

/** تحديث جزئي للمهمة مع ضبط updated_at دائمًا */
export async function updateTask(id: string, patch: TaskPatch): Promise<TaskRow> {
  const current = await getTask(id);
  if (!current) throw new Error(`المهمة غير موجودة: ${id}`);

  const sets: string[] = [];
  const args: InValue[] = [];

  const simple: Array<[keyof TaskPatch, string]> = [
    ["provider", "provider"],
    ["provider_task_id", "provider_task_id"],
    ["key_id", "key_id"],
    ["status", "status"],
    ["progress", "progress"],
    ["error_message", "error_message"],
  ];
  for (const [key, col] of simple) {
    const v = patch[key];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      args.push(v as InValue);
    }
  }
  if (patch.result_urls !== undefined) {
    sets.push("result_urls_json = ?");
    args.push(JSON.stringify(patch.result_urls));
  }
  if (patch.completed) {
    sets.push("completed_at = datetime('now')");
    sets.push("progress = 100");
  }
  if (patch.newAttempt) {
    let attempts: TaskAttempt[] = [];
    try {
      attempts = JSON.parse(current.attempts_json || "[]");
      if (!Array.isArray(attempts)) attempts = [];
    } catch {
      attempts = [];
    }
    attempts.push(patch.newAttempt);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(attempts.slice(-50))); // حد أقصى معقول لسجل المحاولات
  }
  if (patch.paramsMerge) {
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(current.params_json || "{}");
    } catch {
      params = {};
    }
    params = { ...params, ...patch.paramsMerge };
    sets.push("params_json = ?");
    args.push(JSON.stringify(params));
  }
  sets.push("updated_at = datetime('now')");

  await getTurso().execute({
    sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
    args: [...args, id],
  });
  return (await getTask(id))!;
}

export async function listRecentTasks(
  limit: number,
  filters?: { type?: MediaType; status?: TaskStatus }
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filters?.type) {
    where.push("type = ?");
    args.push(filters.type);
  }
  if (filters?.status) {
    if (filters.status === "processing") {
      where.push("(status = 'processing' OR status = 'pending')");
    } else {
      where.push("status = ?");
      args.push(filters.status);
    }
  }
  args.push(Math.min(Math.max(limit, 1), 50));
  const res = await getTurso().execute({
    sql: `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY created_at DESC, id DESC LIMIT ?`,
    args,
  });
  return res.rows.map((r) => mapTask(r as unknown as Record<string, unknown>));
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const res = await getTurso().execute(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status IN ('processing', 'pending') THEN 1 ELSE 0 END) AS processing
    FROM tasks
  `);
  const r = res.rows[0] as unknown as Record<string, unknown>;
  return {
    total: Number(r.total ?? 0),
    completed: Number(r.completed ?? 0),
    failed: Number(r.failed ?? 0),
    processing: Number(r.processing ?? 0),
  };
}

// ---------- المفاتيح ----------

function mapKey(r: Record<string, unknown>): KeyRow {
  return {
    id: String(r.id),
    provider: String(r.provider) as ProviderId,
    label: String(r.label ?? ""),
    api_key: String(r.api_key),
    status: String(r.status ?? "active") as KeyStatus,
    usage_count: Number(r.usage_count ?? 0),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    last_used_at: (r.last_used_at as string | null) ?? null,
    last_checked_at: (r.last_checked_at as string | null) ?? null,
    last_error: (r.last_error as string | null) ?? null,
    created_at: String(r.created_at ?? ""),
  };
}

export async function insertKey(k: {
  id: string;
  provider: ProviderId;
  label: string;
  api_key: string;
}): Promise<KeyRow> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [k.id, k.provider, k.label, k.api_key],
  });
  return (await getKeyById(k.id))!;
}

export async function getKeyById(id: string): Promise<KeyRow | null> {
  await ensureSchema();
  const res = await getTurso().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  if (!res.rows.length) return null;
  return mapKey(res.rows[0] as unknown as Record<string, unknown>);
}

export async function listKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const res = await getTurso().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return res.rows.map((r) => mapKey(r as unknown as Record<string, unknown>));
}

export async function findDuplicateKey(provider: string, apiKey: string): Promise<boolean> {
  await ensureSchema();
  const res = await getTurso().execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  return res.rows.length > 0;
}

export async function setKeyStatus(
  id: string,
  status: KeyStatus,
  lastError?: string | null
): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `UPDATE api_keys SET status = ?, last_error = COALESCE(?, last_error), last_checked_at = datetime('now') WHERE id = ?`,
    args: [status, lastError ?? null, id],
  });
}

export async function bumpKeyCounters(
  id: string,
  r: { ok: boolean; error?: string | null }
): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = datetime('now'),
            last_checked_at = datetime('now'),
            last_error = ?
          WHERE id = ?`,
    args: [r.ok ? 1 : 0, r.ok ? 0 : 1, r.error ?? null, id],
  });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

/**
 * تجمع المفاتيح بهذا الترتيب بالضبط: أقدم مفتاح أُضيف أولًا (ترتيب تسلسلي صارم)
 * ليس round-robin وليس «الأقل استخدامًا أولًا». المستنزف (exhausted) يبقى في القائمة،
 * والاستثناء الوحيد هو التعطيل اليدوي (disabled).
 */
export async function getKeyPool(providers: string[]): Promise<KeyRow[]> {
  await ensureSchema();
  if (!providers.length) return [];
  const placeholders = providers.map(() => "?").join(", ");
  const res = await getTurso().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return res.rows.map((r) => mapKey(r as unknown as Record<string, unknown>));
}
