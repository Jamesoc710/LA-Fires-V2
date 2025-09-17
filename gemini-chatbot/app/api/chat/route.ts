import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { loadAllContextFiles } from "../../utils/contextLoader";
import { lookupZoning, lookupAssessor } from "@/lib/la/fetchers";

export const runtime = "nodejs";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

/* ------------------------------- helpers ------------------------------- */

function wantsParcelLookup(s: string) {
  const q = (s || "").toLowerCase();
  return (
    q.includes("apn") ||
    q.includes("zoning") ||
    q.includes("overlay") ||
    q.includes("assessor") ||
    q.includes("parcel") ||
    q.includes("what is my")
  );
}

function extractApn(s: string): string | undefined {
  // e.g., 5843-004-015 or 5843004015
  const m = (s || "").match(/\b(\d{4}-?\d{3}-?\d{3})\b/);
  return m ? m[1] : undefined;
}

function extractAddress(s: string): string | undefined {
  // placeholder; we’re not doing address→parcel yet
  if (/\d{3,5}\s+\w+/.test(s || "")) return s.trim();
  return undefined;
}

/* --------------------------------- POST -------------------------------- */

export async function POST(request: NextRequest) {
  try {
    noStore(); // avoid route-level caching while testing

    const { messages } = await request.json();
    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: "Invalid request. Messages must be an array." },
        { status: 400 }
      );
    }

    // Load static context (files)
    const contextData = await loadAllContextFiles();

    // --- Step 1: refine intent with Flash Lite ---
    const customLiteSystemPrompt = {
      role: "user",
      parts: [
        {
          text: `You are tasked with refining the user's inputted question about Los Angeles building codes.

Your goal is to:
- Make the question as clear, specific, and precise as possible.
- Keep the original intent and meaning.
- Eliminate vague or ambiguous wording.
- If necessary, add brief clarifications to make it easier for a code reviewer to understand the request.

Important:
- Do not change the meaning of the user's original question.
- Do not answer the question.
- Only return the refined and clarified version of the question.

Respond with only the improved question, nothing else.`,
        },
      ],
    };

    const intentModel = genAI.getGenerativeModel({
      model: "gemini-2.0-flash-lite",
    });
    const intentPrompt = [
      customLiteSystemPrompt,
      { role: "user", parts: [{ text: messages[messages.length - 1].content }] },
    ];
    const intentResult = await intentModel.generateContent({
      contents: intentPrompt,
    });
    const intent = intentResult.response.text().trim();

    // --- Step 2: live lookups (TOOL OUTPUTS) ---
    let toolContext = "";
    try {
      const lastUser = messages[messages.length - 1]?.content || "";
      if (wantsParcelLookup(lastUser)) {
        const apn = extractApn(lastUser);
        const address = extractAddress(lastUser);

        if (apn) {
          const [zRes, aRes] = await Promise.allSettled([
            lookupZoning(apn),
            lookupAssessor(apn),
          ]);

          if (zRes.status === "fulfilled") {
            toolContext += `\n[TOOL:zoning]\n${JSON.stringify(
              zRes.value,
              null,
              2
            )}`;
          } else {
            toolContext += `\n[TOOL_ERROR:zoning] ${String(zRes.reason)}`;
          }

          if (aRes.status === "fulfilled") {
            toolContext += `\n[TOOL:assessor]\n${JSON.stringify(
              aRes.value,
              null,
              2
            )}`;
          } else {
            toolContext += `\n[TOOL_ERROR:assessor] ${String(aRes.reason)}`;
          }
        } else if (address) {
          toolContext += `\n[TOOL_NOTE] Address detected but address→parcel is not implemented yet. Provide an APN/AIN to fetch zoning/assessor details.`;
        } else {
          toolContext += `\n[TOOL_NOTE] No APN/AIN or address detected.`;
        }
      }
    } catch (e) {
      toolContext += `\n[TOOL_ERROR] ${String(e)}`;
    }
    console.log("[CHAT] toolContext length:", toolContext.length);

    // --- Step 3: build prompts with tools first ---
    const systemPreamble = `
You are LA-Fires Assistant.
If TOOL OUTPUTS exist, you MUST answer using them. Do NOT refuse when tool data is present.
Prefer TOOL OUTPUTS over any other text. If they are missing, say "**Section: Unknown**" when sections do not apply (e.g., ArcGIS zoning/assessor), and ask the user for an APN/AIN if needed.
For zoning, summarize ZONE, Z_DESC, Z_CATEGORY, PLNG_AREA, and include TITLE_22 when available.
`.trim();

    const customSystemPrompt = {
      role: "user",
      parts: [
        {
          text: `You must include a section heading **only if present** in the provided materials.
If no section exists (e.g., ArcGIS zoning / assessor results), write "**Section: Unknown**" and continue.

Instructions:
- Use TOOL OUTPUTS when provided. They have priority over everything else.
- Get straight to the relevant facts (zoning code, description, category, planning area; assessor situs address, year built, area).
- Do not add disclaimers or refuse when tool data is present.`,
        },
      ],
    };

    const responseModel = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
    });

    const combinedPrompt = [
      // Make tools authoritative and visible early
      { role: "user", parts: [{ text: systemPreamble }] },
      customSystemPrompt,
      { role: "user", parts: [{ text: `Intent: ${intent}` }] },
      {
        role: "user",
        parts: [
          {
            text:
              `=== TOOL OUTPUTS (authoritative) ===
${toolContext || "(none)"}

=== STATIC CONTEXT (supporting) ===
${contextData}
`.trim(),
          },
        ],
      },
      // last user question last
      {
        role: "user",
        parts: [{ text: messages[messages.length - 1].content }],
      },
    ];

    const responseResult = await responseModel.generateContent({
      contents: combinedPrompt,
    });
    const text = responseResult.response.text().trim();

    return NextResponse.json({ response: text, intent });
  } catch (error: any) {
    console.error("Error in chat API:", error);
    return NextResponse.json(
      { error: error.message || "An error occurred while processing your request." },
      { status: 500 }
    );
  }
}
