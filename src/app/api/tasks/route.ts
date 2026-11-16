import { NextRequest } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/turso";
import { parseUrls } from "@/lib/generation";
import type { MediaType, PublicTask, TaskStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function attemptsCount(json: string): number {
  try {
    const arr = JSON.parse(json || "[]");
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const limit = Math.min(Math.max(Number(sp.get("limit") || 20), 1), 50);
    const type = sp.get("type");
    const status = sp.get("status");

    const [stats, rows] = await Promise.all([
      taskStats(),
      listRecentTasks(limit, {
        type: type && ["image", "video", "merge"].includes(type) ? (type as MediaType) : undefined,
        status:
          status && ["completed", "failed", "processing"].includes(status)
            ? (status as TaskStatus)
            : undefined,
      }),
    ]);

    const tasks: PublicTask[] = rows.map((t) => ({
      id: t.id,
      provider: t.provider,
      model: t.model,
      type: t.type,
      status: t.status,
      progress: t.progress,
      prompt: t.prompt.length > 140 ? t.prompt.slice(0, 140) + "…" : t.prompt,
      resultUrls: parseUrls(t.result_urls_json),
      // ملاحظة: error_message يظهر هنا للوحة الإدارة (واجهة المالك) فقط — لا يخرج أبدًا عبر MCP
      error: t.error_message,
      attemptsCount: attemptsCount(t.attempts_json),
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    }));

    return Response.json({ stats, tasks });
  } catch (e) {
    return Response.json(
      { error: `تعذر جلب المهام: ${e instanceof Error ? e.message : e}` },
      { status: 500 }
    );
  }
}
