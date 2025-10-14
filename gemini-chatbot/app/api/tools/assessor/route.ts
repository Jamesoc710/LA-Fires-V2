import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { assertCoreEndpoints } from "@/lib/la/endpoints";
import { lookupAssessor } from "@/lib/la/fetchers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    noStore();                 // disable caching for this route
    assertCoreEndpoints();     //  fail fast if envs missing

    const body = await req.json().catch(() => ({}));
    const { address, apn } = body || {};

    if (!address && !apn) {
      return NextResponse.json(
        { ok: false, error: "Provide address or APN" },
        { status: 400 }
      );
    }

    if (!apn) {
      // lookupAssessor currently needs an AIN/APN; address-only not implemented
      return NextResponse.json(
        { ok: false, error: "Address-only assessor lookup not yet supported. Provide an APN/AIN." },
        { status: 400 }
      );
    }

    //  IMPORTANT: pass a STRING id, not an object
    const data = await lookupAssessor(String(apn));
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Lookup failed" },
      { status: 500 }
    );
  }
}
