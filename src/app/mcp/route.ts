/**
 * مسار خادم MCP — Streamable HTTP:
 * POST لرسائل JSON-RPC (تهيئة / tools/list / tools/call / إشعارات)،
 * DELETE لإنهاء الجلسة (غير مدعوم في الوضع العديم الجلسة → 405)،
 * وإذا ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token>.
 */
import { handleMcpDelete, handleMcpGet, handleMcpPost } from "@/lib/mcp/webTransport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // نافذة الانتظار تصل 240 ثانية على Vercel (Fluid Compute)

export async function POST(request: Request) {
  return handleMcpPost(request);
}

export async function GET(request: Request) {
  return handleMcpGet(request);
}

export async function DELETE(request: Request) {
  return handleMcpDelete(request);
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Accept, Authorization, mcp-session-id, mcp-protocol-version",
      "Access-Control-Max-Age": "86400",
    },
  });
}
