import { deleteKey, getKeyById, setKeyStatus } from "@/lib/turso";
import { toPublicKey } from "@/lib/keys";
import type { KeyStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { action?: string; status?: string } | null;
  const status: KeyStatus | null =
    body?.action === "disable" || body?.status === "disabled"
      ? "disabled"
      : body?.action === "enable" || body?.status === "active"
        ? "active"
        : null;
  if (!status) {
    return Response.json(
      { error: 'طلب غير صحيح — استخدم {"action":"disable"} أو {"action":"enable"}' },
      { status: 400 }
    );
  }
  const existing = await getKeyById(id);
  if (!existing) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await setKeyStatus(id, status);
  const updated = await getKeyById(id);
  return Response.json({ key: updated ? toPublicKey(updated) : null });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const existing = await getKeyById(id);
  if (!existing) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await deleteKey(id);
  return Response.json({ ok: true });
}
