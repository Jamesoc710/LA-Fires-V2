'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { Message } from '../types/chat';
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

/* ------------ tiny utils to parse our assistant text into sections ----------- */

type SectionData = Record<string, string>;

// Grouped overlay structure
type OverlayCategory = {
  name: string;
  items: string[];
};
type GroupedOverlays = {
  jurisdiction?: string;
  categories: OverlayCategory[];
};

type ParsedReply = {
  raw: string;
  apn?: string;
  ain?: string;
  zoning?: SectionData;
  overlays?: SectionData;           // legacy flat format
  groupedOverlays?: GroupedOverlays; // grouped format
  assessor?: SectionData;
  // FIX #9: Track if this is an error response
  isParcelNotFound?: boolean;
  errorMessage?: string;
};
type SectionKind = 'zoning' | 'overlays' | 'assessor' | null;

function sectionKindFrom(line: string): SectionKind {
  const s = line.trim().toLowerCase().replace(/\*\*/g, '');

  // ignore "section: unknown"
  if (/^section\s*:\s*unknown\b/.test(s)) return null;

  // Accept "Zoning", "City Zoning", "Section: Zoning", etc.
  if (/^(section\s*:\s*)?(city\s+)?zoning\s*:?\s*$/.test(s)) return 'zoning';

  // Accept "Overlays", "City Overlays", "Overlay", etc.
  if (/^(section\s*:\s*)?(city\s+)?overlays?\s*:?\s*$/.test(s)) return 'overlays';

  // Assessor is usually just "Assessor"
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

function addKV(data: SectionData, k: string, v: string) {
  const norm = normalizeKey(k);
  let key = norm;

  // if this key already exists, add _2, _3, ...
  if (data[key] !== undefined) {
    let i = 2;
    while (data[`${norm}_${i}`] !== undefined) {
      i++;
    }
    key = `${norm}_${i}`;
  }

  data[key] = v;
}

// Check if a line is a category header (e.g., "HAZARDS:", "HISTORIC PRESERVATION:")
function isCategoryHeader(line: string): string | null {
  const trimmed = line.trim();
  // Match lines like "HAZARDS:", "HISTORIC PRESERVATION:", "OTHER:" etc.
  // Must be all caps (or title case) and end with colon, no value after
  const match = trimmed.match(/^([A-Z][A-Z\s&]+):$/);
  if (match) {
    return match[1].trim();
  }
  // Also match title case like "Land Use & Planning:"
  const titleMatch = trimmed.match(/^([A-Z][a-zA-Z\s&]+):$/);
  if (titleMatch && !trimmed.includes('—')) {
    return titleMatch[1].trim();
  }
  return null;
}

// Check if a line is a bullet item
function isBulletItem(line: string): string | null {
  const trimmed = line.trim();
  // Match lines starting with bullet character or dash
  const match = trimmed.match(/^[•\-\*]\s*(.+)$/);
  if (match) {
    return match[1].trim();
  }
  return null;
}

// Parse grouped overlays format
function parseGroupedOverlays(lines: string[], startIndex: number): { end: number; data: GroupedOverlays } {
  const data: GroupedOverlays = { categories: [] };
  let i = startIndex + 1;
  let currentCategory: OverlayCategory | null = null;

  while (i < lines.length && sectionKindFrom(lines[i]) === null) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Check for JURISDICTION line
    const kvMatch = extractKV(line);
    if (kvMatch && kvMatch[0].toUpperCase() === 'JURISDICTION') {
      data.jurisdiction = kvMatch[1];
      i++;
      continue;
    }

    // Check for category header
    const categoryName = isCategoryHeader(line);
    if (categoryName) {
      // Save previous category if exists
      if (currentCategory && currentCategory.items.length > 0) {
        data.categories.push(currentCategory);
      }
      currentCategory = { name: categoryName, items: [] };
      i++;
      continue;
    }

    // Check for bullet item
    const bulletItem = isBulletItem(line);
    if (bulletItem && currentCategory) {
      currentCategory.items.push(bulletItem);
      i++;
      continue;
    }

    // If it's a regular KV line that's not jurisdiction, might be legacy format
    // Skip empty lines
    if (!trimmed) {
      i++;
      continue;
    }

    i++;
  }

  // Don't forget the last category
  if (currentCategory && currentCategory.items.length > 0) {
    data.categories.push(currentCategory);
  }

  return { end: i, data };
}

// Check if overlays section uses grouped format
function isGroupedOverlayFormat(lines: string[], startIndex: number): boolean {
  // Look ahead to see if we find category headers or bullets
  for (let i = startIndex + 1; i < Math.min(startIndex + 10, lines.length); i++) {
    if (sectionKindFrom(lines[i]) !== null) break;
    if (isCategoryHeader(lines[i])) return true;
    if (isBulletItem(lines[i])) return true;
  }
  return false;
}


function parseAssistantText(text: string): ParsedReply | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);

  const parsed: ParsedReply = { raw: text };

  // FIX #9: Detect parcel not found or retrieval errors
  const lowerText = text.toLowerCase();
  
  // Check for various error patterns
  const isParcelError = (
    // Direct "not found" patterns
    (lowerText.includes('parcel') && lowerText.includes('not found')) ||
    (lowerText.includes('no parcel found')) ||
    // APN verification errors
    (lowerText.includes('apn') && lowerText.includes('verify')) ||
    (lowerText.includes('apn') && lowerText.includes('correct')) ||
    // All three sections showing "could not retrieve" = likely bad APN
    (
      lowerText.includes('zoning') && 
      lowerText.includes('overlays') && 
      lowerText.includes('assessor') &&
      (text.match(/could not retrieve/gi) || []).length >= 3
    ) ||
    // All three sections showing errors
    (
      lowerText.includes('zoning') && 
      lowerText.includes('overlays') && 
      lowerText.includes('assessor') &&
      (text.match(/please try again/gi) || []).length >= 3
    )
  );
  
  if (isParcelError) {
    parsed.isParcelNotFound = true;
    // Try to extract a specific error message
    const errorMatch = text.match(/(?:parcel.*?not found|no parcel found|could not retrieve data)[^.]*\./i);
    if (errorMatch) {
      parsed.errorMessage = errorMatch[0];
    } else {
      parsed.errorMessage = "Could not retrieve data for this APN. Please verify the number is correct.";
    }
  }

  // Try to capture APN/AIN from anywhere
  const ain = text.match(/\bAIN[:\s-]*([0-9]{10})\b/i)?.[1];
  const apnRaw = text.match(/\bAPN[:\s-]*([0-9]{4}[-\s]?[0-9]{3}[-\s]?[0-9]{3})\b/i)?.[1];
  if (ain) parsed.ain = ain;
  if (apnRaw) parsed.apn = apnRaw.replace(/\s/g, '');

  // Walk through lines, carving out sections
  for (let i = 0; i < lines.length; i++) {
    const kind = sectionKindFrom(lines[i]);
    if (!kind) continue;

    if (kind === 'overlays') {
      // Check if this is grouped format
      if (isGroupedOverlayFormat(lines, i)) {
        const { end, data } = parseGroupedOverlays(lines, i);
        if (data.categories.length > 0 || data.jurisdiction) {
          parsed.groupedOverlays = data;
        }
        i = end - 1;
        continue;
      }
    }

    // Standard KV parsing for zoning, assessor, or legacy overlays
    const data: SectionData = {};
    let j = i + 1;
    while (j < lines.length && sectionKindFrom(lines[j]) === null) {
      const kv = extractKV(lines[j]);
      if (kv) {
        const [k, v] = kv;
        addKV(data, k, v);
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
  const hasStructured = parsed.zoning || parsed.overlays || parsed.groupedOverlays || parsed.assessor;
  return hasStructured ? parsed : { ...parsed, raw: text };
}

/* -------------------------------- UI bits -------------------------------- */

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-slate-200 dark:bg-slate-600 text-slate-800 dark:text-slate-100 px-2 py-0.5 text-xs font-medium">
      {children}
    </span>
  );
}

// FIX #7, #8: Format values with units for display
function formatValueWithUnits(key: string, value: string): string {
  const normalizedKey = key.toUpperCase().replace(/[_\s]/g, '');
  
  // Skip formatting for certain values
  if (!value || value === 'None' || value === 'N/A' || value === 'null' || value === '0') {
    if (normalizedKey === 'LIVINGAREA' || normalizedKey === 'LOTSQFT' || normalizedKey === 'LOTSQUAREFEET') {
      return 'Not available';
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
            {/* FIX #7, #8: Apply unit formatting for assessor fields */}
            <dd className="text-sm">{formatValueWithUnits(k, v)}</dd>
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

// Grouped Overlays Card Component with FIX #10
function GroupedOverlaysCard({
  data,
  onCopy,
}: {
  data: GroupedOverlays;
  onCopy: () => void;
}) {
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
    <div className="rounded-2xl bg-slate-100 dark:bg-slate-700/70 text-slate-900 dark:text-slate-100 ring-1 ring-slate-200 dark:ring-slate-600 p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-base font-semibold">Overlays</h3>
        <button
          type="button"
          onClick={onCopy}
          className="text-xs px-2 py-1 rounded-md bg-slate-200 dark:bg-slate-600 hover:bg-slate-300 dark:hover:bg-slate-500"
          aria-label="Copy Overlays"
          title="Copy Overlays"
        >
          Copy
        </button>
      </div>
      
      {/* Jurisdiction line */}
      {data.jurisdiction && (
        <div className="flex mb-3">
          <span className="w-40 shrink-0 text-sm font-semibold text-slate-800 dark:text-slate-200">
            JURISDICTION:
          </span>
          <span className="text-sm">{data.jurisdiction}</span>
        </div>
      )}

      {/* Categories */}
      <div className="space-y-4">
        {categoriesWithPlaceholders.map((category, idx) => {
          const isPlaceholder = category.items.length === 1 && category.items[0] === 'None found for this parcel';
          return (
            <div key={idx}>
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">
                {category.name}
              </h4>
              <ul className="space-y-1 ml-1">
                {category.items.map((item, itemIdx) => (
                  <li 
                    key={itemIdx} 
                    className={`text-sm flex items-start gap-2 ${isPlaceholder ? 'text-slate-500 dark:text-slate-400 italic' : ''}`}
                  >
                    <span className="text-slate-400 dark:text-slate-500 select-none">•</span>
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

// FIX #9: Error card for invalid APN or data retrieval failures
function ParcelNotFoundCard({ apn, message }: { apn?: string; message?: string }) {
  return (
    <div className="rounded-2xl bg-orange-50 dark:bg-orange-900/30 text-orange-900 dark:text-orange-100 ring-1 ring-orange-200 dark:ring-orange-700 p-4">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0">
          <svg className="h-6 w-6 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
              className="inline-flex items-center text-sm font-medium text-orange-700 dark:text-orange-300 hover:underline"
            >
              Look up your APN ↗
            </a>
            <span className="text-orange-400">|</span>
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center text-sm font-medium text-orange-700 dark:text-orange-300 hover:underline"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
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
    "What's the zoning for APN 5843-004-015?",
    "Show overlays only for AIN 5843004015",
    "Assessor details for APN 5843-003-012",
    "Explain H5 plan designation",
  ];

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

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

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      const assistantMessage: Message = {
        role: 'assistant',
        content: data.response || 'Sorry, I could not generate a response.',
      };
      setMessages(prev => [...prev, assistantMessage]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
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

  function AssistantBubble({ text, index }: { text: string; index: number }) {
    const parsed = useMemo(() => parseAssistantText(text), [text]);
    const showRaw = showRawForIndex === index;

    // FIX #4, #5: Extract jurisdiction for conditional viewer links
    const jurisdiction = useMemo(() => {
      // Try to get jurisdiction from zoning data
      if (parsed?.zoning?.JURISDICTION) {
        return parsed.zoning.JURISDICTION;
      }
      // Try from grouped overlays
      if (parsed?.groupedOverlays?.jurisdiction) {
        return parsed.groupedOverlays.jurisdiction;
      }
      return null;
    }, [parsed]);

    // FIX #4, #5: Determine which viewer links to show
    const showCountyViewers = shouldShowCountyViewers(jurisdiction);
    const cityViewer = getViewerUrlForJurisdiction(jurisdiction);

    // Build "copy all" text quickly (sections if present, else raw)
    const buildCopyAll = () => {
      const blocks: string[] = [];
      if (parsed?.zoning) {
        blocks.push('Zoning');
        blocks.push(
          ...Object.entries(parsed.zoning).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
        );
        blocks.push('');
      }
      if (parsed?.groupedOverlays) {
        blocks.push(buildGroupedOverlaysCopyText(parsed.groupedOverlays));
        blocks.push('');
      } else if (parsed?.overlays) {
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
      {/* FIX #9: Show error card for parcel not found */}
      {parsed?.isParcelNotFound && (
        <ParcelNotFoundCard apn={parsed.apn} message={parsed.errorMessage} />
      )}

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
        
        {/* FIX #5: City-specific viewer link */}
        {cityViewer && (
          <a
            href={cityViewer.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center rounded-full bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-100 px-2 py-0.5 text-xs font-medium hover:underline"
            title={`Open ${cityViewer.name}`}
          >
            {cityViewer.name} ↗
          </a>
        )}
        
        {/* FIX #4: Only show ZNET/GISNET for unincorporated areas */}
        {showCountyViewers && (
          <>
            <a
              href={znetViewerUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-100 px-2 py-0.5 text-xs font-medium hover:underline"
              title="Open ZNET Viewer"
            >
              ZNET ↗
            </a>
            <a
              href={gisnetViewerUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-100 px-2 py-0.5 text-xs font-medium hover:underline"
              title="Open GISNET"
            >
              GISNET ↗
            </a>
          </>
        )}

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
                groupedOverlays: parsed?.groupedOverlays ?? null,
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
      
      {/* Render grouped overlays if present, otherwise legacy flat format */}
      {parsed?.groupedOverlays && (
        <GroupedOverlaysCard
          data={parsed.groupedOverlays}
          onCopy={() => {
            const copyText = buildGroupedOverlaysCopyText(parsed.groupedOverlays!);
            navigator.clipboard.writeText(copyText).catch(() => {});
          }}
        />
      )}
      {!parsed?.groupedOverlays && parsed?.overlays && (
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
              .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${formatValueWithUnits(k, v)}`)
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

    {/* FIX #1, #2, #3: Disclaimer block */}
    <div className="px-4 pb-2 border-t border-slate-200 dark:border-slate-700 pt-2">
      <p className="text-xs text-slate-500 dark:text-slate-400 text-center leading-relaxed">
        <span className="font-medium">⚠️ Data shown is for informational purposes only.</span>
        {' '}Not an official zoning determination. Some overlay types may not be included. Data may not reflect recent zone changes.
        {' '}Verify all information with the appropriate planning department before making decisions.
      </p>
      <p className="text-xs text-slate-400 dark:text-slate-500 text-center mt-1">
        Contact your local planning department for official determinations.
      </p>
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
