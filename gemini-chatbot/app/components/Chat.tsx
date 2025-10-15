'use client';

import { useState, useRef, useEffect } from 'react';
import { Message } from '../types/chat';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/* ------------ tiny helpers to render structured “cards” if present ------------ */

type Section = {
  title: string;
  rows: Array<{ k: string; v: string }>;
  link?: { label: string; href: string };
};

// quick url grabber
const URL_RE = /(https?:\/\/[^\s)]+)\b/gi;

// detects "Zoning", "Overlays", "Assessor", "Section: Unknown" blocks and parses KEY: value lines
function tryParseSections(text: string): Section[] | null {
  // Normalize newlines and trim
  const t = text.replace(/\r\n/g, '\n').trim();
  if (!t) return null;

  // split content into blocks by blank lines
  const blocks = t.split(/\n{2,}/);

  const sections: Section[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    // first line is often the heading
    const heading = lines[0].toLowerCase();

    let title: string | null = null;
    if (heading.startsWith('zoning')) title = 'Zoning';
    else if (heading.startsWith('overlays')) title = 'Overlays';
    else if (heading.startsWith('assessor')) title = 'Assessor';
    else if (heading.startsWith('section: unknown')) title = 'Section: Unknown';

    if (!title) {
      // sometimes the AI prints all on one line; also accept "Zoning ZONE: ...".
      if (/^zoning\b/i.test(lines[0])) title = 'Zoning';
      if (/^overlays\b/i.test(lines[0])) title = 'Overlays';
      if (/^assessor\b/i.test(lines[0])) title = 'Assessor';
    }

    if (!title) continue;

    const rows: Array<{ k: string; v: string }> = [];
    let link: Section['link'];

    // key: value extractor (handles words/underscores/numbers)
    for (let i = 0; i < lines.length; i++) {
      // skip the heading line itself
      if (i === 0 && /^(zoning|overlays|assessor|section: unknown)/i.test(lines[0])) continue;

      // merge inline "KEY: value KEY2: value2" into separate pairs
      const pieces = lines[i]
        // turn "A: b B: c" into "A: b\nB: c"
        .replace(/([A-Z0-9_ \-\/()]+:)/g, '\n$1')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

      for (const piece of pieces) {
        const m = piece.match(/^([A-Z][A-Z0-9_ \-\/()]*):\s*(.+)$/i);
        if (m) {
          const k = m[1].trim().replace(/\s{2,}/g, ' ');
          const v = m[2].trim();
          // keep link if present in value
          if (!link) {
            const url = v.match(URL_RE)?.[0];
            if (url && /assessor|parcel/i.test(url)) {
              link = { label: 'Assessor Portal', href: url };
            }
          }
          // omit null-ish
          if (!/^(null|undefined)$/i.test(v)) {
            rows.push({ k, v });
          }
        }
      }

      // if no key/value but a bare link lives on a line, keep it
      if (!link) {
        const bareUrl = lines[i].match(URL_RE)?.[0];
        if (bareUrl && /assessor|parcel/i.test(bareUrl)) {
          link = { label: 'Assessor Portal', href: bareUrl };
        }
      }
    }

    sections.push({ title, rows, link });
  }

  // return only if we found at least one meaningful section with at least one row
  const meaningful = sections.filter(s => s.rows.length || s.title === 'Section: Unknown' || s.link);
  return meaningful.length ? meaningful : null;
}

function SectionCards({ sections }: { sections: Section[] }) {
  return (
    <div className="space-y-4">
      {sections.map((sec, idx) => (
        <div
          key={idx}
          className="rounded-xl bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-slate-50 ring-1 ring-slate-200 dark:ring-slate-600 p-4 shadow-sm"
        >
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold tracking-wide">{sec.title}</h3>
            {sec.link && (
              <a
                href={sec.link.href}
                target="_blank"
                rel="noreferrer"
                className="text-sm underline hover:no-underline"
              >
                {sec.link.label}
              </a>
            )}
          </div>

          {sec.rows.length ? (
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
              {sec.rows.map((r, i) => (
                <div key={i} className="flex">
                  <dt className="w-40 shrink-0 text-sm font-medium text-slate-600 dark:text-slate-300">
                    {r.k}
                  </dt>
                  <dd className="text-sm">{r.v}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm opacity-80">No details detected.</p>
          )}
        </div>
      ))}
    </div>
  );
}

/* --------------------------------- component --------------------------------- */

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content:
        "Hi there! I'm here to help you navigate Los Angeles building codes. What part of your project can I assist with today?",
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = { role: 'user', content: input.trim() };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...messages, userMessage] }),
      });

      if (!response.ok) throw new Error(`Error: ${response.status}`);

      const data = await response.json();
      console.log('Detected intent from API:', data.intent);

      setMessages(prev => [...prev, { role: 'assistant', content: data.response }]);
    } catch (err: any) {
      console.error('Error sending message:', err);
      setError(err.message || 'Failed to send message');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div
        className="flex-1 overflow-auto p-4 space-y-4 pb-16"
        style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))' }}
      >
        {messages.map((message, index) => {
          const isUser = message.role === 'user';
          const parsed = !isUser ? tryParseSections(message.content) : null;

          return (
            <div key={index} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[70%] rounded-xl p-4 shadow-md ${
                  isUser
                    ? 'bg-blue-500 text-white'
                    : 'bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-slate-100 ring-1 ring-slate-200 dark:ring-slate-600'
                }`}
              >
                {/* If we parsed sections, render cards. Otherwise markdown bubble. */}
                {!isUser && parsed ? (
                  <SectionCards sections={parsed} />
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                )}
              </div>
            </div>
          );
        })}

        {isLoading && (
          <div className="flex justify-start">
            <div className="max-w-[70%] rounded-lg p-3 bg-gray-200 text-gray-800">
              <div className="flex space-x-2 items-center">
                <div className="w-2 h-2 bg-gray-600 rounded-full animate-bounce"></div>
                <div
                  className="w-2 h-2 bg-gray-600 rounded-full animate-bounce"
                  style={{ animationDelay: '0.2s' }}
                />
                <div
                  className="w-2 h-2 bg-gray-600 rounded-full animate-bounce"
                  style={{ animationDelay: '0.4s' }}
                />
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="flex justify-center">
            <div className="max-w-[70%] rounded-lg p-3 bg-red-100 text-red-800">Error: {error}</div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t p-4 sticky bg-white dark:bg-slate-900 z-10"
        style={{ bottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex space-x-2">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Type your message..."
            className="flex-1 p-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="bg-blue-500 text-white px-4 py-2 rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
