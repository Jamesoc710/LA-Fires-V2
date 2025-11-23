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

export type OverlaySource  =   "County" | "LA City" | "Pasadena" | "Other City";

export type OverlayProgram = "CSD" | "SUD" | "HPOZ" | "Other";

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
