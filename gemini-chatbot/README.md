# LA Fires Project Assistant

A Next.js application that uses Google's Gemini AI to provide information about Los Angeles building codes and fire safety. The application maintains context from a knowledge base and provides a conversational interface for users to ask questions. It features a landing page and a dedicated chat interface.

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

This application creates a chatbot interface that leverages Google's Gemini AI to provide information about Los Angeles Title 26 building codes and LA fire safety information. The chatbot is context-aware, using a knowledge base derived from local files to answer questions accurately. Users interact with the chatbot through a modern, responsive interface after visiting a landing page.

## Technology Stack

- **Framework**: Next.js 15.3.1 (with App Router)
- **Frontend**: React 19.0.0
- **AI**: Google Generative AI (via @google/generative-ai 0.24.0)
- **Language**: TypeScript 5
- **Styling**: TailwindCSS 4
- **UI Components**: Heroicons (via @heroicons/react 2.2.0)
- **Markdown Rendering**: React Markdown (via react-markdown 10.1.0, remark-gfm 4.0.1)
- **Development Server**: Next.js with Turbopack
- **Hosting**: Vercel

## Project Structure

```
gemini-chatbot/
├── .env.local                # Environment variables
├── .gitignore                # Git ignore file
├── .next/                    # Next.js build output
├── app/                      # Application code (App Router)
│   ├── api/                  # API routes
│   │   └── chat/
│   │       └── route.ts      # API endpoint for chat
│   ├── chat/                 # Chat page route
│   │   └── page.tsx          # Chat page component
│   ├── components/           # React components
│   │   └── Chat.tsx          # Main chat component
│   ├── landing/              # Landing page route
│   │   └── page.tsx          # Landing page component
│   ├── types/                # TypeScript type definitions
│   │   └── chat.ts           # Chat-related types
│   ├── utils/                # Utility functions
│   │   └── contextLoader.ts  # Context loading utilities
│   ├── favicon.ico           # Application favicon
│   ├── globals.css           # Global CSS
│   ├── layout.tsx            # Root layout component
│   └── page.tsx              # Root page (redirects to /landing)
├── context/                  # Context files
│   ├── municode_title_26.txt # Municode Building Code Information                       
│   └── knowledge_base.txt    # LA Fire saftey information (placeholder)
├── node_modules/             # Dependencies
├── public/                   # Static assets
│   └── BuildingCodeAssistantDemo.mp4 # Demo video used on landing page
│   └── ...                   # Other static assets (icons, etc.)
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

### Root Page Component (`app/page.tsx`)

The root page component simply redirects the user to the landing page (`/landing`).

```tsx
// app/page.tsx
import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/landing');
}
```

### Landing Page Component (`app/landing/page.tsx`)

This component serves as the entry point, displaying:
- The project title ("LA Fires Project") and description.
- Key features of the assistant.
- A "Chat Now" button linking to the chat interface (`/chat`).
- An embedded video demonstrating the application (`public/BuildingCodeAssistantDemo.mp4`).

### Chat Page Component (`app/chat/page.tsx`)

This page provides the main chat interface layout:
- A header with the application title ("LA Building Codes Assistant")
- The main `Chat` component that handles user interactions.

```tsx
// app/chat/page.tsx
'use client';

import Chat from '../components/Chat';

export default function ChatPage() {
  return (
    <main className="flex h-screen flex-col overflow-hidden">
      <header className="bg-blue-600 text-white p-4 shadow-md">
        <h1 className="text-xl font-bold">LA Building Codes Assistant</h1>
        <p className="text-sm">A project from IF Lab</p>
      </header>
      <div className="flex-1 flex flex-col min-h-0">
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
- Renders assistant responses using `ReactMarkdown` with `remark-gfm` for GitHub Flavored Markdown support.
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
2. Loads context data from *all* `.txt` files in the `context` directory using `loadAllContextFiles` from `contextLoader.ts`.
3. Formats the messages and combined context for the Gemini API. The system prompt currently emphasizes LA fires and fire safety.
4. Makes a request to the Gemini API (`gemini-2.0-flash-lite` model)

Key functions:
- `POST`: Handles incoming requests, validates data, processes the request, and returns a response
- `formatMessagesForGemini`: Formats the conversation history and combined context for the Gemini API, including a system prompt.

The API uses the `gemini-2.0-flash-lite` model, which provides quick responses suitable for a chat application.

## Context Management

### Context Loader (`app/utils/contextLoader.ts`)

Handles loading context information from files in the `context` directory. It includes functions to load a specific file (`loadContext`, currently targets `knowledge_base.txt`) or all `.txt` files (`loadAllContextFiles`). The API route uses `loadAllContextFiles`.

### Knowledge Base Files (`context/`)

Contains text files used as the knowledge base for the AI:
- `municode_title_26.txt`: Contains structured information about Los Angeles Title 26 building codes.
- `knowledge_base.txt`: Contains information about Los Angeles fire safety, the LAFD, tips, etc.

The `loadAllContextFiles` function combines the content of these files to provide context to the AI model.

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
   ```bash
   npm run dev
   ```
   (This uses Next.js with Turbopack for faster development builds)

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

1. When a user visits the application root, they are redirected to the landing page (`/landing`).
2. The landing page provides information and a link to the chat interface (`/chat`).
3. When the user navigates to `/chat`, the Chat Page loads with the Chat component.
4. The Chat component initializes with a welcome message from the assistant.
5. When the user sends a message:
   - The message is added to the local state
   - A POST request is sent to the `/api/chat` endpoint
   - The API route loads context from all `.txt` files in the `context/` directory.
   - It formats the combined context and message history for the Gemini API
   - The request is sent to Google's Generative AI
   - The response is returned to the client
   - The Chat component adds the response to the message history
6. The UI updates to display the new message and automatically scrolls to the bottom.

The application's strength comes from combining:
- React's component-based architecture for the UI
- Next.js's API routes for server-side processing
- TypeScript for type safety
- Google's Generative AI for intelligent responses
- Context management using local text files to provide domain-specific knowledge
