import { assertCoreEndpoints } from "@/lib/la/endpoints";
import { NextRequest, NextResponse } from "next/server";
import { lookupZoning } from "@/lib/la/fetchers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    assertCoreEndpoints();

    const body = await req.json().catch(() => ({}));
    const { address, apn, lat, lng } = body || {};

    if (!address && !apn && !(lat && lng)) {
      return NextResponse.json(
        { ok: false, error: "Provide address or APN or lat/lng" },
        { status: 400 }
      );
    }

    const data = await lookupZoning({ address, apn, lat, lng });
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Lookup failed" },
      { status: 500 }
    );
  }
}
