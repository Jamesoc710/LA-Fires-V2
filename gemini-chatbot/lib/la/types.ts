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
  communityPlanArea?: string;
  specificPlan?: string;
}
