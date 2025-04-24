# LA Building Codes Assistant

A Next.js application that uses Google's Gemini AI to provide information about Los Angeles Title 26 building codes. The application maintains context from a knowledge base and provides a conversational interface for users to ask questions.

## Table of Contents

1. [Project Overview](#project-overview)
2. [Technology Stack](#technology-stack)
3. [Project Structure](#project-structure)
4. [Environment Variables](#environment-variables)
5. [Key Components](#key-components)
6. [API Integration](#api-integration)
7. [Context Management](#context-management)
8. [Styling](#styling)
9. [Deployment](#deployment)
10. [Setup Instructions](#setup-instructions)

## Project Overview

This application creates a chatbot interface that leverages Google's Gemini AI to provide information about Los Angeles Title 26 building codes. The chatbot is context-aware, using a knowledge base of information to answer questions accurately. Users can interact with the chatbot through a modern, responsive interface.

## Technology Stack

- **Framework**: Next.js 15.3.1 (with App Router)
- **Frontend**: React 19.0.0
- **AI**: Google Generative AI (via @google/generative-ai 0.24.0)
- **Language**: TypeScript 5
- **Styling**: TailwindCSS 4
- **Hosting**: Vercel

## Project Structure

```
gemini-chatbot/
├── .env.local                # Environment variables
├── .gitignore                # Git ignore file
├── .next/                    # Next.js build output
├── app/                      # Application code
│   ├── api/                  # API routes
│   │   └── chat/            
│   │       └── route.ts      # API endpoint for chat
│   ├── components/           # React components
│   │   └── Chat.tsx          # Main chat component
│   ├── types/                # TypeScript type definitions
│   │   └── chat.ts           # Chat-related types
│   ├── utils/                # Utility functions
│   │   └── contextLoader.ts  # Context loading utilities
│   ├── globals.css           # Global CSS
│   ├── layout.tsx            # Root layout component
│   └── page.tsx              # Main page component
├── context/                  # Context files
│   ├── municode_title_26.txt # Municode Building Code Information                       
│   └── knowledge_base.txt    # LA Fire saftey information (placeholder)
├── node_modules/             # Dependencies
├── public/                   # Static assets
├── next.config.ts            # Next.js configuration
├── next-env.d.ts             # Next.js TypeScript definitions
├── package.json              # Project dependencies and scripts
├── package-lock.json         # Locked dependencies
├── postcss.config.mjs        # PostCSS configuration
└── tsconfig.json             # TypeScript configuration
```

## Environment Variables

The application requires the following environment variable:

```
GEMINI_API_KEY=your_api_key_here
```

This key is used to authenticate with Google's Generative AI API. The key is stored in `.env.local` and accessed in the application via `process.env.GEMINI_API_KEY`.

## Key Components

### Main Page Component (`app/page.tsx`)

The main page component sets up the basic layout of the application, including:
- A header with the application title and subtitle
- The main Chat component that handles user interactions

```tsx
import Chat from './components/Chat';

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="bg-blue-600 text-white p-4 shadow-md">
        <h1 className="text-xl font-bold">LA Building Codes Assistant</h1>
        <p className="text-sm">Powered by IF Lab</p>
      </header>
      
      <div className="flex-1">
        <Chat />
      </div>
    </main>
  );
}
```

### Chat Component (`app/components/Chat.tsx`)

The Chat component is a client-side component (indicated by 'use client') that manages:
- Chat message state
- User input
- API interaction
- Loading states and error handling
- UI rendering for the chat interface

Key features:
- Uses React hooks for state management
- Automatically scrolls to the bottom when new messages arrive
- Handles form submission and input validation
- Displays messages with different styling for user and assistant
- Shows loading indicators while waiting for a response
- Displays error messages if the API call fails

### Types Definition (`app/types/chat.ts`)

Defines TypeScript interfaces and types for the chat functionality:

```tsx
export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  role: MessageRole;
  content: string;
  id?: string;
}

export interface ChatState {
  messages: Message[];
  isLoading: boolean;
  error: string | null;
}

export interface ChatContextType {
  state: ChatState;
  sendMessage: (message: string) => Promise<void>;
  resetChat: () => void;
}
```

## API Integration

### Chat API Route (`app/api/chat/route.ts`)

Handles the integration with Google's Generative AI:

1. Receives POST requests with message history
2. Loads context data from the knowledge base
3. Formats the messages and context for the Gemini API
4. Makes a request to the Gemini API
5. Returns the AI response to the client

Key functions:
- `POST`: Handles incoming requests, validates data, processes the request, and returns a response
- `formatMessagesForGemini`: Formats the conversation history and context for the Gemini API

The API uses the `gemini-2.0-flash-lite` model, which provides quick responses suitable for a chat application.

## Context Management

### Context Loader (`app/utils/contextLoader.ts`)

Handles loading context information from files in the `context` directory:

```tsx
import fs from 'fs';
import path from 'path';

export async function loadContext(): Promise<string> {
  try {
    const contextPath = path.join(process.cwd(), 'context', 'knowledge_base.txt');
    const contextData = fs.readFileSync(contextPath, 'utf8');
    return contextData;
  } catch (error) {
    console.error('Error loading context:', error);
    return 'Unable to load context information.';
  }
}

export async function loadAllContextFiles(): Promise<string> {
  try {
    const contextDir = path.join(process.cwd(), 'context');
    const files = fs.readdirSync(contextDir);
    
    const contextContents = await Promise.all(
      files
        .filter(file => file.endsWith('.txt'))
        .map(file => fs.readFileSync(path.join(contextDir, file), 'utf8'))
    );
    
    return contextContents.join('\n\n');
  } catch (error) {
    console.error('Error loading context files:', error);
    return 'Unable to load context information.';
  }
}
```

### Knowledge Base (`context/knowledge_base.txt`)

Contains structured information about Los Angeles fires and fire safety:
- Information about the Los Angeles Fire Department (LAFD)
- Fire safety tips
- Emergency contact information
- Other relevant data for the chatbot to reference

## Styling

### Global CSS (`app/globals.css`)

Sets up basic styling and integrates with TailwindCSS:
- Imports TailwindCSS
- Defines CSS variables for theming
- Handles light/dark mode with media queries
- Sets default font and colors

### Layout Component (`app/layout.tsx`)

Sets up the root layout and font handling:
- Imports and configures Geist and Geist Mono fonts
- Sets up metadata for the application
- Applies font variables and antialiasing to the body

## Deployment

The application is deployed on Vercel, which provides:
- Automatic deployments from Git
- Environment variable management
- Edge network distribution
- Analytics and monitoring

## Setup Instructions

1. **Clone the repository**
   ```
   git clone <repository-url>
   cd gemini-chatbot
   ```

2. **Install dependencies**
   ```
   npm install
   ```

3. **Set up environment variables**
   Create a `.env.local` file with your Google Gemini API key:
   ```
   GEMINI_API_KEY=your_api_key_here
   ```

4. **Run the development server**
   ```
   npm run dev
   ```

5. **Build for production**
   ```
   npm run build
   ```

6. **Start the production server**
   ```
   npm start
   ```

7. **Deploy to Vercel**
   ```
   vercel
   ```
   Or connect your GitHub repository to Vercel for automatic deployments.

## How It All Works Together

1. When a user visits the application, the main page loads with the Chat component.
2. The Chat component initializes with a welcome message from the assistant.
3. When the user sends a message:
   - The message is added to the local state
   - A POST request is sent to the `/api/chat` endpoint
   - The API route loads context from the knowledge base
   - It formats the context and message history for the Gemini API
   - The request is sent to Google's Generative AI
   - The response is returned to the client
   - The Chat component adds the response to the message history
4. The UI updates to display the new message and automatically scrolls to the bottom.

The application's strength comes from combining:
- React's component-based architecture for the UI
- Next.js's API routes for server-side processing
- TypeScript for type safety
- Google's Generative AI for intelligent responses
- Context management to provide domain-specific knowledge
