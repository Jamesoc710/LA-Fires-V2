'use client';

import { useEffect, useRef, useState } from 'react';
import type { AddressMatch, ChatResponse, Message, StreamFrame } from '../../types/chat';
import { formatApnDisplay } from './formatters';

const STORAGE_KEY = 'lafires.chat.v2';

const GREETING =
  "Hi there! I'm here to help you navigate Los Angeles building codes. Enter an APN (e.g., 5843-004-015) or a street address to get started.";

// Stable message ids: React keys + stream frame targeting.
export function newMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Non-secure-context fallback (crypto.randomUUID needs https/localhost).
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Fixed id keeps the SSR-rendered initial state deterministic (no hydration drift).
function greetingMessage(): Message {
  return { id: 'greeting', role: 'assistant', content: GREETING };
}

/**
 * Where an in-flight request is:
 * - 'connecting': request sent, no frame received yet (server is resolving GIS)
 * - 'streaming': first frame arrived; cards are painted, narrative may still be typing
 * The legacy JSON fallback stays 'connecting' until the full payload lands.
 */
export type StreamPhase = 'idle' | 'connecting' | 'streaming';

// Mirrors the server's parcel-lookup routing (APN/AIN digits or a street
// address), so the client can guess whether cards are coming and show a
// card skeleton instead of the generic typing dots. A wrong guess just means
// the skeleton resolves into a plain markdown bubble.
export function looksLikeParcelQuery(text: string): boolean {
  if (/\b\d{4}[- ]?\d{3}[- ]?\d{3}\b/.test(text)) return true; // APN/AIN
  return /\b\d{1,5}\s+[A-Za-z]{2,}/.test(text); // street address
}

/**
 * Owns the chat conversation state machine: message list + localStorage
 * persistence, the NDJSON stream reader, the legacy JSON fallback, the
 * address-picker flow, and the activeApn follow-up context.
 *
 * Components consume state and call the semantic actions; no setMessages
 * escapes this hook.
 */
export function useChatStream() {
  const [messages, setMessages] = useState<Message[]>([greetingMessage()]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase 6B: address matches drive the picker UI
  const [addressMatches, setAddressMatches] = useState<AddressMatch[] | null>(null);
  // Conversation memory: most recently shown parcel APN, sent as `activeApn` so
  // the server can resolve follow-ups like "what about the overlays for it?".
  const [activeApn, setActiveApn] = useState<string | null>(null);
  const [streamPhase, setStreamPhase] = useState<StreamPhase>('idle');
  // Retry support: the outgoing payload of the most recent request, and the id
  // of the assistant message that request created (removed before re-sending).
  // lastOutgoing is state (not a ref) so canRetry re-renders consumers.
  const [lastOutgoing, setLastOutgoing] = useState<Message[] | null>(null);
  const lastAssistantIdRef = useRef<string | null>(null);

  // rehydrate from localStorage on first mount
  useEffect(() => {
    try {
      // v2 persists structured `cards` on messages; tolerate messages without
      // them. Messages persisted before stable ids existed get one assigned.
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Message[];
        if (Array.isArray(parsed) && parsed.length) {
          const withIds = parsed.map(m => (m.id ? m : { ...m, id: newMessageId() }));
          setMessages(withIds);
          // Restore the active parcel from the most recent card-bearing message.
          const lastApn = [...withIds].reverse().find(m => m.cards?.apn)?.cards?.apn;
          if (lastApn) setActiveApn(lastApn);
        }
      }
    } catch {}
  }, []);

  // persist whenever messages change (cap length for safety)
  useEffect(() => {
    try {
      const capped = messages.slice(-50);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(capped));
    } catch {}
  }, [messages]);

  // Read NDJSON frames, painting cards on `meta` and streaming text on `delta`.
  // Frames update one assistant message addressed by id, so concurrent state
  // updates can never land on the wrong bubble.
  const consumeStream = async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let assistantId: string | null = null;

    const ensureAssistant = (init?: Partial<Message>): string => {
      if (assistantId) {
        // Contract sends one meta frame; if another arrives, merge it in place.
        const id = assistantId;
        if (init) setMessages(prev => prev.map(m => (m.id === id ? { ...m, ...init } : m)));
        return id;
      }
      const id = newMessageId();
      assistantId = id;
      lastAssistantIdRef.current = id;
      setMessages(prev => [...prev, { id, role: 'assistant', content: '', ...init }]);
      return id;
    };

    const appendDelta = (text: string) => {
      const id = ensureAssistant();
      setMessages(prev => prev.map(m => (m.id === id ? { ...m, content: m.content + text } : m)));
    };

    const handleFrame = (frame: StreamFrame) => {
      setStreamPhase('streaming'); // first frame: GIS resolved, cards en route
      if (frame.type === 'meta') {
        const am = frame.cards?.addressMatches;
        if (am && am.length > 1) setAddressMatches(am);
        if (frame.cards?.apn) setActiveApn(frame.cards.apn);
        ensureAssistant({ cards: frame.cards, metadata: frame.metadata, citations: frame.citations });
      } else if (frame.type === 'delta') {
        appendDelta(frame.text);
      } else if (frame.type === 'error') {
        setError(frame.message);
      }
      // 'done' is implicit at stream end
    };

    const flushLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        handleFrame(JSON.parse(trimmed) as StreamFrame);
      } catch {
        // ignore malformed / partial frames
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        flushLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    flushLine(buffer); // trailing frame without newline
  };

  // Legacy (non-streamed) JSON response handling.
  const handleJsonResponse = (data: ChatResponse) => {
    const am = data.cards?.addressMatches ?? data.addressMatches;
    if (am && am.length > 1) setAddressMatches(am);
    if (data.cards?.apn) setActiveApn(data.cards.apn);
    const assistantMessage: Message = {
      id: newMessageId(),
      role: 'assistant',
      content: data.response || 'Sorry, I could not generate a response.',
      cards: data.cards,
      citations: data.citations,
      metadata: data.metadata,
    };
    lastAssistantIdRef.current = assistantMessage.id;
    setMessages(prev => [...prev, assistantMessage]);
  };

  // Shared request path for sendUserMessage + selectAddress. Prefers NDJSON
  // streaming; falls back gracefully to a legacy JSON response.
  const sendChat = async (outgoing: Message[]) => {
    setIsLoading(true);
    setError(null);
    setStreamPhase('connecting');
    setLastOutgoing(outgoing);
    lastAssistantIdRef.current = null;
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/x-ndjson',
        },
        body: JSON.stringify({ messages: outgoing, activeApn }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/x-ndjson') && response.body) {
        await consumeStream(response.body);
      } else {
        // Server without streaming support: parse a single JSON payload.
        const data = (await response.json()) as ChatResponse;
        handleJsonResponse(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
      setStreamPhase('idle');
    }
  };

  // Re-send the last request. If the failed attempt already produced an
  // assistant bubble (e.g. cards painted, then the LLM stream died), remove
  // it first so the retry replaces it instead of stacking a duplicate.
  const retry = () => {
    if (!lastOutgoing || isLoading) return;
    setError(null);
    const failedId = lastAssistantIdRef.current;
    if (failedId) setMessages(prev => prev.filter(m => m.id !== failedId));
    void sendChat(lastOutgoing);
  };

  // Append the user's message and send the conversation.
  const sendUserMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    const userMessage: Message = { id: newMessageId(), role: 'user', content: trimmed };
    const outgoing = [...messages, userMessage];
    setMessages(prev => [...prev, userMessage]);
    setAddressMatches(null);

    await sendChat(outgoing);
  };

  // Phase 6B: handle address selection from picker. Shows a "Selected: …"
  // message but sends an APN lookup query as the actual last turn.
  const selectAddress = async (result: AddressMatch) => {
    setAddressMatches(null);

    const selectionMessage: Message = {
      id: newMessageId(),
      role: 'user',
      content: `Selected: ${result.address} (APN ${formatApnDisplay(result.apn)})`,
    };
    setMessages(prev => [...prev, selectionMessage]);

    await sendChat([
      ...messages,
      selectionMessage,
      { id: newMessageId(), role: 'user', content: `zoning overlays assessor for APN ${result.apn}` },
    ]);
  };

  // Phase 6B: handle cancel address picker
  const cancelAddressPicker = () => {
    setAddressMatches(null);
    setMessages(prev => [
      ...prev,
      {
        id: newMessageId(),
        role: 'assistant',
        content:
          'Address selection cancelled. Try a different address or enter an APN directly (e.g., 5843-004-015).',
      },
    ]);
  };

  // clear chat (keeps the greeting)
  const clearChat = () => {
    setMessages([greetingMessage()]);
    setAddressMatches(null);
    setActiveApn(null);
    setError(null);
    setLastOutgoing(null);
    lastAssistantIdRef.current = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  };

  return {
    messages,
    isLoading,
    error,
    addressMatches,
    activeApn,
    streamPhase,
    canRetry: lastOutgoing !== null,
    retry,
    sendUserMessage,
    selectAddress,
    cancelAddressPicker,
    clearChat,
  };
}
