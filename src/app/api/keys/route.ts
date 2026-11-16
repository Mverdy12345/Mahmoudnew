/** إدارة مفاتيح API — الإضافة والعرض مع إخفاء المفتاح دائمًا (maskKey) */
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { findDuplicateKey, insertKey, listKeys } from "@/lib/turso";
import { toPublicKey } from "@/lib/keys";
import type { ProviderId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: ProviderId[] = ["kie", "cometapi"];

export async function GET() {
  try {
    const keys = await listKeys();
    return Response.json({ keys: keys.map(toPublicKey) });
  } catch (e) {
    return Response.json(
      { error: `تعذر جلب المفاتيح: ${e instanceof Error ? e.message : e}` },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      provider?: string;
      api_key?: string;
      label?: string;
    } | null;

    if (!body || !body.provider || !PROVIDERS.includes(body.provider as ProviderId)) {
      return Response.json(
        { error: "المزود غير صحيح — القيم المدعومة: kie أو cometapi" },
        { status: 400 }
      );
    }
    const apiKey = String(body.api_key || "").trim();
    if (!apiKey) {
      return Response.json({ error: "مفتاح API مطلوب" }, { status: 400 });
    }

    // رفض التكرار لنفس المزود
    if (await findDuplicateKey(body.provider, apiKey)) {
      return Response.json(
        { error: "هذا المفتاح مضاف مسبقًا لنفس المزود" },
        { status: 409 }
      );
    }

    const created = await insertKey({
      id: randomUUID(),
      provider: body.provider as ProviderId,
      label: String(body.label || "").trim(),
      api_key: apiKey,
    });
    return Response.json({ key: toPublicKey(created) }, { status: 201 });
  } catch (e) {
    return Response.json(
      { error: `تعذر إضافة المفتاح: ${e instanceof Error ? e.message : e}` },
      { status: 500 }
    );
  }
}
