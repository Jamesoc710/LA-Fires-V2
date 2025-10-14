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
