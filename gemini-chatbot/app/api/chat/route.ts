import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { loadAllContextFiles } from '../../utils/contextLoader';

// Initialize the Google Generative AI with your API key
// You'll need to add your API key to .env.local file
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

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
    
    // Format the context and conversation history for Gemini
    const formattedContent = formatMessagesForGemini(messages, contextData);

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
      { role: 'user', parts: [{ text: `You are a helpful assistant that provides information about Los Angeles fires and fire safety.\nPlease use the following context to inform your responses:\n\n${contextData}` }] },
      // include the original conversation history
      ...messages.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }]
      }))
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

// Helper function to format messages for Gemini API
function formatMessagesForGemini(messages: any[], contextData: string) {
  // Create system prompt with context
  const systemPrompt = `You are a helpful assistant that provides information about Los Angeles fires and fire safety.
Please use the following context to inform your responses:

${contextData}

Only use the information in the context to answer questions. If you don't know the answer based on the provided context, say you don't have that information.`;

  // Format the conversation for Gemini
  const history = messages.map(msg => {
    return {
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    };
  });
  
  // For Gemini, we need to combine all this into "contents" array with proper formatting
  // First we'll add our context as the first user message
  const formattedContent = [
    {
      role: 'user',
      parts: [{ text: systemPrompt }]
    },
    {
      role: 'model',
      parts: [{ text: 'I understand. I will use the provided context to answer questions about Los Angeles fires and fire safety.' }]
    }
  ];
  
  // Then add the conversation history
  history.forEach(msg => {
    formattedContent.push(msg);
  });
  
  return formattedContent;
}