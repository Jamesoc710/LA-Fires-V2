import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { assertCoreEndpoints } from "@/lib/la/endpoints";
import { lookupZoning } from "@/lib/la/fetchers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    noStore();
    assertCoreEndpoints();

    const body = await req.json().catch(() => ({}));
    const { address, apn } = body || {};

    if (!address && !apn) {
      return NextResponse.json(
        { ok: false, error: "Provide address or APN" },
        { status: 400 }
      );
    }

    if (!apn) {
      return NextResponse.json(
        { ok: false, error: "Address-only zoning lookup not yet supported. Provide an APN/AIN." },
        { status: 400 }
      );
    }

    const data = await lookupZoning(String(apn));
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Lookup failed" },
      { status: 500 }
    );
  }
}
