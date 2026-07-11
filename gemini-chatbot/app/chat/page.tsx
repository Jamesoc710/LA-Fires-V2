// app/chat/page.tsx
'use client';

import Link from 'next/link';
import Chat from '../components/Chat';

export default function ChatPage() {
  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-white">
      <header className="border-b border-stone-200 bg-white/90 px-4 py-3 backdrop-blur">
        <div className="flex items-baseline justify-between">
          <div>
            <Link href="/landing" className="text-lg font-semibold tracking-tight text-stone-900 hover:text-stone-600 transition">
              LA Building Codes Assistant
            </Link>
            <p className="text-xs text-stone-400">A project from IF Lab</p>
          </div>
        </div>
      </header>
      <div className="flex-1 flex flex-col min-h-0">
        <Chat />
      </div>
    </main>
  );
}
