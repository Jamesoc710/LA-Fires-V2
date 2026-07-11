// app/chat/page.tsx
'use client';

import Link from 'next/link';
import Chat from '../components/Chat';

export default function ChatPage() {
  return (
    <main className="dark flex h-dvh flex-col overflow-hidden bg-stone-950 text-stone-100">
      <header className="border-b border-white/10 bg-stone-950/90 px-4 py-3 backdrop-blur">
        <div className="flex items-baseline justify-between">
          <div>
            <Link
              href="/landing"
              className="font-serif text-lg font-medium tracking-tight text-stone-100 transition hover:text-amber-300"
            >
              LA Building Codes Assistant
            </Link>
            <p className="text-xs text-stone-500">A project from IF Lab</p>
          </div>
        </div>
      </header>
      <div className="flex-1 flex flex-col min-h-0">
        <Chat />
      </div>
    </main>
  );
}
