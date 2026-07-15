'use client';

import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useChatStream, looksLikeParcelQuery } from './chat/useChatStream';
import type { CopiedSection } from './chat/formatters';
import CardsBubble from './chat/CardsBubble';
import CardsSkeleton from './chat/CardsSkeleton';
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
    streamPhase,
    canRetry,
    retryIn,
    retry,
    sendUserMessage,
    selectAddress,
    cancelAddressPicker,
    clearChat,
  } = useChatStream();

  const [input, setInput] = useState('');
  const [showRawId, setShowRawId] = useState<string | null>(null);
  // FIX #40: Track which section was just copied for visual feedback
  const [copiedSection, setCopiedSection] = useState<CopiedSection>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Follow the stream only while the user is at (or near) the bottom;
  // scrolling up to read releases the follow, scrolling back re-engages it.
  const stickToBottomRef = useRef(true);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !stickToBottomRef.current) return;
    // Instant jumps during streaming (smooth animations pile up per token);
    // smooth only for discrete message boundaries.
    el.scrollTo({ top: el.scrollHeight, behavior: streamPhase === 'idle' ? 'smooth' : 'auto' });
  }, [messages, addressMatches, streamPhase]);

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

  const lastMessage = messages[messages.length - 1];
  // GIS still resolving: show card skeletons if the query looks parcel-shaped.
  const awaitingParcel =
    streamPhase === 'connecting' && lastMessage?.role === 'user' && looksLikeParcelQuery(lastMessage.content);
  // Cards painted but the narrative hasn't produced its first token yet.
  const awaitingNarrative =
    streamPhase === 'streaming' && lastMessage?.role === 'assistant' && !lastMessage.content;

  const typingDots = (
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
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* scrolling message area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
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
                citations={message.citations}
                metadata={message.metadata}
                showRaw={showRawId === message.id}
                onToggleRaw={() => setShowRawId(showRawId === message.id ? null : message.id)}
                copiedSection={copiedSection}
                onCopy={handleCopy}
                onRetry={canRetry && message.id === lastMessage?.id ? retry : undefined}
              />
            ) : (
              /* General Q&A reply (no parcel cards): plain markdown bubble */
              <MarkdownBubble text={message.content} citations={message.citations} />
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

        {streamPhase === 'connecting' &&
          (awaitingParcel ? (
            <div className="flex justify-start">
              <CardsSkeleton />
            </div>
          ) : (
            typingDots
          ))}

        {awaitingNarrative && typingDots}

        {error && (
          <div className="flex justify-center">
            <div
              role="alert"
              className="max-w-[92%] sm:max-w-[70%] rounded-lg p-3 bg-red-950/50 border border-red-500/30 text-red-300 flex items-center gap-3"
            >
              <span>Error: {error}</span>
              {canRetry && (
                <button
                  type="button"
                  onClick={retry}
                  disabled={isLoading || retryIn > 0}
                  className="shrink-0 rounded-md border border-red-400/30 bg-red-400/10 px-2.5 py-1 text-xs font-medium hover:bg-red-400/20 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {retryIn > 0 ? `Retry in ${retryIn}s` : 'Retry'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* suggestions row */}
      <SuggestedPrompts onPick={setInput} />

      {/* footer toolbar */}
      <div className="px-4 pb-2 flex items-center gap-3 text-xs text-stone-400">
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
        <p className="text-xs text-stone-400 text-center leading-relaxed">
          <span className="font-medium text-amber-300">⚠️ Data shown is for informational purposes only.</span>
          {' '}Not an official zoning determination. Some overlay types may not be included. Data may not reflect recent zone changes.
          {' '}Verify all information with the appropriate planning department before making decisions.
        </p>
        <p className="text-xs text-stone-400 text-center mt-1">
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
