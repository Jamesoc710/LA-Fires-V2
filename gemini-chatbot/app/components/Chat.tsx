'use client';

import { useState, useRef, useEffect, useMemo, UIEvent } from 'react';
import { Message } from '../types/chat';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  assessorParcelUrl,
  znetViewerUrl,
  gisnetViewerUrl,
} from '@/lib/la/endpoints';

function downloadFile(filename: string, contents: string, mime = 'application/json') {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------
Parser logic
------------ */

type SectionData = Record<string, string>;
type ParsedReply = {
  raw: string;
  apn?: string;
  ain?: string;
  zoning?: SectionData;
  overlays?: SectionData;
  assessor?: SectionData;
};

function extractKV(line: string): [string, string] | null {
  const cleaned = line.replace(/^\s*[-*]\s*/, '').replace(/\*\*/g, '').trim();
  const m = cleaned.match(/^([A-Za-z0-9_./\s]+?):\s*(.+)$/);
  if (!m) return null;
  const key = m[1].trim();
  const val = m[2].trim();
  return key && val ? [key, val] : null;
}

function normalizeKey(k: string) {
  return k.replace(/\s+/g, '_').replace(/[^\w/.-]/g, '').toUpperCase();
}

function parseAssistantText(text: string): ParsedReply {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const parsed: ParsedReply = { raw: text };

  const ain = text.match(/\bAIN[:\s-]*([0-9]{10})\b/i)?.[1];
  const apnRaw = text.match(/\bAPN[:\s-]*([0-9]{4}[-\s]?[0-9]{3}[-\s]?[0-9]{3})\b/i)?.[1];
  if (ain) parsed.ain = ain;
  if (apnRaw) parsed.apn = apnRaw.replace(/\s/g, '');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase();
    let kind: 'zoning' | 'overlays' | 'assessor' | null = null;
    if (line.startsWith('zoning')) kind = 'zoning';
    else if (line.startsWith('overlays')) kind = 'overlays';
    else if (line.startsWith('assessor')) kind = 'assessor';

    if (kind) {
      const data: SectionData = {};
      let j = i + 1;
      while (j < lines.length && !/^(zoning|overlays|assessor)/i.test(lines[j])) {
        const kv = extractKV(lines[j]);
        if (kv) data[normalizeKey(kv[0])] = kv[1];
        j++;
      }
      if (Object.keys(data).length) parsed[kind] = data;
      i = j - 1;
    }
  }
  return parsed;
}

/* -------------------------------- UI bits -------------------------------- */

function SectionCard({ title, data, onCopy }: { title: string; data: SectionData; onCopy: () => void; }) {
  return (
    <div className="py-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold">{title}</h3>
        <button type="button" onClick={onCopy} className="text-xs px-2 py-1 rounded-md bg-slate-200 dark:bg-slate-600 hover:bg-slate-300 dark:hover:bg-slate-500" title={`Copy ${title}`}>Copy</button>
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
        {Object.entries(data).map(([k, v]) => (
          <div key={k} className="flex">
            <dt className="w-40 shrink-0 text-sm font-semibold text-slate-800 dark:text-slate-200">{k.replace(/_/g, ' ')}:</dt>
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
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showRawForIndex, setShowRawForIndex] = useState<number | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  const suggestions = [
    'What’s the zoning for APN 5843-004-015?',
    'Show overlays only for AIN 5843004015',
    'Assessor details for APN 5843-003-012',
    'What permits apply for my parcel?',
  ];

  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    setIsScrolledUp(!atBottom);
  };

  useEffect(() => {
    if (!isScrolledUp) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isScrolledUp]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = { role: 'user', content: input.trim() };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

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
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message || 'Failed to get response.'}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  function AssistantBubble({ text, index }: { text: string; index: number }) {
    const parsed = useMemo(() => parseAssistantText(text), [text]);
    const hasStructure = parsed && (parsed.zoning || parsed.overlays || parsed.assessor);

    const buildCopyAll = () => {
      const blocks: string[] = [];
      if (parsed?.zoning) {
        blocks.push('Zoning', ...Object.entries(parsed.zoning).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`), '');
      }
      if (parsed?.overlays) {
        blocks.push('Overlays', ...Object.entries(parsed.overlays).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`), '');
      }
      if (parsed?.assessor) {
        blocks.push('Assessor', ...Object.entries(parsed.assessor).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`));
      }
      return blocks.length ? blocks.join('\n') : text;
    };

    if (!hasStructure) {
      return <div className="max-w-[70%] rounded-xl p-4 shadow-md bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-slate-100"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>;
    }

    const summaryItems = [
      parsed.apn && `APN: ${parsed.apn}`,
      parsed.zoning?.ZONE && `Zone: ${parsed.zoning.ZONE}`,
      parsed.overlays?.CSD_NAME && `Overlay: ${parsed.overlays.CSD_NAME}`,
      parsed.assessor?.YEAR_BUILT && `Built: ${parsed.assessor.YEAR_BUILT}`,
    ].filter(Boolean);

    return (
      <div className="w-full max-w-[80%] space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
            {summaryItems.length > 0 && (
                <div className="w-full rounded-md bg-slate-200 dark:bg-slate-800 p-2 text-sm text-slate-800 dark:text-slate-200 flex flex-wrap gap-x-4">
                    {summaryItems.map(item => <span key={item}>{item}</span>)}
                </div>
            )}
        </div>
        
        <div className="rounded-2xl bg-slate-100 dark:bg-slate-700/70 text-slate-900 dark:text-slate-100 ring-1 ring-slate-200 dark:ring-slate-600 p-4 divide-y divide-slate-300 dark:divide-slate-600/50">
          {parsed.zoning && <SectionCard title="Zoning" data={parsed.zoning} onCopy={() => navigator.clipboard.writeText(Object.entries(parsed.zoning!).map(([k, v]) => `${k}: ${v}`).join('\n'))} />}
          {parsed.overlays && <SectionCard title="Overlays" data={parsed.overlays} onCopy={() => navigator.clipboard.writeText(Object.entries(parsed.overlays!).map(([k, v]) => `${k}: ${v}`).join('\n'))} />}
          {parsed.assessor && <SectionCard title="Assessor" data={parsed.assessor} onCopy={() => navigator.clipboard.writeText(Object.entries(parsed.assessor!).map(([k, v]) => `${k}: ${v}`).join('\n'))} />}
        </div>
        
        <div className="flex items-center gap-4">
            <button type="button" onClick={() => setShowRawForIndex(showRawForIndex === index ? null : index)} className="text-xs text-slate-600 dark:text-slate-300 hover:underline">
            {showRawForIndex === index ? 'Hide raw text' : 'Show raw text'}
            </button>
            <button type="button" onClick={() => navigator.clipboard.writeText(buildCopyAll())} className="text-xs px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-600 hover:bg-slate-300 dark:hover:bg-slate-500" title="Copy this reply">Copy All</button>
            <button type="button" onClick={() => downloadFile('lafires-reply.json', JSON.stringify(parsed, null, 2))} className="text-xs px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-600 hover:bg-slate-300 dark:hover:bg-slate-500" title="Download JSON">Download JSON</button>
        </div>

        {showRawForIndex === index && (
          <div className="rounded-lg border border-slate-300 dark:border-slate-600 p-3 bg-white/60 dark:bg-slate-800/60">
            <pre className="whitespace-pre-wrap text-xs">{text}</pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div ref={chatContainerRef} onScroll={handleScroll} className="flex-1 overflow-auto p-4 space-y-4 pb-16">
        {messages.map((message, index) => (
          <div key={index} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {message.role === 'user' ? (
              <div className="max-w-[70%] rounded-xl p-4 shadow-md bg-blue-500 text-white"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
            ) : (
              <AssistantBubble text={message.content} index={index} />
            )}
          </div>
        ))}
        {isLoading && <div className="flex justify-start"><div className="w-2 h-2 bg-gray-600 rounded-full animate-bounce" /></div>}
        <div ref={messagesEndRef} />
      </div>

      <div className="px-4 pb-2 space-x-2">
        {suggestions.map(s => <button key={s} onClick={() => setInput(s)} className="mb-2 rounded-full px-3 py-1 text-xs bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-200 dark:hover:bg-slate-600">{s}</button>)}
      </div>

      <form onSubmit={handleSubmit} className="border-t p-4 bg-white dark:bg-slate-900">
        <div className="flex space-x-2">
          <input type="text" value={input} onChange={e => setInput(e.target.value)} disabled={isLoading} placeholder="Ask about zoning, assessor, overlays…" className="flex-1 p-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50" />
          <button type="submit" disabled={isLoading || !input.trim()} className="bg-blue-500 text-white px-4 py-2 rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50">Send</button>
        </div>
      </form>
    </div>
  );
}
