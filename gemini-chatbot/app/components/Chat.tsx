'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import type {
  Message,
  ChatResponse,
  StreamFrame,
  ParcelCards,
  StandardizedZoningCard,
  AssessorCard,
  OverlayGroupCard,
} from '../types/chat';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Viewer links (safe to import client-side; they're static urls)
import {
  assessorParcelUrl,
  znetViewerUrl,
  gisnetViewerUrl,
  // FIX #5: Import new viewer URL helpers
  getViewerUrlForJurisdiction,
  shouldShowCountyViewers,
  // FIX #41: Import formatters
  formatAIN,
} from '@/lib/la/endpoints';

// Simple file download helper
function downloadFile(filename: string, contents: string, mime = 'application/json') {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------ Phase 6B: Address Search Result Type ----------- */

type AddressMatch = {
  address: string;
  city: string;
  zip: string;
  apn: string;
};

/* ------------ view models derived from structured cards ----------- */

type SectionData = Record<string, string>;

// Grouped overlay structure (built from cards, rendered by GroupedOverlaysCard)
type OverlayCategory = {
  name: string;
  items: string[];
};
type GroupedOverlays = {
  jurisdiction?: string;
  categories: OverlayCategory[];
};

/* -------------------------------- UI bits -------------------------------- */

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-white/5 border border-white/10 text-stone-300 px-2 py-0.5 text-xs font-mono font-medium">
      {children}
    </span>
  );
}

// Plain markdown chat bubble for general Q&A replies (no parcel cards).
function MarkdownBubble({ text }: { text: string }) {
  return (
    <div className="max-w-[92%] sm:max-w-[80%] rounded-xl p-4 shadow-md bg-stone-900 border border-white/10 text-stone-200">
      <div className="prose prose-invert prose-sm max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </div>
  );
}

// FIX #35: Format field labels to be more readable
function formatFieldLabel(key: string): string {
  const labelMap: Record<string, string> = {
    'YEARBUILT': 'YEAR BUILT',
    'YEAR_BUILT': 'YEAR BUILT',
    'LIVINGAREA': 'LIVING AREA',
    'LIVING_AREA': 'LIVING AREA',
    'LOTSQFT': 'LOT SIZE',
    'LOT_SQFT': 'LOT SIZE',
    'LOTSQUAREFEET': 'LOT SIZE',
    'LOT_SQUARE_FEET': 'LOT SIZE',
    'SQFTMAIN': 'LIVING AREA',
    'SQFT_MAIN': 'LIVING AREA',
    'BEDROOMS': 'BEDROOMS',
    'BATHROOMS': 'BATHROOMS',
    'ZONEDESCRIPTION': 'ZONE DESCRIPTION',
    'ZONE_DESCRIPTION': 'ZONE DESCRIPTION',
    'GENERALPLAN': 'GENERAL PLAN',
    'GENERAL_PLAN': 'GENERAL PLAN',
    'COMMUNITYAREA': 'COMMUNITY AREA',
    'COMMUNITY_AREA': 'COMMUNITY AREA',
    'PLANNINGAREA': 'PLANNING AREA',
    'PLANNING_AREA': 'PLANNING AREA',
  };
  
  return labelMap[key] || key.replace(/_/g, ' ');
}

// FIX #35: Format YEARBUILT with age calculation
// FIX #36: Format ZIP codes consistently
// FIX #7, #8: Format values with units for display
function formatFieldValue(key: string, value: string): string {
  const normalizedKey = key.toUpperCase().replace(/[_\s]/g, '');
  
  // Skip formatting for null/empty values
  if (!value || value === 'None' || value === 'N/A' || value === 'null') {
    if (normalizedKey === 'LIVINGAREA' || normalizedKey === 'LOTSQFT' || normalizedKey === 'LOTSQUAREFEET') {
      return 'Not available';
    }
    return value;
  }
  
  // FIX #35: Format YEARBUILT with age
  if (normalizedKey === 'YEARBUILT') {
    const year = parseInt(value.replace(/,/g, ''));
    if (!isNaN(year) && year > 1800 && year < 2100) {
      const age = new Date().getFullYear() - year;
      return `${year} (${age} years old)`;
    }
    return value;
  }
  
  // FIX #36: Format ZIP codes consistently (show ZIP+4 if available)
  if (normalizedKey === 'ZIP' || normalizedKey === 'ZIPCODE') {
    const cleaned = value.replace(/\s/g, '');
    // Already ZIP+4 format
    if (/^\d{5}-\d{4}$/.test(cleaned)) {
      return cleaned;
    }
    // 9 digits without dash
    if (/^\d{9}$/.test(cleaned)) {
      return `${cleaned.slice(0, 5)}-${cleaned.slice(5)}`;
    }
    // Just 5 digits - return as-is
    if (/^\d{5}$/.test(cleaned)) {
      return cleaned;
    }
    return value;
  }
  
  // FIX #7: Format LIVINGAREA with commas and "sq ft"
  if (normalizedKey === 'LIVINGAREA' || normalizedKey === 'SQFTMAIN') {
    const num = parseFloat(value.replace(/,/g, ''));
    if (!isNaN(num) && num > 0) {
      return `${num.toLocaleString()} sq ft`;
    }
  }
  
  // FIX #8: Format LOTSQFT with commas and "sq ft"
  if (normalizedKey === 'LOTSQFT' || normalizedKey === 'LOTAREA' || normalizedKey === 'LOTSQUAREFEET') {
    const num = parseFloat(value.replace(/,/g, ''));
    if (!isNaN(num) && num > 0) {
      return `${num.toLocaleString()} sq ft`;
    }
  }
  
  return value;
}

// FIX #37: Data source mapping
const DATA_SOURCES: Record<string, string> = {
  'Zoning': 'LA County GIS / City GIS',
  'Overlays': 'LA County GIS / City GIS',
  'Assessor': 'LA County Assessor',
};

// FIX #40: Copy confirmation state type
type CopiedSection = 'zoning' | 'overlays' | 'assessor' | 'all' | null;

// FIX #37, #40: Updated SectionCard with source attribution and clearer copy button
function SectionCard({
  title,
  data,
  onCopy,
  copiedSection,
  sectionKey,
}: {
  title: string;
  data: SectionData;
  onCopy: () => void;
  copiedSection?: CopiedSection;
  sectionKey?: 'zoning' | 'overlays' | 'assessor';
}) {
  const rows = Object.entries(data);
  const isCopied = sectionKey && copiedSection === sectionKey;
  const source = DATA_SOURCES[title];

  return (
    <div className="rounded-2xl bg-white/[0.04] border border-white/10 text-stone-200 p-4">
      <div className="flex items-center justify-between mb-2">
        {/* FIX #37: Title with source attribution */}
        <div>
          <h3 className="text-base font-semibold font-serif text-stone-100">{title}</h3>
          {source && (
            <p className="text-xs text-stone-500">Source: {source}</p>
          )}
        </div>
        {/* FIX #40: Clearer copy button with section name and confirmation */}
        <button
          type="button"
          onClick={onCopy}
          className={`text-xs px-3 py-1.5 rounded-md min-h-[36px] transition-colors ${
            isCopied 
              ? 'bg-green-400/10 text-green-300 border border-green-400/20' 
              : 'bg-white/5 hover:bg-white/10 border border-white/10 text-stone-300'
          }`}
          aria-label={`Copy ${title} section`}
          title={`Copy ${title} section to clipboard`}
        >
          {isCopied ? '✓ Copied!' : `Copy ${title}`}
        </button>
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex">
            {/* FIX #35: Use formatted labels */}
            <dt className="w-40 shrink-0 text-[11px] uppercase tracking-wider text-stone-500 font-medium">
              {formatFieldLabel(k)}:
            </dt>
            {/* FIX #35, #36, #7, #8: Use formatted values */}
            <dd className="font-mono text-[13px] text-stone-200">{formatFieldValue(k, v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// FIX #10 (Option B): Define known overlay categories that should always show
const KNOWN_OVERLAY_CATEGORIES = [
  'HAZARDS',
  'HISTORIC PRESERVATION',
  'LAND USE & PLANNING',
];

// FIX #37, #40: Grouped Overlays Card Component with source and clearer copy
function GroupedOverlaysCard({
  data,
  onCopy,
  copiedSection,
}: {
  data: GroupedOverlays;
  onCopy: () => void;
  copiedSection?: CopiedSection;
}) {
  const isCopied = copiedSection === 'overlays';
  
  // FIX #10: Ensure known categories always appear, even if empty
  const existingCategoryNames = new Set(data.categories.map(c => c.name.toUpperCase()));
  const categoriesWithPlaceholders: OverlayCategory[] = [...data.categories];
  
  // Add "None found" placeholders for missing known categories
  for (const knownCat of KNOWN_OVERLAY_CATEGORIES) {
    if (!existingCategoryNames.has(knownCat)) {
      categoriesWithPlaceholders.push({
        name: knownCat,
        items: ['None found for this parcel'],
      });
    }
  }
  
  // Sort categories: Hazards first, then Historic, then Land Use, then others
  const categoryOrder = ['HAZARDS', 'HISTORIC PRESERVATION', 'LAND USE & PLANNING', 'SUPPLEMENTAL USE DISTRICTS', 'OTHER'];
  categoriesWithPlaceholders.sort((a, b) => {
    const aIndex = categoryOrder.indexOf(a.name.toUpperCase());
    const bIndex = categoryOrder.indexOf(b.name.toUpperCase());
    const aOrder = aIndex === -1 ? 999 : aIndex;
    const bOrder = bIndex === -1 ? 999 : bIndex;
    return aOrder - bOrder;
  });

  return (
    <div className="rounded-2xl bg-white/[0.04] border border-white/10 text-stone-200 p-4">
      <div className="flex items-center justify-between mb-2">
        {/* FIX #37: Title with source attribution */}
        <div>
          <h3 className="text-base font-semibold font-serif text-stone-100">Overlays</h3>
          <p className="text-xs text-stone-500">Source: {DATA_SOURCES['Overlays']}</p>
        </div>
        {/* FIX #40: Clearer copy button with confirmation */}
        <button
          type="button"
          onClick={onCopy}
          className={`text-xs px-3 py-1.5 rounded-md min-h-[36px] transition-colors ${
            isCopied 
              ? 'bg-green-400/10 text-green-300 border border-green-400/20' 
              : 'bg-white/5 hover:bg-white/10 border border-white/10 text-stone-300'
          }`}
          aria-label="Copy Overlays section"
          title="Copy Overlays section to clipboard"
        >
          {isCopied ? '✓ Copied!' : 'Copy Overlays'}
        </button>
      </div>
      
      {/* Jurisdiction line */}
      {data.jurisdiction && (
        <div className="flex mb-3">
          <span className="w-40 shrink-0 text-[11px] uppercase tracking-wider text-stone-500 font-medium">
            JURISDICTION:
          </span>
          <span className="font-mono text-[13px] text-stone-200">{data.jurisdiction}</span>
        </div>
      )}

      {/* Categories */}
      <div className="space-y-4">
        {categoriesWithPlaceholders.map((category, idx) => {
          const isPlaceholder = category.items.length === 1 && category.items[0] === 'None found for this parcel';
          return (
            <div key={idx}>
              <h4 className="text-xs tracking-widest uppercase text-stone-400 font-medium mb-1">
                {category.name}
              </h4>
              <ul className="space-y-1 ml-1">
                {category.items.map((item, itemIdx) => (
                  <li 
                    key={itemIdx} 
                    className={`text-sm flex items-start gap-2 ${isPlaceholder ? 'text-stone-500 italic' : ''}`}
                  >
                    <span className="text-stone-500 select-none">•</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* --------- Phase 1: build SectionData/overlays from structured cards --------- */

// Keys are chosen so the shared formatFieldLabel/formatFieldValue helpers
// produce the expected labels ("ZONE DESCRIPTION", etc.) and value formatting.
function buildZoningData(card: StandardizedZoningCard): SectionData {
  const d: SectionData = {};
  if (card.jurisdiction) d['JURISDICTION'] = card.jurisdiction;
  if (card.zone) d['ZONE'] = card.zone;
  if (card.zoneDescription) d['ZONE DESCRIPTION'] = card.zoneDescription;
  if (card.generalPlan) d['GENERAL PLAN'] = card.generalPlan;
  if (card.generalPlanDescription) d['GENERAL PLAN DESCRIPTION'] = card.generalPlanDescription;
  if (card.planningArea) d['COMMUNITY/PLANNING AREA'] = card.planningArea;
  if (card.specificPlan) d['SPECIFIC PLAN'] = card.specificPlan;
  return d;
}

function buildAssessorData(card: AssessorCard): SectionData {
  const d: SectionData = {};
  const set = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && String(v).trim() !== '') d[k] = String(v);
  };
  set('SITUS', card.situs);
  set('CITY', card.city);
  set('ZIP', card.zip);
  set('USE', card.use);
  set('YEARBUILT', card.yearBuilt);
  set('LIVINGAREA', card.livingArea);
  set('LOTSQFT', card.lotSqft);
  set('UNITS', card.units);
  set('BEDROOMS', card.bedrooms);
  set('BATHROOMS', card.bathrooms);
  return d;
}

// Overlay key categories that always render (with a "None found" placeholder when empty).
const CARD_KEY_CATEGORIES = ['Hazards', 'Historic Preservation', 'Land Use & Planning'];

function buildGroupedFromCards(groups: OverlayGroupCard[] | undefined, jurisdiction?: string): GroupedOverlays {
  const categories: OverlayCategory[] = (groups || [])
    .filter(g => g.items.length > 0 || CARD_KEY_CATEGORIES.includes(g.category))
    .map(g => ({
      name: g.category.toUpperCase(),
      items: g.items.length
        ? g.items.map(it => (it.details ? `${it.name} — ${it.details}` : it.name))
        : ['None found for this parcel'],
    }));
  return { jurisdiction, categories };
}

// Non-data section states (no_data / error / not_configured / not_implemented).
function SectionMessageCard({ title, message }: { title: string; message?: string }) {
  const source = DATA_SOURCES[title];
  return (
    <div className="rounded-2xl bg-white/[0.04] border border-white/10 text-stone-200 p-4">
      <div className="mb-2">
        <h3 className="text-base font-semibold font-serif text-stone-100">{title}</h3>
        {source && (
          <p className="text-xs text-stone-500">Source: {source}</p>
        )}
      </div>
      <p className="text-sm text-stone-400">
        {message || 'None found for this parcel.'}
      </p>
    </div>
  );
}

// FIX #9: Error card for invalid APN or data retrieval failures
function ParcelNotFoundCard({ apn, message }: { apn?: string; message?: string }) {
  return (
    <div className="rounded-2xl bg-red-950/50 border border-red-500/30 text-red-300 p-4">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0">
          <svg className="h-6 w-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <div>
          <h3 className="text-base font-semibold mb-1">Could Not Retrieve Parcel Data</h3>
          <p className="text-sm mb-2">
            {message || `Unable to find data for ${apn ? `APN ${apn}` : 'the provided number'} in LA County records.`}
          </p>
          <div className="text-sm space-y-1">
            <p className="font-medium">Please verify:</p>
            <ul className="list-disc list-inside ml-2 space-y-0.5">
              <li>APNs are 10 digits (e.g., 5843-004-015)</li>
              <li>The number matches your property tax bill</li>
              <li>The parcel is located in LA County</li>
            </ul>
          </div>
          <div className="mt-3 flex gap-3">
            <a
              href="https://portal.assessor.lacounty.gov/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center text-sm font-medium text-amber-300 hover:text-amber-200 hover:underline"
            >
              Look up your APN ↗
            </a>
            <span className="text-stone-600">|</span>
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center text-sm font-medium text-amber-300 hover:text-amber-200 hover:underline"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- Phase 6B: Address Picker Component -------------------------------- */

function AddressPicker({
  results,
  onSelect,
  onCancel,
}: {
  results: AddressMatch[];
  onSelect: (result: AddressMatch) => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-2xl bg-white/[0.04] border border-white/10 text-stone-200 p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0">
          <svg className="h-6 w-6 text-amber-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold font-serif text-stone-100 mb-1">Multiple Parcels Found</h3>
          <p className="text-sm text-stone-400 mb-3">
            Select the correct property to continue:
          </p>
        </div>
      </div>
      
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {results.map((r, idx) => (
          <button
            key={r.apn || idx}
            onClick={() => onSelect(r)}
            className="w-full text-left p-3 rounded-lg bg-white/[0.02]
                       hover:bg-white/5
                       border border-white/10
                       transition-colors group"
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="font-medium text-stone-100 group-hover:text-amber-300">
                  {r.address}
                </div>
                <div className="text-sm text-stone-500">
                  {r.city}{r.zip ? `, ${r.zip}` : ''}
                </div>
              </div>
              <div className="text-xs font-mono bg-white/5 border border-white/10 px-2 py-1 rounded-full text-stone-300">
                {formatApnDisplay(r.apn)}
              </div>
            </div>
          </button>
        ))}
      </div>
      
      <button
        onClick={onCancel}
        className="text-sm text-amber-300 hover:text-amber-200 hover:underline"
      >
        ← Cancel and try a different address
      </button>
    </div>
  );
}

// Helper to format APN for display (XXXX-XXX-XXX format)
function formatApnDisplay(apn: string): string {
  const digits = apn.replace(/\D/g, '');
  if (digits.length === 10) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return apn;
}

/* ----------------------------- Chat component ---------------------------- */

export default function Chat() {
const [messages, setMessages] = useState<Message[]>([
  { role: 'assistant', content: "Hi there! I'm here to help you navigate Los Angeles building codes. Enter an APN (e.g., 5843-004-015) or a street address to get started." },
]);

// rehydrate from localStorage on first mount
useEffect(() => {
  try {
    // v2 persists structured `cards` on messages; tolerate messages without them.
    const saved = localStorage.getItem('lafires.chat.v2');
    if (saved) {
      const parsed = JSON.parse(saved) as Message[];
      if (Array.isArray(parsed) && parsed.length) {
        setMessages(parsed);
        // Restore the active parcel from the most recent card-bearing message.
        const lastApn = [...parsed].reverse().find(m => m.cards?.apn)?.cards?.apn;
        if (lastApn) setActiveApn(lastApn);
      }
    }
  } catch {}
}, []);

// persist whenever messages change (cap length for safety)
useEffect(() => {
  try {
    const capped = messages.slice(-50);
    localStorage.setItem('lafires.chat.v2', JSON.stringify(capped));
  } catch {}
}, [messages]);

// clear chat (keeps the greeting)
function clearChat() {
  setMessages([
    {
      role: 'assistant',
      content:
        "Hi there! I'm here to help you navigate Los Angeles building codes. Enter an APN (e.g., 5843-004-015) or a street address to get started.",
    },
  ]);
  setAddressMatches(null);
  setActiveApn(null);
  localStorage.removeItem('lafires.chat.v2');
}

  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRawForIndex, setShowRawForIndex] = useState<number | null>(null);
  // FIX #40: Track which section was just copied for visual feedback
  const [copiedSection, setCopiedSection] = useState<CopiedSection>(null);
  // Phase 6B: Track address matches for picker UI
  const [addressMatches, setAddressMatches] = useState<AddressMatch[] | null>(null);
  const [originalQuery, setOriginalQuery] = useState<string>('');
  // Conversation memory: most recently shown parcel APN, sent as `activeApn` so
  // the server can resolve follow-ups like "what about the overlays for it?".
  const [activeApn, setActiveApn] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const suggestions = [
    "Zoning, overlays and assessor details for 5314 La Crescenta Ave",
    "Overlay details for APN 5843-004-015",
    "Show zoning for 2013 Lemoyne St",
    "Assessor details for AIN 5843003012",
  ];

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

  // Shared request path for handleSubmit + handleAddressSelect. Prefers NDJSON
  // streaming; falls back gracefully to a legacy JSON response.
  const sendChat = async (outgoing: Message[]) => {
    setIsLoading(true);
    setError(null);
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
    }
  };

  // Read NDJSON frames, painting cards on `meta` and streaming text on `delta`.
  const consumeStream = async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let hasAssistant = false;

    const ensureAssistant = (init?: Partial<Message>) => {
      setMessages(prev => [...prev, { role: 'assistant', content: '', ...init }]);
      hasAssistant = true;
    };

    const appendDelta = (text: string) => {
      setMessages(prev => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.role === 'assistant') {
          copy[copy.length - 1] = { ...last, content: last.content + text };
        }
        return copy;
      });
    };

    const handleFrame = (frame: StreamFrame) => {
      if (frame.type === 'meta') {
        const am = frame.cards?.addressMatches;
        if (am && am.length > 1) setAddressMatches(am);
        if (frame.cards?.apn) setActiveApn(frame.cards.apn);
        ensureAssistant({ cards: frame.cards, metadata: frame.metadata });
      } else if (frame.type === 'delta') {
        if (!hasAssistant) ensureAssistant();
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
      role: 'assistant',
      content: data.response || 'Sorry, I could not generate a response.',
      cards: data.cards,
      metadata: data.metadata,
    };
    setMessages(prev => [...prev, assistantMessage]);
  };

  // Phase 6B: Handle address selection from picker
  const handleAddressSelect = async (result: AddressMatch) => {
    setAddressMatches(null);

    // Build a new query with the resolved APN
    const newQuery = `zoning overlays assessor for APN ${result.apn}`;

    // Add user message showing what they selected
    const selectionMessage: Message = {
      role: 'user',
      content: `Selected: ${result.address} (APN ${formatApnDisplay(result.apn)})`,
    };
    setMessages(prev => [...prev, selectionMessage]);

    await sendChat([...messages, selectionMessage, { role: 'user', content: newQuery }]);
  };

  // Phase 6B: Handle cancel address picker
  const handleAddressCancel = () => {
    setAddressMatches(null);
    // Add a message indicating cancellation
    const cancelMessage: Message = {
      role: 'assistant',
      content: 'Address selection cancelled. Try a different address or enter an APN directly (e.g., 5843-004-015).',
    };
    setMessages(prev => [...prev, cancelMessage]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = { role: 'user', content: input.trim() };
    const outgoing = [...messages, userMessage];
    setMessages(prev => [...prev, userMessage]);
    setOriginalQuery(input.trim());
    setInput('');
    setAddressMatches(null);

    await sendChat(outgoing);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  // Helper to build copy text for grouped overlays
  function buildGroupedOverlaysCopyText(data: GroupedOverlays): string {
    const lines: string[] = ['Overlays'];
    if (data.jurisdiction) {
      lines.push(`JURISDICTION: ${data.jurisdiction}`);
    }
    for (const cat of data.categories) {
      lines.push('');
      lines.push(`${cat.name}:`);
      for (const item of cat.items) {
        lines.push(`  • ${item}`);
      }
    }
    return lines.join('\n');
  }

  // Phase 1: render sections DIRECTLY from structured cards (no text parsing).
  function CardsBubble({ text, cards, index, metadata }: { text: string; cards: ParcelCards; index: number; metadata?: Message['metadata'] }) {
    const showRaw = showRawForIndex === index;
    const z = cards.zoning;
    const o = cards.overlays;
    const a = cards.assessor;

    const isRenderable = (s: string) => s !== 'skipped' && s !== 'address_multiple';
    const renderableSections = [z, o, a].filter(s => isRenderable(s.status));
    const anySection = renderableSections.length > 0;

    // General Q&A (all sections skipped) or the address-picker prompt: render the
    // narrative as a plain chat bubble; the picker itself renders separately.
    if (!anySection) {
      return <MarkdownBubble text={text} />;
    }

    // Parcel not found / total lookup failure: every requested section errored
    // (e.g. an invalid APN). Surface the helpful recovery card, keyed off the
    // structured card statuses rather than any text heuristic.
    const allError = renderableSections.every(s => s.status === 'error');
    if (allError) {
      return (
        <div className="w-full max-w-[92%] sm:max-w-[80%] space-y-3">
          {text.trim() && (
            <div className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </div>
          )}
          <ParcelNotFoundCard apn={cards.apn} message={z.message} />
        </div>
      );
    }

    const jurisdiction = cards.jurisdiction ?? null;
    const showCountyViewers = shouldShowCountyViewers(jurisdiction);
    const cityViewer = getViewerUrlForJurisdiction(jurisdiction);

    const apn = cards.apn;
    const ain = a.card?.ain != null ? String(a.card.ain) : undefined;
    const assessorAin = ain ?? apn;

    const zoningData = z.status === 'success' && z.card ? buildZoningData(z.card) : null;
    const assessorData = a.status === 'success' && a.card ? buildAssessorData(a.card) : null;
    const groupedOverlays =
      o.status === 'success' && o.groups ? buildGroupedFromCards(o.groups, jurisdiction ?? undefined) : null;

    const buildCopyAll = () => {
      const blocks: string[] = [];
      if (zoningData) {
        blocks.push('Zoning');
        blocks.push(...Object.entries(zoningData).map(([k, v]) => `${formatFieldLabel(k)}: ${formatFieldValue(k, v)}`));
        blocks.push('');
      }
      if (groupedOverlays) {
        blocks.push(buildGroupedOverlaysCopyText(groupedOverlays));
        blocks.push('');
      }
      if (assessorData) {
        blocks.push('Assessor');
        blocks.push(...Object.entries(assessorData).map(([k, v]) => `${formatFieldLabel(k)}: ${formatFieldValue(k, v)}`));
      }
      return blocks.length ? blocks.join('\n').trim() : text;
    };

    const viewerLinkClass =
      'inline-flex items-center rounded-full border border-amber-400/20 bg-amber-400/10 text-amber-300 hover:text-amber-200 px-2 py-0.5 text-xs font-medium';

    return (
      <div className="w-full max-w-[92%] sm:max-w-[80%] space-y-3">
        {/* header row: chips + viewer links + actions */}
        <div className="flex flex-wrap gap-2 items-center">
          {apn && <Chip>APN: {formatApnDisplay(apn)}</Chip>}
          {ain && <Chip>AIN: {ain}</Chip>}

          {cityViewer && (
            <a href={cityViewer.url} target="_blank" rel="noreferrer" className={viewerLinkClass} title={`Open ${cityViewer.name}`}>
              {cityViewer.name} ↗
            </a>
          )}

          {assessorAin && (
            <a href={assessorParcelUrl(assessorAin)} target="_blank" rel="noreferrer" className={viewerLinkClass} title="Open Assessor Portal">
              Assessor ↗
            </a>
          )}

          {showCountyViewers && (
            <>
              <a href={znetViewerUrl} target="_blank" rel="noreferrer" className={viewerLinkClass} title="Open ZNET Viewer">
                ZNET ↗
              </a>
              <a href={gisnetViewerUrl} target="_blank" rel="noreferrer" className={viewerLinkClass} title="Open GISNET">
                GISNET ↗
              </a>
            </>
          )}

          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => handleCopy('all', buildCopyAll())}
              className={`text-xs px-3 py-1.5 rounded-md min-h-[36px] transition-colors ${
                copiedSection === 'all'
                  ? 'bg-green-400/10 text-green-300 border border-green-400/20'
                  : 'bg-white/5 hover:bg-white/10 border border-white/10 text-stone-300'
              }`}
              title="Copy entire response to clipboard"
            >
              {copiedSection === 'all' ? '✓ Copied!' : 'Copy All'}
            </button>

            <button
              type="button"
              onClick={() =>
                downloadFile(
                  'lafires-reply.json',
                  JSON.stringify({ apn: cards.apn ?? null, cards, content: text, metadata: metadata ?? null }, null, 2)
                )
              }
              className="text-xs px-3 py-1.5 rounded-md min-h-[36px] bg-white/5 hover:bg-white/10 border border-white/10 text-stone-300"
              title="Download response as JSON file"
            >
              Download JSON
            </button>
          </div>
        </div>

        {metadata?.queriedAt && (
          <p className="text-xs text-stone-500">
            Retrieved {new Date(metadata.queriedAt).toLocaleString()}
          </p>
        )}

        {/* LLM narrative answer (streams in) rendered above the data cards */}
        {text.trim() && (
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        )}

        {/* Zoning */}
        {isRenderable(z.status) &&
          (zoningData ? (
            <SectionCard
              title="Zoning"
              data={zoningData}
              sectionKey="zoning"
              copiedSection={copiedSection}
              onCopy={() =>
                handleCopy(
                  'zoning',
                  `Zoning\n${Object.entries(zoningData)
                    .map(([k, v]) => `${formatFieldLabel(k)}: ${formatFieldValue(k, v)}`)
                    .join('\n')}`
                )
              }
            />
          ) : (
            <SectionMessageCard title="Zoning" message={z.message} />
          ))}

        {/* Overlays */}
        {isRenderable(o.status) &&
          (groupedOverlays ? (
            <GroupedOverlaysCard
              data={groupedOverlays}
              copiedSection={copiedSection}
              onCopy={() => handleCopy('overlays', buildGroupedOverlaysCopyText(groupedOverlays))}
            />
          ) : (
            <SectionMessageCard title="Overlays" message={o.message} />
          ))}

        {/* Assessor */}
        {isRenderable(a.status) &&
          (assessorData ? (
            <SectionCard
              title="Assessor"
              data={assessorData}
              sectionKey="assessor"
              copiedSection={copiedSection}
              onCopy={() =>
                handleCopy(
                  'assessor',
                  `Assessor\n${Object.entries(assessorData)
                    .map(([k, v]) => `${formatFieldLabel(k)}: ${formatFieldValue(k, v)}`)
                    .join('\n')}`
                )
              }
            />
          ) : (
            <SectionMessageCard title="Assessor" message={a.message} />
          ))}

        {/* raw text toggle (raw = the LLM narrative content) */}
        <button
          type="button"
          onClick={() => setShowRawForIndex(showRaw ? null : index)}
          aria-expanded={showRaw}
          className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-md
                     bg-white/5 hover:bg-white/10 border border-white/10
                     text-stone-300
                     transition-colors min-h-[44px]"
          title={showRaw ? 'Hide raw response' : 'Show raw response'}
        >
          <span>{showRaw ? '▼' : '▶'}</span>
          <span>{showRaw ? 'Hide raw text' : 'Show raw text'}</span>
        </button>

        {showRaw && (
          <div className="rounded-lg border border-white/10 p-3 bg-white/5">
            <pre className="whitespace-pre-wrap text-xs">{text}</pre>
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
            <div className="max-w-[92%] sm:max-w-[70%] rounded-xl p-4 shadow-md bg-stone-100 text-stone-950">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            </div>
          ) : message.cards ? (
            /* Phase 1: render structured cards directly */
            <CardsBubble text={message.content} cards={message.cards} index={index} metadata={message.metadata} />
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
              onSelect={handleAddressSelect}
              onCancel={handleAddressCancel}
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
    <div className="px-4 pb-2 space-x-2 overflow-x-auto whitespace-nowrap">
      {suggestions.map(s => (
        <button
          key={s}
          onClick={() => setInput(s)}
          className="mb-2 rounded-full px-3 py-1 text-xs bg-white/5 hover:bg-white/10 border border-white/10 text-stone-300"
        >
          {s}
        </button>
      ))}
    </div>

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
    <form
      onSubmit={handleSubmit}
      className="border-t border-white/10 p-4 sticky bg-stone-950/90 backdrop-blur z-10"
      style={{ bottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex space-x-2">
        <input
          type="text"
          value={input}
          onKeyDown={handleKeyDown}
          onChange={e => setInput(e.target.value)}
          disabled={isLoading}
          placeholder="Enter APN (5843-004-015) or address (3652 Monterosa Dr)…"
          aria-label="Message input"
          className="flex-1 p-2 rounded-md bg-white/5 border border-white/10 text-stone-100 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-amber-400/40 focus:border-amber-400/40 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          className="bg-stone-100 text-stone-950 px-4 py-2 rounded-md hover:bg-white focus:outline-none focus:ring-2 focus:ring-amber-400/40 disabled:bg-white/10 disabled:text-stone-600"
        >
          Send
        </button>
      </div>
      <p className="mt-1 text-[11px] text-stone-500">
        Press Enter to send • Supports APN or street address
      </p>
    </form>
  </div>
);
  
}
