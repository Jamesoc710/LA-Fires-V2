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
    
    // Get the Gemini model
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
    
    // Generate a response from Gemini
    const result = await model.generateContent({
      contents: formattedContent
    });
    const response = result.response;
    const text = response.text();
    
    return NextResponse.json({ response: text });
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