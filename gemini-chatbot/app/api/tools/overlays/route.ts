import { NextResponse } from "next/server";
import { lookupOverlays } from "@/lib/la/fetchers";

export async function POST(req: Request) {
  try {
    const { apn } = await req.json();
    if (!apn) {
      return NextResponse.json({ ok: false, error: "Missing apn" }, { status: 400 });
    }
    const data = await lookupOverlays(apn);
    return NextResponse.json({ ok: true, ...data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
