import type { AddressMatch, ParcelCards } from "@/lib/la/types";

// Shared structured-card contract types live in lib/la/types.ts
export type {
  AddressMatch,
  ParcelCards,
  SectionStatus,
  OverlayCategory,
  OverlayGroupCard,
  OverlayGroupItem,
  AssessorCard,
  StandardizedZoningCard,
} from "@/lib/la/types";

// Canonical Citation shape lives in lib/rag/municodeIndex; re-export to avoid drift.
export type { Citation } from "@/lib/rag/municodeIndex";
import type { Citation } from "@/lib/rag/municodeIndex";

export type Message = {
  /** Stable client-side id (React key + stream targeting). Assigned on create;
   * messages persisted before ids existed get one on rehydrate. */
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Structured parcel data rendered directly as cards (Phase 1 contract) */
  cards?: ParcelCards;
  metadata?: {
    queriedAt?: string;
    jurisdiction?: string;
    sources?: string[];
    type?: string; // 'address_picker' when returning multiple address matches
  };
};

export type ChatResponse = {
  response: string;
  intent?: string;
  addressMatches?: AddressMatch[];
  /** Structured parcel data; render cards from this instead of parsing response text */
  cards?: ParcelCards;
  resolvedAddress?: {
    address: string;
    apn: string;
  } | null;
  metadata?: {
    queriedAt?: string;
    jurisdiction?: string;
    sources?: string[];
    type?: string;
  };
};

/**
 * NDJSON stream frames for the streaming chat contract (Phase 1 step 4).
 * Frame 1 is "meta" (cards + metadata), then "delta" text chunks, then "done".
 */
export type StreamFrame =
  | {
      type: "meta";
      cards: ParcelCards;
      citations?: Citation[];
      metadata: { queriedAt: string; jurisdiction?: string; sources?: string[] };
    }
  | { type: "delta"; text: string }
  | { type: "error"; message: string }
  | { type: "done" };
