'use client';

import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useChatStream } from './chat/useChatStream';
import type { CopiedSection } from './chat/formatters';
import CardsBubble from './chat/CardsBubble';
import MarkdownBubble from './chat/MarkdownBubble';
import AddressPicker from './chat/AddressPicker';
import MessageInput from './chat/MessageInput';
import SuggestedPrompts from './chat/SuggestedPrompts';

export default function Chat() {
  const {
    messages,
    isLoading,
    error,
    addressMatches,
    sendUserMessage,
    selectAddress,
    cancelAddressPicker,
    clearChat,
  } = useChatStream();

  const [input, setInput] = useState('');
  const [showRawId, setShowRawId] = useState<string | null>(null);
  // FIX #40: Track which section was just copied for visual feedback
  const [copiedSection, setCopiedSection] = useState<CopiedSection>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, addressMatches]);

  // FIX #40: Copy handler with visual feedback
  const handleCopy = (section: CopiedSection, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedSection(section);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  const handleSubmit = () => {
    if (!input.trim() || isLoading) return;
    const text = input;
    setInput('');
    sendUserMessage(text);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* scrolling message area */}
      <div
        className="flex-1 overflow-auto p-4 space-y-4 pb-16"
        style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))' }}
      >
        {messages.map(message => (
          <div
            key={message.id}
            className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {message.role === 'user' ? (
              <div className="max-w-[92%] sm:max-w-[70%] rounded-xl p-4 shadow-md bg-stone-100 text-stone-950">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {message.content}
                </ReactMarkdown>
              </div>
            ) : message.cards ? (
              /* Phase 1: render structured cards directly */
              <CardsBubble
                text={message.content}
                cards={message.cards}
                metadata={message.metadata}
                showRaw={showRawId === message.id}
                onToggleRaw={() => setShowRawId(showRawId === message.id ? null : message.id)}
                copiedSection={copiedSection}
                onCopy={handleCopy}
              />
            ) : (
              /* General Q&A reply (no parcel cards): plain markdown bubble */
              <MarkdownBubble text={message.content} />
            )}
          </div>
        ))}

        {/* Phase 6B: Address Picker UI */}
        {addressMatches && addressMatches.length > 1 && (
          <div className="flex justify-start">
            <div className="w-full max-w-[92%] sm:max-w-[80%]">
              <AddressPicker
                results={addressMatches}
                onSelect={selectAddress}
                onCancel={cancelAddressPicker}
              />
            </div>
          </div>
        )}

        {isLoading && (
          <div className="flex justify-start">
            <div
              role="status"
              aria-label="Assistant is thinking"
              className="max-w-[92%] sm:max-w-[70%] rounded-lg p-3 bg-stone-900 border border-white/10 text-stone-200"
            >
              <div className="flex space-x-2 items-center">
                <div className="w-2 h-2 bg-stone-500 rounded-full animate-bounce" />
                <div className="w-2 h-2 bg-stone-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
                <div className="w-2 h-2 bg-stone-500 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }} />
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="flex justify-center">
            <div
              role="alert"
              className="max-w-[92%] sm:max-w-[70%] rounded-lg p-3 bg-red-950/50 border border-red-500/30 text-red-300"
            >
              Error: {error}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* suggestions row */}
      <SuggestedPrompts onPick={setInput} />

      {/* footer toolbar */}
      <div className="px-4 pb-2 flex items-center gap-3 text-xs text-stone-500">
        <button
          type="button"
          onClick={clearChat}
          className="rounded-md px-2 py-1 bg-white/5 hover:bg-white/10 border border-white/10 text-stone-300"
          title="Clear chat"
        >
          Clear chat
        </button>
        <span className="hidden sm:inline">History is saved locally.</span>
      </div>

      {/* FIX #1, #2, #3: Disclaimer block */}
      <div className="px-4 pb-2 border-t border-white/10 pt-2">
        <p className="text-xs text-stone-500 text-center leading-relaxed">
          <span className="font-medium text-amber-300">⚠️ Data shown is for informational purposes only.</span>
          {' '}Not an official zoning determination. Some overlay types may not be included. Data may not reflect recent zone changes.
          {' '}Verify all information with the appropriate planning department before making decisions.
        </p>
        <p className="text-xs text-stone-500 text-center mt-1 opacity-80">
          Contact your local planning department for official determinations.
        </p>
      </div>

      {/* input form */}
      <MessageInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        disabled={isLoading}
      />
    </div>
  );
}
