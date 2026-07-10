// lib/la/types.ts
// Phase 5A: Added NormalizedZoning interface for standardized zoning fields

export type ZoningResult = {
  input: { address?: string; apn?: string; lat?: number; lng?: number };
  jurisdiction: "Unincorporated LA County" | "City of Los Angeles" | "Other" | "Unknown";
  apn?: string;
  community?: string;
  planningArea?: string;
  zoning?: string;           // e.g., "R-1"
  overlays?: string[];       // e.g., ["Hillside", "CSD: Altadena"]
  links: {
    znet?: string;
    gisnet?: string;
    title22?: string;
    assessor?: string;
    permits?: string;
  };
};

export type AssessorResult = {
  input: { address?: string; apn?: string };
  apn?: string;
  situsAddress?: string;
  useCode?: string;
  landSqft?: number;
  livingAreaSqft?: number;
  yearBuilt?: number;
  links: { assessor?: string };
};

// ---------------------------------------------------------
// Overlay cards (shared format for County + LA City)
// ---------------------------------------------------------

export type OverlaySource  =   "County" | "City";

export type OverlayProgram = "CSD" | "SUD" | "HPOZ" | "SEA" | "Other";

export type OverlayCard = {
  /** Where this overlay came from (DRP vs City) */
  source: OverlaySource;

  /** Program family, e.g. County CSD or City SUD/HPOZ */
  program: OverlayProgram;

  /** Human-readable name, e.g. "Hillside", "Downtown", "Angelino Heights" */
  name: string;

  /** Optional one-line description / extra detail */
  details?: string;

  /** Raw attributes from the GIS feature */
  attributes: Record<string, any>;
};

// ---------------------------------------------------------
// FIX #32, #33, #34: Normalized Zoning Interface
// Standardized fields across all jurisdictions
// ---------------------------------------------------------

export interface RawZoningData {
  [key: string]: any;
}

/**
 * Normalized zoning data structure that uses consistent field names
 * regardless of which jurisdiction the parcel is in.
 * 
 * This solves the problem where:
 * - Pasadena uses: GEN_CODE, GEN_PLAN, ZONE_CODE
 * - LA City uses: CATEGORY, ZONE_SYMBOL, CPA
 * - Unincorporated uses: Z_DESC, ZONE, PLNG_AREA, Z_CATEGORY
 * 
 * Now all are mapped to consistent names for user-facing output.
 */
export interface NormalizedZoning {
  /** The jurisdiction name (e.g., "Los Angeles", "Pasadena", "Unincorporated LA County (Altadena)") */
  jurisdiction: string;
  
  /** The zone code (e.g., "R1-1VL", "RS-4", "R-1-10000") */
  zone: string;
  
  /** Human-readable zone description (e.g., "Single Family Residential") */
  zoneDescription: string;
  
  /** General plan designation if available (e.g., "LDR", "Low Residential") */
  generalPlan: string | null;
  
  /** General plan description if available (e.g., "Low Density Residential") */
  generalPlanDescription: string | null;
  
  /** Community or planning area name if available (e.g., "Silver Lake", "West San Gabriel Valley") */
  communityPlanArea: string | null;
  
  /** Specific plan name if available (e.g., "Warner Center Specific Plan") */
  specificPlan: string | null;
  
  /** Original raw data for debugging purposes */
  raw: RawZoningData;
}

/**
 * Standardized zoning card for tool context output.
 * Only includes fields that have meaningful values.
 */
export interface StandardizedZoningCard {
  jurisdiction: string;
  zone: string;
  zoneDescription?: string;
  generalPlan?: string;
  generalPlanDescription?: string;
  /** Community or planning area (createZoningCard emits this as `planningArea`) */
  planningArea?: string;
  specificPlan?: string;
}

// ---------------------------------------------------------
// Structured chat API contract (Phase 1)
// The server returns these cards directly so the client
// never has to reconstruct them from LLM prose.
// ---------------------------------------------------------

export type SectionStatus =
  | "success"
  | "no_data"
  | "error"
  | "not_configured"
  | "not_implemented"
  | "address_multiple"
  | "skipped"; // section not requested by the user's query

export type OverlayCategory =
  | "Hazards"
  | "Environmental Protection"
  | "Development Regulations"
  | "Historic Preservation"
  | "Supplemental Use Districts"
  | "Community Standards"
  | "Land Use & Planning"
  | "Additional Overlays";

export type OverlayGroupItem = {
  name: string;
  details?: string;
  source: OverlaySource;
  program: OverlayProgram;
};

export type OverlayGroupCard = {
  category: OverlayCategory;
  items: OverlayGroupItem[];
};

/** Mirrors the field names returned by lookupAssessor in fetchers.ts */
export type AssessorCard = {
  ain?: string | number;
  apn?: string;
  situs?: string;
  city?: string;
  zip?: string;
  use?: string;
  livingArea?: number | null;
  yearBuilt?: number | string | null;
  lotSqft?: number | null;
  units?: number | string | null;
  bedrooms?: number | string | null;
  bathrooms?: number | string | null;
  links?: Record<string, string | undefined>;
};

export type AddressMatch = {
  address: string;
  city: string;
  zip: string;
  apn: string;
};

export type ParcelCards = {
  apn?: string;
  jurisdiction?: string;
  resolvedAddress?: { address: string; apn: string };
  /** Present (length > 1) when the user must pick between multiple address matches */
  addressMatches?: AddressMatch[];
  zoning: {
    status: SectionStatus;
    message?: string;
    card?: StandardizedZoningCard;
    links?: Record<string, string | undefined>;
  };
  overlays: {
    status: SectionStatus;
    message?: string;
    groups?: OverlayGroupCard[];
    links?: Record<string, string | undefined>;
  };
  assessor: {
    status: SectionStatus;
    message?: string;
    card?: AssessorCard;
    links?: Record<string, string | undefined>;
  };
};
