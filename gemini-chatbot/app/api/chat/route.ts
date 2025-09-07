import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { loadAllContextFiles } from '../../utils/contextLoader';
import { lookupZoning, lookupAssessor } from "@/lib/la/fetchers";

export const runtime = 'nodejs';

// Initialize the Google Generative AI with your API key
// You'll need to add your API key to .env.local file
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

function wantsParcelLookup(s: string) {
  const q = s.toLowerCase();
  return (
    q.includes("apn") ||
    q.includes("zoning") ||
    q.includes("overlay") ||
    q.includes("assessor") ||
    q.includes("parcel") ||
    q.includes("what is my") // common phrasing
  );
}

function extractApn(s: string): string | undefined {
  const m = s.match(/\b(\d{4}-?\d{3}-?\d{3})\b/); // e.g., 5843-004-015 or 5843004015
  return m ? m[1] : undefined;
}

function extractAddress(s: string): string | undefined {
  // super-light heuristic; you can improve later or let the user provide it explicitly
  if (/\d{3,5}\s+\w+/.test(s)) return s.trim();
  return undefined;
}


export async function POST(request: NextRequest) {
  try {
    const { messages } = await request.json();
    
    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: 'Invalid request. Messages must be an array.' },
        { status: 400 }
      );
    }

    // Load context from files
    const contextData = await loadAllContextFiles();
    


    // Custom system prompt for Gemini Flash Lite
    const customLiteSystemPrompt = {
      role: 'user',
      parts: [{
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
    
    Respond with only the improved question, nothing else.`
      }]
    };
    // Step 1: Determine intent of the user's query using Flash Lite model
    const intentModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
    const intentPrompt = [
      customLiteSystemPrompt,
      {
        role: 'user',
        parts: [{ text: messages[messages.length - 1].content }]
      }
    ];
    const intentResult = await intentModel.generateContent({ contents: intentPrompt });
    const intent = intentResult.response.text().trim();

//----------------END OF LITE MODEL HANDLING-------------------------------------------------
//-------------------------------------------------------------------------------------------
// ----- OPTIONAL LIVE LOOKUP PRE-STEP -----
let toolContext = "";
try {
  const lastUser = messages[messages.length - 1]?.content || "";
  if (wantsParcelLookup(lastUser)) {
    const apn = extractApn(lastUser);
    const address = extractAddress(lastUser);

    // First try zoning (address or APN)
    const zoning = await lookupZoning({ address, apn });
    toolContext += `\n\n[TOOL:zoning_lookup]\n${JSON.stringify(zoning, null, 2)}`;

    console.log("DEBUG zoning result:", zoning); // 👈 debug log

    // If we have an APN, add assessor details
    const finalApn = apn || zoning.apn;
    if (finalApn) {
      const assessor = await lookupAssessor({ apn: finalApn });
      toolContext += `\n\n[TOOL:assessor_lookup]\n${JSON.stringify(assessor, null, 2)}`;
      console.log("DEBUG assessor result:", assessor); // 👈 debug log
    }
  }
} catch (e) {
  toolContext += `\n\n[TOOL_ERROR] ${String(e)}`;
}

// ----- END LIVE LOOKUP PRE-STEP -----


    // Custom system prompt for Gemini Flash
const customSystemPrompt = {
  role: 'user',
  parts: [{
    text: `You must always include the specific section title or source heading where you found the information, formatted in bold markdown. 
Example: "**Section: H103.1**".

If no section is available, clearly state "**Section: Unknown**".

Important Instructions:
- Get straight to the relevant information.
- Do not include introductory remarks, summaries, disclaimers, or recommendations.
- Only present the answer based directly on the context provided.
- Write in a direct, professional tone focused solely on delivering the requested information.
`
  }]
};

// Step 2: Generate response using intent and context
const responseModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const combinedPrompt = [
  customSystemPrompt,
  { role: 'user', parts: [{ text: `Intent: ${intent}` }] },

  // ✅ include static context + tool outputs
  {
    role: 'user',
    parts: [{
      text: `You are a helpful assistant that provides information about Los Angeles fires and fire safety.
Please use the following context AND tool outputs (if any) to inform your responses:

=== STATIC CONTEXT ===
${contextData}

=== TOOL OUTPUTS ===
${toolContext || "(none)"}
` // <-- close the backtick here
    }]
  },

  // include the original conversation history
  ...messages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.content }]
  })),
];

const responseResult = await responseModel.generateContent({ contents: combinedPrompt });
const text = responseResult.response.text().trim();


    return NextResponse.json({ response: text, intent });
  } catch (error: any) {
    console.error('Error in chat API:', error);
    return NextResponse.json(
      { error: error.message || 'An error occurred while processing your request.' },
      { status: 500 }
    );
  }
}
