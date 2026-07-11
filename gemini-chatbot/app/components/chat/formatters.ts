import type {
  AssessorCard,
  OverlayGroupCard,
  StandardizedZoningCard,
} from '../../types/chat';

/* ------------ view models derived from structured cards ----------- */

export type SectionData = Record<string, string>;

// Grouped overlay structure (built from cards, rendered by GroupedOverlaysCard)
export type OverlayViewCategory = {
  name: string;
  items: string[];
};
export type GroupedOverlays = {
  jurisdiction?: string;
  categories: OverlayViewCategory[];
};

// FIX #40: Copy confirmation state type
export type CopiedSection = 'zoning' | 'overlays' | 'assessor' | 'all' | null;

// Simple file download helper
export function downloadFile(filename: string, contents: string, mime = 'application/json') {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// FIX #35: Format field labels to be more readable
export function formatFieldLabel(key: string): string {
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
export function formatFieldValue(key: string, value: string): string {
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
export const DATA_SOURCES: Record<string, string> = {
  'Zoning': 'LA County GIS / City GIS',
  'Overlays': 'LA County GIS / City GIS',
  'Assessor': 'LA County Assessor',
};

// Helper to format APN for display (XXXX-XXX-XXX format)
export function formatApnDisplay(apn: string): string {
  const digits = apn.replace(/\D/g, '');
  if (digits.length === 10) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return apn;
}

/* --------- Phase 1: build SectionData/overlays from structured cards --------- */

// Keys are chosen so the shared formatFieldLabel/formatFieldValue helpers
// produce the expected labels ("ZONE DESCRIPTION", etc.) and value formatting.
export function buildZoningData(card: StandardizedZoningCard): SectionData {
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

export function buildAssessorData(card: AssessorCard): SectionData {
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

export function buildGroupedFromCards(groups: OverlayGroupCard[] | undefined, jurisdiction?: string): GroupedOverlays {
  const categories: OverlayViewCategory[] = (groups || [])
    .filter(g => g.items.length > 0 || CARD_KEY_CATEGORIES.includes(g.category))
    .map(g => ({
      name: g.category.toUpperCase(),
      items: g.items.length
        ? g.items.map(it => (it.details ? `${it.name} — ${it.details}` : it.name))
        : ['None found for this parcel'],
    }));
  return { jurisdiction, categories };
}

// Helper to build copy text for grouped overlays
export function buildGroupedOverlaysCopyText(data: GroupedOverlays): string {
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
