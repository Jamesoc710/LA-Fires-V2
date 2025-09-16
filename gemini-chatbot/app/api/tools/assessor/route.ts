import { assertCoreEndpoints } from "@/lib/la/endpoints";
import { NextRequest, NextResponse } from "next/server";
import { lookupAssessor } from "@/lib/la/fetchers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // Fail fast if env vars aren’t set
    assertCoreEndpoints();

    const body = await req.json().catch(() => ({}));
    const { address, apn } = body || {};

    if (!address && !apn) {
      return NextResponse.json(
        { ok: false, error: "Provide address or APN" },
        { status: 400 }
      );
    }

    const data = await lookupAssessor({ address, apn });
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Lookup failed" },
      { status: 500 }
    );
  }
}
