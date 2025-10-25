'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { Message } from '../types/chat';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// NEW: viewer links (safe to import client-side; they’re static urls)
import {
  assessorParcelUrl,
  znetViewerUrl,
  gisnetViewerUrl,
} from '@/lib/la/endpoints';

// NEW: simple file download
function downloadFile(filename: string, contents: string, mime = 'application/json') {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------ tiny utils to parse our assistant text into sections ----------- */

type SectionData = Record<string, string>;
type ParsedReply = {
  raw: string;
  apn?: string;
  ain?: string;
  zoning?: SectionData;
  overlays?: SectionData;
  assessor?: SectionData;
};
type SectionKind = 'zoning' | 'overlays' | 'assessor' | null;

function sectionKindFrom(line: string): SectionKind {
  const s = line.trim().toLowerCase().replace(/\*\*/g, '');
  // ignore “section: unknown”
  if (/^section\s*:\s*unknown\b/.test(s)) return null;

  // accept "section: zoning", "zoning:", "zoning"
  if (/^(section\s*:\s*)?zoning\s*:?\s*$/.test(s)) return 'zoning';
  if (/^(section\s*:\s*)?overlays?\s*:?\s*$/.test(s)) return 'overlays';
  if (/^(section\s*:\s*)?assessor\s*:?\s*$/.test(s)) return 'assessor';
  return null;
}


function extractKV(line: string): [string, string] | null {
  // strip leading bullet or dash and stray bold
  const cleaned = line
    .replace(/^\s*[-*]\s*/, '')
    .replace(/^\s*\*\*|\*\*\s*$/g, '')
    .trim();

  // match KEY: value  (allow spaces, slashes, dots, underscores)
  const m = cleaned.match(/^([A-Za-z0-9_./\s]+?):\s*(.+)$/);
  if (!m) return null;

  const key = m[1].trim();
  const val = m[2].trim();
  return key && val ? [key, val] : null;
}


function normalizeKey(k: string) {
  return k
    .replace(/\s+/g, '_')
    .replace(/[^\w/.-]/g, '')
    .toUpperCase();
}

function takeSection(lines: string[], startIndex: number): { end: number; data: SectionData } {
  const data: SectionData = {};
  let i = startIndex + 1;
  while (i < lines.length && !/^\s*(Zoning|Overlays|Assessor)\s*$/i.test(lines[i])) {
    const kv = extractKV(lines[i]);
    if (kv) {
      const [k, v] = kv;
      data[normalizeKey(k)] = v;
    }
    i++;
  }
  return { end: i, data };
}

function parseAssistantText(text: string): ParsedReply | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);

  const parsed: ParsedReply = { raw: text };

  // Try to capture APN/AIN from anywhere
  const ain = text.match(/\bAIN[:\s-]*([0-9]{10})\b/i)?.[1];
  const apnRaw = text.match(/\bAPN[:\s-]*([0-9]{4}[-\s]?[0-9]{3}[-\s]?[0-9]{3})\b/i)?.[1];
  if (ain) parsed.ain = ain;
  if (apnRaw) parsed.apn = apnRaw.replace(/\s/g, '');

  // Walk through lines, carving out sections
  for (let i = 0; i < lines.length; i++) {
    const kind = sectionKindFrom(lines[i]);
    if (!kind) continue;

    const data: SectionData = {};
    let j = i + 1;
    while (j < lines.length && sectionKindFrom(lines[j]) === null) {
      const kv = extractKV(lines[j]);
      if (kv) {
        const [k, v] = kv;
        data[normalizeKey(k)] = v;
      }
      j++;
    }

    if (Object.keys(data).length) {
      if (kind === 'zoning') parsed.zoning = data;
      if (kind === 'overlays') parsed.overlays = data;
      if (kind === 'assessor') parsed.assessor = data;
    }

    i = j - 1; // continue after the section we just consumed
  }

  // If nothing structured, keep raw
  return parsed.zoning || parsed.overlays || parsed.assessor ? parsed : { ...parsed, raw: text };
}

/* -------------------------------- UI bits -------------------------------- */

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-slate-200 dark:bg-slate-600 text-slate-800 dark:text-slate-100 px-2 py-0.5 text-xs font-medium">
      {children}
    </span>
  );
}

function SectionCard({
  title,
  data,
  onCopy,
}: {
  title: string;
  data: SectionData;
  onCopy: () => void;
}) {
  const rows = Object.entries(data);

  return (
    <div className="rounded-2xl bg-slate-100 dark:bg-slate-700/70 text-slate-900 dark:text-slate-100 ring-1 ring-slate-200 dark:ring-slate-600 p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-base font-semibold">{title}</h3>
        <button
          type="button"
          onClick={onCopy}
          className="text-xs px-2 py-1 rounded-md bg-slate-200 dark:bg-slate-600 hover:bg-slate-300 dark:hover:bg-slate-500"
          aria-label={`Copy ${title}`}
          title={`Copy ${title}`}
        >
          Copy
        </button>
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex">
            <dt className="w-40 shrink-0 text-sm font-semibold text-slate-800 dark:text-slate-200">
              {k.replace(/_/g, ' ')}:
            </dt>
            <dd className="text-sm">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ----------------------------- Chat component ---------------------------- */

export default function Chat() {
const [messages, setMessages] = useState<Message[]>([
  { role: 'assistant', content: "Hi there! I'm here to help you navigate Los Angeles building codes. What part of your project can I assist with today?" },
]);

// rehydrate from localStorage on first mount
useEffect(() => {
  try {
    const saved = localStorage.getItem('lafires.chat');
    if (saved) {
      const parsed = JSON.parse(saved) as Message[];
      if (Array.isArray(parsed) && parsed.length) setMessages(parsed);
    }
  } catch {}
}, []);

// persist whenever messages change (cap length for safety)
useEffect(() => {
  try {
    const capped = messages.slice(-50);
    localStorage.setItem('lafires.chat', JSON.stringify(capped));
  } catch {}
}, [messages]);

// clear chat (keeps the greeting)
function clearChat() {
  setMessages([
    {
      role: 'assistant',
      content:
        "Hi there! I'm here to help you navigate Los Angeles building codes. What part of your project can I assist with today?",
    },
  ]);
  localStorage.removeItem('lafires.chat');
}

  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRawForIndex, setShowRawForIndex] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const suggestions = [
    'What’s the zoning for APN 5843-004-015?',
    'Show overlays only for AIN 5843004015',
    'Assessor details for APN 5843-003-012',
    'Explain H5 plan designation',
  ];

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // submit
      (e.currentTarget.form as HTMLFormElement)?.requestSubmit();
    }
  };

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

      setMessages(prev => [...prev, { role: 'assistant', content: data.response }]);
    } catch (err: any) {
      console.error('Error sending message:', err);
      setError(err.message || 'Failed to send message');
    } finally {
      setIsLoading(false);
    }
  };


  
function AssistantBubble({ text, index }: { text: string; index: number }) {
  const parsed = useMemo(() => parseAssistantText(text), [text]);
  const hasStructure = parsed && (parsed.zoning || parsed.overlays || parsed.assessor);
  const showRaw = showRawForIndex === index;

  // Fallback: render plain markdown if we didn't parse any sections
  if (!hasStructure) {
    return (
      <div className="max-w-[70%] rounded-xl p-4 shadow-md bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-slate-100 ring-1 ring-slate-200 dark:ring-slate-600">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    );
  }

  // Build “copy all” text quickly (sections if present, else raw)
  const buildCopyAll = () => {
    const blocks: string[] = [];
    if (parsed?.zoning) {
      blocks.push('Zoning');
      blocks.push(
        ...Object.entries(parsed.zoning).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
      );
      blocks.push('');
    }
    if (parsed?.overlays) {
      blocks.push('Overlays');
      blocks.push(
        ...Object.entries(parsed.overlays).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
      );
      blocks.push('');
    }
    if (parsed?.assessor) {
      blocks.push('Assessor');
      blocks.push(
        ...Object.entries(parsed.assessor).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
      );
    }
    return blocks.length ? blocks.join('\n') : (parsed?.raw ?? text);
  };

return (
  <div className="w-full max-w-[80%] space-y-3">
    {/* header row: chips + viewer links + actions */}
    <div className="flex flex-wrap gap-2 items-center">
      {parsed?.apn && <Chip>APN: {parsed.apn}</Chip>}
      {parsed?.ain && <Chip>AIN: {parsed.ain}</Chip>}

      {/* viewer links */}
      {parsed?.ain && (
        <a
          href={assessorParcelUrl(parsed.ain)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-100 px-2 py-0.5 text-xs font-medium hover:underline"
          title="Open Assessor Portal"
        >
          Assessor ↗
        </a>
      )}
      <a
        href={znetViewerUrl()}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-100 px-2 py-0.5 text-xs font-medium hover:underline"
        title="Open ZNET Viewer"
      >
        ZNET ↗
      </a>
      <a
        href={gisnetViewerUrl()}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-100 px-2 py-0.5 text-xs font-medium hover:underline"
        title="Open GISNET"
      >
        GISNET ↗
      </a>

      {/* actions for this reply */}
      <div className="ml-auto flex gap-2">
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(buildCopyAll()).catch(() => {})}
          className="text-xs px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-600 hover:bg-slate-300 dark:hover:bg-slate-500"
          title="Copy this reply"
        >
          Copy all
        </button>

        <button
          type="button"
          onClick={() => {
            const toExport = {
              apn: parsed?.apn ?? null,
              ain: parsed?.ain ?? null,
              zoning: parsed?.zoning ?? null,
              overlays: parsed?.overlays ?? null,
              assessor: parsed?.assessor ?? null,
              raw: parsed?.raw ?? text,
            };
            downloadFile('lafires-reply.json', JSON.stringify(toExport, null, 2));
          }}
          className="text-xs px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-600 hover:bg-slate-300 dark:hover:bg-slate-500"
          title="Download JSON"
        >
          Download JSON
        </button>
      </div>
    </div>

    {/* structured cards */}
    {parsed?.zoning && (
      <SectionCard
        title="Zoning"
        data={parsed.zoning}
        onCopy={() => {
          const block = Object.entries(parsed.zoning!)
            .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
            .join('\n');
          navigator.clipboard.writeText(`Zoning\n${block}`).catch(() => {});
        }}
      />
    )}
    {parsed?.overlays && (
      <SectionCard
        title="Overlays"
        data={parsed.overlays}
        onCopy={() => {
          const block = Object.entries(parsed.overlays!)
            .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
            .join('\n');
          navigator.clipboard.writeText(`Overlays\n${block}`).catch(() => {});
        }}
      />
    )}
    {parsed?.assessor && (
      <SectionCard
        title="Assessor"
        data={parsed.assessor}
        onCopy={() => {
          const block = Object.entries(parsed.assessor!)
            .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
            .join('\n');
          navigator.clipboard.writeText(`Assessor\n${block}`).catch(() => {});
        }}
      />
    )}

    {/* raw toggle */}
    <button
      type="button"
      onClick={() => setShowRawForIndex(showRaw ? null : index)}
      className="text-xs text-slate-600 dark:text-slate-300 hover:underline"
    >
      {showRaw ? 'Hide raw text' : 'Show raw text'}
    </button>

    {showRaw && (
      <div className="rounded-lg border border-slate-300 dark:border-slate-600 p-3 bg-white/60 dark:bg-slate-800/60">
        <pre className="whitespace-pre-wrap text-xs">{parsed?.raw ?? text}</pre>
      </div>
    )}
  </div>
);
}
return (
  <div className="flex flex-col flex-1 min-h-0">
    {/* scrolling message area */}
    <div
      className="flex-1 overflow-auto p-4 space-y-4 pb-16"
      style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))' }}
    >
      {messages.map((message, index) => (
        <div
          key={index}
          className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          {message.role === 'user' ? (
            <div className="max-w-[70%] rounded-xl p-4 shadow-md bg-blue-500 text-white">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            </div>
          ) : (
            <AssistantBubble text={message.content} index={index} />
          )}
        </div>
      ))}

      {isLoading && (
        <div className="flex justify-start">
          <div className="max-w-[70%] rounded-lg p-3 bg-gray-200 text-gray-800">
            <div className="flex space-x-2 items-center">
              <div className="w-2 h-2 bg-gray-600 rounded-full animate-bounce" />
              <div className="w-2 h-2 bg-gray-600 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
              <div className="w-2 h-2 bg-gray-600 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }} />
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="flex justify-center">
          <div className="max-w-[70%] rounded-lg p-3 bg-red-100 text-red-800">
            Error: {error}
          </div>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>

    {/* suggestions row */}
    <div className="px-4 pb-2 space-x-2">
      {suggestions.map(s => (
        <button
          key={s}
          onClick={() => setInput(s)}
          className="mb-2 rounded-full px-3 py-1 text-xs bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-200 dark:hover:bg-slate-600"
        >
          {s}
        </button>
      ))}
    </div>

    {/* footer toolbar */}
    <div className="px-4 pb-2 flex items-center gap-3 text-xs text-slate-500">
      <button
        type="button"
        onClick={clearChat}
        className="rounded-md px-2 py-1 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-100"
        title="Clear chat"
      >
        Clear chat
      </button>
      <span className="hidden sm:inline">History is saved locally.</span>
    </div>

    {/* input form */}
    <form
      onSubmit={handleSubmit}
      className="border-t p-4 sticky bg-white dark:bg-slate-900 z-10"
      style={{ bottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex space-x-2">
        <input
          type="text"
          value={input}
          onKeyDown={handleKeyDown}
          onChange={e => setInput(e.target.value)}
          disabled={isLoading}
          placeholder="Ask about zoning, assessor, overlays…"
          className="flex-1 p-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          className="bg-blue-500 text-white px-4 py-2 rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        >
          Send
        </button>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Press Enter to send • Shift+Enter for a new line
      </p>
    </form>
  </div>
);
  
}
