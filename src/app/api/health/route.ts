import { dbHealthy } from "@/lib/turso";
import { healthModels } from "@/lib/models";
import { mergerBase, mergerConfigured } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** فحص الجهوزية: قاعدة البيانات + خدمة الدمج (بمهلة 4 ثوانٍ) */
export async function GET() {
  const db = await dbHealthy().catch(() => false);

  let mergerHealthy = false;
  if (mergerConfigured()) {
    try {
      const res = await fetch(`${mergerBase()}/api/config`, {
        signal: AbortSignal.timeout(4000),
      });
      mergerHealthy = res.ok;
    } catch {
      mergerHealthy = false;
    }
  }

  return Response.json({
    ok: db,
    database: db ? "turso-connected" : "turso-error",
    mcpEndpoint: "/mcp",
    models: healthModels(),
    merger: {
      base: mergerConfigured() ? mergerBase() : null,
      healthy: mergerHealthy,
    },
    authRequired: !!process.env.MCP_ACCESS_TOKEN,
  });
}
