/**
 * ناقل MCP متوافق مع Web Standards لـ Next.js App Router:
 * ينفذ بروتوكول Streamable HTTP (POST لرسائل JSON-RPC) بوضع عديم الجلسة
 * — الآمن لبيئة Vercel serverless حيث لا ذاكرة مشتركة بين الاستدعاءات.
 * يدعم الردود عبر SSE لبث progress notifications أثناء نافذة الانتظار،
 * أو JSON صريح إذا لم يطلب العميل text/event-stream.
 */
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer, KNOWN_TOOLS } from "./tools";

interface IncomingJSONRPC {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** ناقل مصغّر: يمرر رسائل الخادم الصادرة إلى دالة الوجهة التي تحددها طبقة HTTP */
class WebServerTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JSONRPCMessage) => void) | undefined;
  sessionId?: string | undefined;

  private closed = false;
  constructor(private readonly sendFn: (msg: JSONRPCMessage) => void) {}

  async start(): Promise<void> {
    /* لا تهيئة مطلوبة */
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.closed) this.sendFn(message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

function isRequest(m: IncomingJSONRPC): boolean {
  return typeof m.method === "string" && m.id !== undefined && m.id !== null;
}

function baseHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache, no-transform",
  };
}

function checkAuth(request: Request): Response | null {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return null;
  const header = request.headers.get("authorization") || "";
  if (header !== `Bearer ${token}`) {
    return new Response(
      JSON.stringify({ error: "غير مصرّح — يلزم ترويسة Authorization: Bearer <MCP_ACCESS_TOKEN>" }),
      { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer", ...baseHeaders() } }
    );
  }
  return null;
}

export async function handleMcpPost(request: Request): Promise<Response> {
  const unauthorized = checkAuth(request);
  if (unauthorized) return unauthorized;

  const accept = request.headers.get("accept") ?? "";
  if (!accept.includes("application/json") && !accept.includes("text/event-stream")) {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Not Acceptable" } }),
      { status: 406, headers: { "Content-Type": "application/json", ...baseHeaders() } }
    );
  }

  const raw = await request.text();
  let msgs: IncomingJSONRPC[];
  let wasArray = false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    wasArray = Array.isArray(parsed);
    msgs = (wasArray ? parsed : [parsed]) as IncomingJSONRPC[];
    if (!msgs.length || msgs.some((m) => !m || typeof m !== "object" || m.jsonrpc !== "2.0")) {
      throw new Error("invalid");
    }
  } catch {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
      { status: 400, headers: { "Content-Type": "application/json", ...baseHeaders() } }
    );
  }

  const jsonMode = !accept.includes("text/event-stream");

  // اعتراض الأدوات المجهولة قبل الخادم — برسالة عربية حرفية كما تقتضي المواصفة
  const directResponses: JSONRPCMessage[] = [];
  const pendingIds = new Set<string | number>();
  const toDispatch: IncomingJSONRPC[] = [];
  for (const m of msgs) {
    if (isRequest(m)) {
      const id = m.id as string | number;
      const name = String((m.params as { name?: string } | undefined)?.name ?? "");
      if (m.method === "tools/call" && !KNOWN_TOOLS.has(name)) {
        directResponses.push({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: `❌ أداة غير معروفة: ${name}. المتاح: ${[...KNOWN_TOOLS].join("، ")}`,
          },
        } as JSONRPCMessage);
        continue;
      }
      // رسائل رفض الدمج بالعربية قبل تحقق المخطط (قسم 8 من المواصفة)
      if (m.method === "tools/call" && name === "merge_videos") {
        const args = ((m.params as { arguments?: Record<string, unknown> } | undefined)?.arguments ??
          {}) as { urls?: unknown[]; task_ids?: unknown[] };
        const urlsCount = Array.isArray(args.urls) ? args.urls.length : 0;
        const taskIdsCount = Array.isArray(args.task_ids) ? args.task_ids.length : 0;
        const total = urlsCount + taskIdsCount;
        if (total < 2) {
          directResponses.push({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message:
                "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
            },
          } as JSONRPCMessage);
          continue;
        }
        if (total > 10) {
          directResponses.push({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).",
            },
          } as JSONRPCMessage);
          continue;
        }
      }
      pendingIds.add(id);
    }
    toDispatch.push(m);
  }

  // خادم وناقل جديد لكل طلب — آمن تمامًا في بيئة serverless
  const server = buildMcpServer(request.signal);
  const cleanup = () => {
    void server.close().catch(() => undefined);
  };
  // إيقاف العمل عند انقطاع العميل (نفس task_id يُستأنف لاحقًا عبر get_task)
  request.signal.addEventListener("abort", cleanup, { once: true });

  // إشعارات فقط (مثل notifications/initialized) → 202 Accepted بلا جسم حسب المواصفة
  if (pendingIds.size === 0 && directResponses.length === 0) {
    if (toDispatch.length) {
      const transport = new WebServerTransport(() => {});
      await server.connect(transport);
      for (const m of toDispatch) transport.onmessage?.(m as unknown as JSONRPCMessage);
    }
    cleanup();
    return new Response(null, { status: 202, headers: baseHeaders() });
  }

  if (jsonMode) {
    // وضع JSON: تجميع الردود وترك الإشعارات (التقدم لا يمكن بثه هنا)
    const responses: JSONRPCMessage[] = [...directResponses];
    let done = pendingIds.size === 0;
    let resolveAll!: () => void;
    const allDone = new Promise<void>((r) => {
      resolveAll = r;
      if (done) r();
    });
    const maybeDone = () => {
      if (!done && pendingIds.size === 0) {
        done = true;
        resolveAll();
      }
    };

    const transport = new WebServerTransport((msg) => {
      responses.push(msg);
      const id = (msg as { id?: string | number }).id;
      if (id !== undefined && pendingIds.has(id)) {
        pendingIds.delete(id);
        maybeDone();
      }
    });
    await server.connect(transport);
    for (const m of toDispatch) transport.onmessage?.(m as unknown as JSONRPCMessage);

    // مهلة قصوى سخية (النوافذ القصوى 240 ثانية) — ثم نعيد ما وصل
    await Promise.race([allDone, new Promise<void>((r) => setTimeout(r, 290000))]);
    cleanup();

    const body = !wasArray && responses.length === 1 ? responses[0] : responses;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json", ...baseHeaders() },
    });
  }

  // ---------- وضع SSE: بث حي للإشعارات (التقدم) ثم الردود ثم الإغلاق ----------
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let sseClosed = false;

  const write = (s: string) => {
    if (sseClosed || !controllerRef) return;
    try {
      controllerRef.enqueue(encoder.encode(s));
    } catch {
      sseClosed = true;
    }
  };
  const closeSse = () => {
    if (sseClosed) return;
    sseClosed = true;
    try {
      controllerRef?.close();
    } catch {
      /* أُغلق مسبقًا */
    }
    cleanup();
  };

  const transport = new WebServerTransport((msg) => {
    write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
    const id = (msg as { id?: string | number }).id;
    if (id !== undefined && pendingIds.has(id)) {
      pendingIds.delete(id);
      if (pendingIds.size === 0) closeSse();
    }
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      // رسالة تعليق فورية لضمان إرسال الترويسات قبل أي انتظار
      write(": stream-open\n\n");
      for (const m of directResponses) {
        write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
      }
      void (async () => {
        try {
          await server.connect(transport);
          for (const m of toDispatch) transport.onmessage?.(m as unknown as JSONRPCMessage);
          if (pendingIds.size === 0) closeSse();
        } catch {
          write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32603, message: "Internal error" },
            })}\n\n`
          );
          closeSse();
        }
      })();
    },
    cancel() {
      sseClosed = true;
      cleanup();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      ...baseHeaders(),
      "X-Accel-Buffering": "no",
    },
  });
}

export function handleMcpGet(request: Request): Response {
  const unauthorized = checkAuth(request);
  if (unauthorized) return unauthorized;
  // لا نقدم قناة GET للاستماع — 405 مسموح حسب المواصفة (لا جلسات ولا استئناف)
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed" } }),
    { status: 405, headers: { "Content-Type": "application/json", Allow: "POST", ...baseHeaders() } }
  );
}

export function handleMcpDelete(request: Request): Response {
  const unauthorized = checkAuth(request);
  if (unauthorized) return unauthorized;
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed" } }),
    { status: 405, headers: { "Content-Type": "application/json", Allow: "POST", ...baseHeaders() } }
  );
}
