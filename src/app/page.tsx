"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ================= الأنواع =================
interface HealthInfo {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: Array<{ canonical: string; type: string; providers: string[] }>;
  merger: { base: string | null; healthy: boolean };
  authRequired: boolean;
}
interface KeyItem {
  id: string;
  provider: string;
  label: string;
  maskedKey: string;
  status: string;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}
interface TaskItem {
  id: string;
  provider: string | null;
  model: string;
  type: string;
  status: string;
  progress: number;
  prompt: string;
  resultUrls: string[];
  error: string | null;
  attemptsCount: number;
  createdAt: string;
  updatedAt: string;
}
interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

// ================= أدوات مساعدة =================
const KEY_STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: "نشط", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30" },
  exhausted: { label: "مستنزف", cls: "bg-amber-500/15 text-amber-300 border-amber-400/30" },
  disabled: { label: "معطّل", cls: "bg-slate-500/15 text-slate-300 border-slate-400/30" },
};
const TASK_STATUS: Record<string, { label: string; cls: string }> = {
  completed: { label: "مكتملة", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30" },
  failed: { label: "فاشلة", cls: "bg-red-500/15 text-red-300 border-red-400/30" },
  processing: { label: "جارية", cls: "bg-cyan-500/15 text-cyan-300 border-cyan-400/30" },
  pending: { label: "بالانتظار", cls: "bg-slate-500/15 text-slate-300 border-slate-400/30" },
};
const TYPE_LABEL: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };

function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("ar", { dateStyle: "short", timeStyle: "short" });
}

function CopyButton({ text, small = false }: { text: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button
      type="button"
      onClick={copy}
      size="sm"
      variant={copied ? "default" : "outline"}
      className={
        (small ? "h-7 px-2 text-xs " : "h-8 px-3 text-sm ") +
        (copied
          ? "bg-emerald-600 hover:bg-emerald-500 text-white"
          : "border-slate-600 bg-slate-800/60 text-slate-200 hover:bg-slate-700 hover:text-white")
      }
    >
      {copied ? "تم النسخ" : "نسخ"}
    </Button>
  );
}

const TOOLS_INFO: Array<{ name: string; desc: string }> = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي مع تبديل تلقائي بين كل المفاتيح النشطة." },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي (حوار/مؤثرات) مع image-to-video اختياري." },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد عالي الجودة بالترتيب المعطى." },
  { name: "get_task", desc: "متابعة أي مهمة (توليد أو دمج) بمعرّفها حتى الاكتمال." },
  { name: "list_media", desc: "استرجاع أحدث الصور/الفيديوهات/الدمجات المخزنة بروابطها." },
];

// ================= الصفحة =================
export default function Home() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [formMsg, setFormMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState("");

  const loadKeys = useCallback(async () => {
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      const data = await res.json();
      if (Array.isArray(data.keys)) setKeys(data.keys);
    } catch {
      /* تجاهل */
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const data = await res.json();
      if (Array.isArray(data.tasks)) setTasks(data.tasks);
      if (data.stats) setStats(data.stats);
    } catch {
      /* تجاهل */
    }
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      setHealth(await res.json());
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    loadKeys();
    loadTasks();
    loadHealth();
    const t1 = setInterval(loadTasks, 5000); // لوحة المهام تتحدث تلقائيًا كل ~5 ثوانٍ
    const t2 = setInterval(loadHealth, 30000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [loadKeys, loadTasks, loadHealth]);

  const addKey = async () => {
    setFormMsg(null);
    if (!apiKey.trim()) {
      setFormMsg({ kind: "err", text: "أدخل مفتاح API أولًا" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormMsg({ kind: "err", text: data.error || "فشل إضافة المفتاح" });
      } else {
        setFormMsg({ kind: "ok", text: "تمت إضافة المفتاح بنجاح" });
        setApiKey("");
        setLabel("");
        await loadKeys();
      }
    } catch {
      setFormMsg({ kind: "err", text: "تعذر الاتصال بالخادم" });
    }
    setBusy(false);
  };

  const toggleKey = async (k: KeyItem) => {
    const action = k.status === "disabled" ? "enable" : "disable";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    await loadKeys();
  };

  const deleteKey = async (k: KeyItem) => {
    if (!window.confirm(`حذف المفتاح ${k.maskedKey}؟`)) return;
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    await loadKeys();
  };

  const mcpUrl = `${origin}/mcp`;
  const authJson = health?.authRequired
    ? `,\n        "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }`
    : "";
  const jsonChatGPT = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${authJson}\n    }\n  }\n}`;
  const jsonClaude = `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${authJson}\n    }\n  }\n}`;
  const jsonCursor = jsonChatGPT;

  const dbBadge = health
    ? health.ok
      ? { text: "Turso متصل", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30" }
      : { text: "Turso غير متصل", cls: "bg-red-500/15 text-red-300 border-red-400/30" }
    : { text: "جارٍ الفحص…", cls: "bg-slate-500/15 text-slate-300 border-slate-400/30" };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        {/* ============ الترويسة ============ */}
        <header className="mb-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="bg-gradient-to-l from-cyan-400 to-violet-400 bg-clip-text text-3xl font-extrabold text-transparent">
                MCP Media Generator
              </h1>
              <p className="mt-1 text-sm text-slate-400">
                خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — مع تبديل تسلسلي تلقائي بين مفاتيح API
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${dbBadge.cls}`}>
                <span className="h-2 w-2 rounded-full bg-current" />
                {dbBadge.text}
              </span>
              {health?.merger && (
                <span
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${
                    health.merger.healthy
                      ? "bg-emerald-500/15 text-emerald-300 border-emerald-400/30"
                      : "bg-amber-500/15 text-amber-300 border-amber-400/30"
                  }`}
                >
                  <span className="h-2 w-2 rounded-full bg-current" />
                  خدمة الدمج {health.merger.healthy ? "جاهزة" : "غير مهيأة"}
                </span>
              )}
            </div>
          </div>
        </header>

        <main className="space-y-6">
          {/* ============ أ) مدير المفاتيح ============ */}
          <div className="grid gap-6 lg:grid-cols-5">
            <Card className="border-slate-800 bg-slate-900/70 backdrop-blur lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg text-cyan-300">
                  <span className="inline-block h-2 w-2 rounded-full bg-cyan-400" />
                  مدير المفاتيح
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Select value={provider} onValueChange={setProvider}>
                    <SelectTrigger className="border-slate-700 bg-slate-800/60 text-slate-100">
                      <SelectValue placeholder="المزود" />
                    </SelectTrigger>
                    <SelectContent className="border-slate-700 bg-slate-900 text-slate-100">
                      <SelectItem value="kie">kie.ai</SelectItem>
                      <SelectItem value="cometapi">CometAPI</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="تسمية اختيارية"
                    className="border-slate-700 bg-slate-800/60 text-slate-100 placeholder:text-slate-500"
                  />
                </div>
                <div className="flex gap-2">
                  <Input
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="مفتاح API"
                    type="password"
                    dir="ltr"
                    className="flex-1 border-slate-700 bg-slate-800/60 text-left font-mono text-sm text-slate-100 placeholder:text-slate-500"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void addKey();
                    }}
                  />
                  <Button
                    onClick={addKey}
                    disabled={busy}
                    className="bg-cyan-600 text-white hover:bg-cyan-500"
                  >
                    {busy ? "…" : "إضافة"}
                  </Button>
                </div>
                {formMsg && (
                  <p className={`text-xs ${formMsg.kind === "ok" ? "text-emerald-300" : "text-red-300"}`}>
                    {formMsg.text}
                  </p>
                )}

                <p className="rounded-lg border border-slate-800 bg-slate-800/40 p-3 text-xs leading-6 text-slate-400">
                  أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند
                  أي خطأ أو نفاد رصيد دون توقف.
                </p>

                <div className="max-h-96 space-y-2 overflow-y-auto pr-1 nice-scroll">
                  {keys.length === 0 && (
                    <p className="py-6 text-center text-sm text-slate-500">لا توجد مفاتيح بعد — أضف أول مفتاح</p>
                  )}
                  {keys.map((k) => {
                    const st = KEY_STATUS[k.status] ?? KEY_STATUS.active;
                    return (
                      <div key={k.id} className="rounded-lg border border-slate-800 bg-slate-800/40 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="border-violet-400/30 bg-violet-500/15 text-[11px] text-violet-300">
                              {k.provider === "kie" ? "kie.ai" : "CometAPI"}
                            </Badge>
                            <code dir="ltr" className="font-mono text-xs text-slate-300">
                              {k.maskedKey}
                            </code>
                          </div>
                          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${st.cls}`}>
                            {st.label}
                          </span>
                        </div>
                        {k.label && <p className="mt-1 text-xs text-slate-400">التسمية: {k.label}</p>}
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
                          <span>استخدام: <b className="text-slate-200">{k.usageCount}</b></span>
                          <span>نجاح: <b className="text-emerald-300">{k.successCount}</b></span>
                          <span>فشل: <b className="text-red-300">{k.failCount}</b></span>
                          <span>آخر استخدام: {fmtDate(k.lastUsedAt)}</span>
                        </div>
                        {k.lastError && (
                          <p dir="ltr" className="mt-1 truncate text-left text-[11px] text-red-300/80" title={k.lastError}>
                            {k.lastError}
                          </p>
                        )}
                        <div className="mt-2 flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void toggleKey(k)}
                            className="h-7 border-slate-600 bg-slate-800/60 px-2 text-xs text-slate-200 hover:bg-slate-700"
                          >
                            {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void deleteKey(k)}
                            className="h-7 border-red-500/40 bg-red-500/10 px-2 text-xs text-red-300 hover:bg-red-500/20"
                          >
                            حذف
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {/* ============ ب) لوحة المهام ============ */}
            <Card className="border-slate-800 bg-slate-900/70 backdrop-blur lg:col-span-3">
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-lg text-violet-300">
                  <span className="flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full bg-violet-400" />
                    لوحة المهام
                  </span>
                  <span className="flex gap-2 text-xs font-normal">
                    <Badge className="bg-slate-800 text-slate-200">الإجمالي: {stats.total}</Badge>
                    <Badge className="bg-emerald-500/15 text-emerald-300">مكتملة: {stats.completed}</Badge>
                    <Badge className="bg-red-500/15 text-red-300">فاشلة: {stats.failed}</Badge>
                    <Badge className="bg-cyan-500/15 text-cyan-300">جارية: {stats.processing}</Badge>
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="max-h-[34rem] space-y-2 overflow-y-auto pr-1 nice-scroll">
                  {tasks.length === 0 && (
                    <p className="py-10 text-center text-sm text-slate-500">
                      لا توجد مهام بعد — استدعِ generate_image أو generate_video من عميل MCP
                    </p>
                  )}
                  {tasks.map((t) => {
                    const st = TASK_STATUS[t.status] ?? TASK_STATUS.pending;
                    return (
                      <div key={t.id} className="rounded-lg border border-slate-800 bg-slate-800/40 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-md bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-slate-300">
                              {TYPE_LABEL[t.type] ?? t.type}
                            </span>
                            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${st.cls}`}>
                              {st.label}
                            </span>
                            <code dir="ltr" className="font-mono text-[10px] text-slate-500">
                              {t.model}
                            </code>
                            {t.attemptsCount > 0 && (
                              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
                                المحاولات: {t.attemptsCount}
                              </span>
                            )}
                          </div>
                          <span className="text-[11px] text-slate-500">{fmtDate(t.createdAt)}</span>
                        </div>
                        {t.prompt && <p className="mt-1.5 text-xs text-slate-400">{t.prompt}</p>}
                        {t.status === "processing" && (
                          <div className="mt-2 flex items-center gap-2">
                            <Progress value={Math.min(t.progress, 100)} className="h-1.5 flex-1 bg-slate-800" />
                            <span className="text-[11px] text-cyan-300">{Math.min(t.progress, 99)}%</span>
                          </div>
                        )}
                        {t.resultUrls.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {t.resultUrls.map((u, i) => (
                              <a
                                key={i}
                                href={u}
                                target="_blank"
                                rel="noreferrer"
                                className="rounded-md bg-cyan-600/20 px-2 py-1 text-[11px] text-cyan-300 underline-offset-2 hover:underline"
                              >
                                فتح النتيجة {t.resultUrls.length > 1 ? i + 1 : ""}
                              </a>
                            ))}
                          </div>
                        )}
                        {t.status === "failed" && t.error && (
                          <p className="mt-1.5 text-[11px] text-red-300/90">{t.error}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ============ ج) ربط السيرفر ============ */}
          <Card className="border-slate-800 bg-slate-900/70 backdrop-blur">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg text-cyan-300">
                <span className="inline-block h-2 w-2 rounded-full bg-cyan-400" />
                ربط السيرفر
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  readOnly
                  dir="ltr"
                  value={mcpUrl}
                  className="max-w-md flex-1 border-slate-700 bg-slate-800/60 text-left font-mono text-sm text-slate-100"
                />
                <CopyButton text={mcpUrl} />
              </div>

              <Tabs defaultValue="chatgpt" dir="rtl">
                <TabsList className="bg-slate-800/60 text-slate-300">
                  <TabsTrigger value="chatgpt">ChatGPT / GPT Agents</TabsTrigger>
                  <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
                  <TabsTrigger value="cursor">Cursor / Windsurf / Cline</TabsTrigger>
                </TabsList>
                <TabsContent value="chatgpt" className="space-y-2">
                  <p className="text-xs leading-6 text-slate-400">
                    في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».
                  </p>
                  <div className="relative">
                    <pre dir="ltr" className="max-h-52 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-left font-mono text-xs leading-5 text-slate-300">
                      {jsonChatGPT}
                    </pre>
                    <div className="absolute left-2 top-2">
                      <CopyButton text={jsonChatGPT} small />
                    </div>
                  </div>
                </TabsContent>
                <TabsContent value="claude" className="space-y-2">
                  <p className="text-xs leading-6 text-slate-400">
                    ضع هذا في ملف <code dir="ltr" className="font-mono">claude_desktop_config.json</code> ثم أعد تشغيل التطبيق.
                  </p>
                  <div className="relative">
                    <pre dir="ltr" className="max-h-52 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-left font-mono text-xs leading-5 text-slate-300">
                      {jsonClaude}
                    </pre>
                    <div className="absolute left-2 top-2">
                      <CopyButton text={jsonClaude} small />
                    </div>
                  </div>
                </TabsContent>
                <TabsContent value="cursor" className="space-y-2">
                  <p className="text-xs leading-6 text-slate-400">
                    ضع هذا في ملف <code dir="ltr" className="font-mono">mcp.json</code> (Cursor / Windsurf / Cline).
                  </p>
                  <div className="relative">
                    <pre dir="ltr" className="max-h-52 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-left font-mono text-xs leading-5 text-slate-300">
                      {jsonCursor}
                    </pre>
                    <div className="absolute left-2 top-2">
                      <CopyButton text={jsonCursor} small />
                    </div>
                  </div>
                </TabsContent>
              </Tabs>

              <div className="flex flex-wrap gap-2">
                {TOOLS_INFO.map((tool) => (
                  <div
                    key={tool.name}
                    className="max-w-xs rounded-lg border border-slate-800 bg-slate-800/40 px-3 py-2"
                    title={tool.desc}
                  >
                    <code dir="ltr" className="font-mono text-[11px] text-violet-300">
                      {tool.name}
                    </code>
                    <p className="mt-0.5 text-[11px] leading-5 text-slate-400">{tool.desc}</p>
                  </div>
                ))}
              </div>

              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-6 text-amber-200">
                الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال
                المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا
                تنقطع العملية.
              </p>
            </CardContent>
          </Card>
        </main>

        <footer className="mt-10 pb-6 text-center text-xs text-slate-600">
          MCP Media Generator — روابط فقط، لا تنزيل للوسائط · مفاتيح مخفية دائمًا · تبديل تسلسلي صامت
        </footer>
      </div>

      <style jsx global>{`
        .nice-scroll::-webkit-scrollbar {
          width: 8px;
        }
        .nice-scroll::-webkit-scrollbar-track {
          background: rgba(15, 23, 42, 0.5);
          border-radius: 8px;
        }
        .nice-scroll::-webkit-scrollbar-thumb {
          background: rgba(71, 85, 105, 0.6);
          border-radius: 8px;
        }
        .nice-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(100, 116, 139, 0.8);
        }
      `}</style>
    </div>
  );
}
