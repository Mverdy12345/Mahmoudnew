/**
 * الأدوات الخمس لخادم MCP — الأوصاف بالإنجليزية (العميل يقرأها)
 * وكل نتائج الاستدعاء تُصاغ بالعربية حرفيًا كما تقتضي المواصفة.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TaskRow } from "@/lib/types";
import { parseUrls, refreshTask, runGeneration, runMerge, ToolError } from "@/lib/generation";
import { listRecentTasks } from "@/lib/turso";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

export const KNOWN_TOOLS = new Set([
  "generate_image",
  "generate_video",
  "merge_videos",
  "get_task",
  "list_media",
]);

// ---------- صياغة الردود العربية ----------

function fmtCompleted(task: TaskRow, urls: string[]): string {
  if (task.type === "image") {
    const first = urls[0];
    const lines = ["✅ تم توليد الصورة بنجاح", "", `![image](${first})`, "", `الرابط المباشر: ${first}`];
    for (const u of urls.slice(1)) lines.push("", `رابط إضافي: ${u}`);
    return lines.join("\n");
  }
  const header =
    task.type === "merge" ? "✅ تم دمج المقاطع بنجاح" : "✅ تم توليد الفيديو بنجاح";
  const lines: string[] = [header, ""];
  if (urls.length === 1) lines.push(`الرابط المباشر: ${urls[0]}`);
  else urls.forEach((u, i) => lines.push(`${i + 1}. ${u}`));
  if (task.type === "merge") {
    lines.push("", "⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.");
  }
  return lines.join("\n");
}

function fmtProcessing(task: TaskRow): string {
  // ملاحظة مهمة: لا نُظهر أي تفاصيل مفاتيح/رصيد للعميل إطلاقًا — يرى «قيد المعالجة» فقط
  const lines = [`⏳ المهمة قيد المعالجة — task_id: ${task.id}`, ""];
  if (task.progress > 0) lines.push(`التقدم الحالي: ${Math.min(task.progress, 99)}%`, "");
  lines.push("تابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.");
  return lines.join("\n");
}

function fmtFailed(task: TaskRow): string {
  return `❌ فشلت المهمة: ${task.error_message || "سبب غير معروف"}`;
}

function toolText(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

function handleToolError(e: unknown) {
  if (e instanceof ToolError) {
    return toolText(e.message, true);
  }
  console.error("[mcp] unexpected tool error:", e);
  return toolText("❌ حدث خطأ غير متوقع داخل الخادم — أعد المحاولة بعد قليل.", true);
}

/** مرسل إشعارات التقدم (كل ~3 ثوانٍ) إذا زوّد العميل الطلب بـ progressToken */
function makeProgressReporter(
  extra: { _meta?: { progressToken?: string | number }; sendNotification: (n: unknown) => Promise<void> }
) {
  const token = extra._meta?.progressToken;
  let lastSent = 0;
  return async (progress: number, message: string) => {
    if (token === undefined) return;
    const now = Date.now();
    if (now - lastSent < 2800) return;
    lastSent = now;
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total: 100, message },
      });
    } catch {
      /* العميل انقطع — نتجاهل بصمت */
    }
  };
}

/** بناء خادم MCP جديد بالأدوات الخمس — خادم لكل طلب (وضع عديم الجلسة) */
export function buildMcpServer(externalSignal?: AbortSignal): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic key failover across all active keys). Returns the finished image URL directly if generation completes within the wait window; otherwise returns a task_id with status PROCESSING — call get_task with that task_id every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto"),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      try {
        const { task, urls } = await runGeneration(
          {
            model: args.model,
            type: "image",
            prompt: args.prompt,
            input: {
              prompt: args.prompt,
              aspect_ratio: args.aspect_ratio,
              resolution: args.resolution,
              background: args.background,
              output_format: args.output_format,
            },
            waitSeconds: args.wait_seconds ?? 90,
          },
          { onProgress: makeProgressReporter(extra), signal: extra.signal ?? externalSignal }
        );
        if (urls && urls.length) return toolText(fmtCompleted(task, urls));
        return toolText(fmtProcessing(task));
      } catch (e) {
        return handleToolError(e);
      }
    }
  );

  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview — native synchronized audio (dialogue written in the prompt is spoken), optional image-to-video via image_url. Video takes minutes: the server waits briefly with live progress, then returns a task_id — track it with get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(4096)
          .describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z
          .string()
          .optional()
          .describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      try {
        const { task, urls } = await runGeneration(
          {
            model: args.model,
            type: "video",
            prompt: args.prompt,
            input: {
              prompt: args.prompt,
              image_url: args.image_url || undefined,
              aspect_ratio: args.aspect_ratio,
              resolution: args.resolution,
              // الصوت مولَّد دائمًا مع هذا الموديل — enable_audio مقبول لكنه لا يُرسل للمزود
              enable_audio: args.enable_audio,
              duration: args.duration,
            },
            waitSeconds: args.wait_seconds ?? 25,
          },
          { onProgress: makeProgressReporter(extra), signal: extra.signal ?? externalSignal }
        );
        if (urls && urls.length) return toolText(fmtCompleted(task, urls));
        return toolText(fmtProcessing(task));
      } catch (e) {
        return handleToolError(e);
      }
    }
  );

  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Concatenate several finished clips into ONE final video, in the exact given order. Pass 'urls' (public direct video URLs, e.g. links returned by generate_video) or 'task_ids' (COMPLETED video generation tasks — their result URLs are merged in this order; ideal after generating several clips). Usually fast: a short wait with live progress, then a task_id for the merge — track it with get_task. NOTE: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe(
            "Public direct video URLs (http/https) in merge order — the first clip starts the final video."
          ),
        task_ids: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe(
            "Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."
          ),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      try {
        const { task, urls } = await runMerge(
          {
            urls: args.urls,
            taskIds: args.task_ids,
            waitSeconds: args.wait_seconds ?? 60,
          },
          { onProgress: makeProgressReporter(extra), signal: extra.signal ?? externalSignal }
        );
        if (urls && urls.length) return toolText(fmtCompleted(task, urls));
        return toolText(fmtProcessing(task));
      } catch (e) {
        return handleToolError(e);
      }
    }
  );

  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its ID — image/video generation AND merging (reads the database and refreshes live from the provider or the merging service while processing). Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const task = await refreshTask(args.task_id);
        if (!task) {
          return toolText(`❌ لم يتم العثور على مهمة بالمعرّف: ${args.task_id}`, true);
        }
        if (task.status === "completed") {
          const urls = parseUrls(task.result_urls_json);
          if (!urls.length) {
            return toolText(`❌ المهمة مكتملة لكن لا توجد روابط نتيجة — task_id: ${task.id}`, true);
          }
          return toolText(fmtCompleted(task, urls));
        }
        if (task.status === "failed") return toolText(fmtFailed(task), true);
        return toolText(fmtProcessing(task));
      } catch (e) {
        return handleToolError(e);
      }
    }
  );

  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "Most recent stored images/videos/merges with their result links from the database (no regeneration) — to recall previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      try {
        const rows = await listRecentTasks(args.limit ?? 10, {
          type: args.type,
          status: args.status,
        });
        if (!rows.length) return toolText("📂 لا توجد وسائط مخزنة حتى الآن.");
        const typeLabel: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
        const statusLabel: Record<string, string> = {
          completed: "✅ مكتملة",
          failed: "❌ فاشلة",
          processing: "⏳ جارية",
        };
        const lines = [`📂 أحدث الوسائط المخزنة (${rows.length}):`, ""];
        rows.forEach((t, i) => {
          lines.push(`${i + 1}. [${typeLabel[t.type] ?? t.type}] ${statusLabel[t.status] ?? t.status} — ${t.model}`);
          lines.push(`   task_id: ${t.id}`);
          const urls = parseUrls(t.result_urls_json);
          if (urls.length) lines.push(`   الروابط: ${urls.join(" ، ")}`);
          if (t.status === "processing" && t.progress > 0) lines.push(`   التقدم: ${Math.min(t.progress, 99)}%`);
          if (t.status === "failed" && t.error_message) lines.push(`   السبب: ${t.error_message}`);
        });
        return toolText(lines.join("\n"));
      } catch (e) {
        return handleToolError(e);
      }
    }
  );

  return server;
}
