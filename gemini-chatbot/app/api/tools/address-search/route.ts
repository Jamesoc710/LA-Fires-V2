import { NextRequest, NextResponse } from "next/server";
import { searchParcelsByAddress } from "@/lib/la/fetchers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { address, city } = body || {};

    if (!address || typeof address !== "string" || address.trim().length < 5) {
      return NextResponse.json(
        { ok: false, error: "Please provide an address (at least 5 characters)" },
        { status: 400 }
      );
    }

    const { results, note } = await searchParcelsByAddress(
      address.trim(),
      city?.trim() || undefined,
      10
    );

    return NextResponse.json({ 
      ok: true, 
      results, 
      note,
      count: results.length 
    });
  } catch (err: any) {
    console.error("[ADDRESS_SEARCH] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Address search failed" },
      { status: 500 }
    );
  }
}
