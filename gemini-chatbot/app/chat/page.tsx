// app/chat/page.tsx
'use client';

import Chat from '../components/Chat';

export default function ChatPage() {
  return (
    <main className="flex h-screen flex-col overflow-hidden">
      <header className="bg-blue-600 text-white p-4 shadow-md">
        <h1 className="text-xl font-bold">LA Building Codes Assistant</h1>
        <p className="text-sm">Powered by IF Lab</p>
      </header>
      <div className="flex-1 flex flex-col min-h-0">
        <Chat />
      </div>
    </main>
  );
}