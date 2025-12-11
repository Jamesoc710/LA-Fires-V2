
/* -------------------------------------------------------------------------- */
/*                            NORMALIZED INTERFACES                           */
/* -------------------------------------------------------------------------- */

export interface RawZoningData {
  [key: string]: any;
}

export interface NormalizedZoning {
  jurisdiction: string;
  zone: string;
  zoneDescription: string;
  generalPlan: string | null;
  generalPlanDescription: string | null;
  communityPlanArea: string | null;
  specificPlan: string | null;
  raw: RawZoningData;  // Keep original for debugging
}

/* -------------------------------------------------------------------------- */
/*                        FIELD NAME VARIATIONS BY TYPE                       */
/* -------------------------------------------------------------------------- */

// Zone code fields - the actual zone designation (R-1, RS-4, etc.)
const ZONE_CODE_FIELDS = [
  'ZONE_CODE', 'ZONE', 'ZONE_SYMBOL', 'ZONE_', 'ZONING',
  'ZoneCode', 'Zone', 'PLAN_LEG_ZONE', 'Z_CODE', 'ZONECODE',
  'zone_code', 'zone', 'zoning',
];

// Zone description fields - human-readable zone name
const ZONE_DESC_FIELDS = [
  'ZONE_DESC', 'ZONE_DESCRIPTION', 'DESCRIPTIO', 'DESCRIPTION',
  'Z_DESC', 'ZoneDesc', 'ZoneDescription', 'ZONE_NAME',
  'zone_desc', 'zone_description', 'description',
  // NOT including CATEGORY here - handled specially per jurisdiction
];

// General plan designation (e.g., LDR, Low Residential)
const GENERAL_PLAN_FIELDS = [
  'GEN_PLAN', 'GENERAL_PLAN', 'GP_DESIG', 'GPLU', 'GeneralPlan',
  'LAND_USE', 'LandUse', 'GP', 'gen_plan', 'general_plan',
];

// General plan description (e.g., "Low Density Residential")
const GENERAL_PLAN_DESC_FIELDS = [
  'GEN_PLAN_DESC', 'GP_DESC', 'GPLU_DESC', 'GeneralPlanDesc',
  'LAND_USE_DESC', 'LandUseDesc', 'GEN_PLAN_DESCRIPTION',
  'GENERAL_PLAN_DESC', 'gen_plan_desc', 'gp_desc',
];

// Community/Planning area (e.g., "Silver Lake", "West San Gabriel Valley")
const COMMUNITY_PLAN_FIELDS = [
  'CPA', 'COMMUNITY_PLAN', 'PLANNINGAREA', 'PLANNING_AREA',
  'CommunityPlan', 'PlanArea', 'PLAN_AREA', 'CP_NAME',
  'PLNG_AREA', 'COMM_PLAN', 'COMM_NAME', 'AREA_NAME',
  'cpa', 'community_plan', 'planning_area',
];

// Specific plan name
const SPECIFIC_PLAN_FIELDS = [
  'SPECIFIC_PLAN', 'SPEC_PLAN', 'SPA_NAME', 'SpecificPlan',
  'SP_NAME', 'PLAN_NAME', 'SPECIFICPLAN', 'SPA_NM',
  'specific_plan', 'spec_plan',
];

// Category field (used differently by LA City vs Unincorporated)
const CATEGORY_FIELDS = [
  'CATEGORY', 'Z_CATEGORY', 'ZONE_CATEGORY', 'Category',
  'category', 'zone_category',
];

// GEN_CODE field (Pasadena-specific for zone description)
const GEN_CODE_FIELDS = [
  'GEN_CODE', 'GenCode', 'GENCODE', 'gen_code',
];

/* -------------------------------------------------------------------------- */
/*                            HELPER FUNCTIONS                                */
/* -------------------------------------------------------------------------- */

/**
 * Find the first non-empty value from a list of possible field names.
 * Case-insensitive matching with multiple fallback strategies.
 */
function findField(data: RawZoningData, fieldList: string[]): string | null {
  if (!data) return null;
  
  for (const field of fieldList) {
    // Try exact match
    if (field in data) {
      const val = data[field];
      if (isValidValue(val)) return String(val).trim();
    }
    
    // Try lowercase match
    const lowerField = field.toLowerCase();
    if (lowerField in data) {
      const val = data[lowerField];
      if (isValidValue(val)) return String(val).trim();
    }
    
    // Try uppercase match
    const upperField = field.toUpperCase();
    if (upperField in data) {
      const val = data[upperField];
      if (isValidValue(val)) return String(val).trim();
    }
  }
  
  return null;
}

/**
 * Check if a value is meaningful (not null, empty, or placeholder).
 */
function isValidValue(val: any): boolean {
  if (val == null) return false;
  if (typeof val !== 'string' && typeof val !== 'number') return false;
  
  const normalized = String(val).trim().toLowerCase();
  
  return (
    normalized !== '' &&
    normalized !== 'null' &&
    normalized !== 'none' &&
    normalized !== 'n/a' &&
    normalized !== 'unknown' &&
    normalized !== 'undefined' &&
    normalized !== '-' &&
    normalized.length > 0
  );
}

/**
 * Normalize a jurisdiction name to a standard format for comparison.
 */
function normalizeJurisdictionName(name: string): string {
  return name.toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^city of\s+/i, '')
    .replace(/\s+city$/i, '');
}

/**
 * Detect jurisdiction type for special field handling.
 */
type JurisdictionType = 'los_angeles' | 'pasadena' | 'unincorporated' | 'other';

function detectJurisdictionType(jurisdiction: string): JurisdictionType {
  const norm = normalizeJurisdictionName(jurisdiction);
  
  if (norm === 'los angeles' || norm.includes('los angeles')) {
    return 'los_angeles';
  }
  if (norm === 'pasadena' || norm.includes('pasadena')) {
    return 'pasadena';
  }
  if (
    norm.includes('unincorporated') ||
    norm === 'unknown' ||
    norm === ''
  ) {
    return 'unincorporated';
  }
  
  return 'other';
}

/* -------------------------------------------------------------------------- */
/*                         MAIN NORMALIZATION FUNCTION                        */
/* -------------------------------------------------------------------------- */

/**
 * FIX #32, #33, #34: Normalize raw zoning data to a consistent structure.
 * 
 * This function handles the complexity of different jurisdictions using
 * different field names for the same concepts:
 * 
 * - Pasadena: ZONE_CODE, GEN_CODE (description), GEN_PLAN, GEN_PLAN_DESC
 * - LA City: ZONE_SYMBOL, CATEGORY (description), CPA
 * - Unincorporated: ZONE, Z_DESC/DESCRIPTION, PLNG_AREA, Z_CATEGORY (zone code shorthand)
 * 
 * The CATEGORY field is particularly tricky:
 * - In LA City: CATEGORY is a description like "Single Family Residential"
 * - In Unincorporated: CATEGORY/Z_CATEGORY is a zone code shorthand like "R-1"
 */
export function normalizeZoningData(
  raw: RawZoningData,
  jurisdiction: string
): NormalizedZoning {
  if (!raw) {
    return {
      jurisdiction,
      zone: 'Unknown',
      zoneDescription: 'Unknown',
      generalPlan: null,
      generalPlanDescription: null,
      communityPlanArea: null,
      specificPlan: null,
      raw: {},
    };
  }

  const jurisdictionType = detectJurisdictionType(jurisdiction);
  
  // ─────────────────────────────────────────────────────────────────────────
  // ZONE CODE: The actual zoning designation (R-1, RS-4, R1-1VL, etc.)
  // ─────────────────────────────────────────────────────────────────────────
  let zone = findField(raw, ZONE_CODE_FIELDS);
  
  // ─────────────────────────────────────────────────────────────────────────
  // ZONE DESCRIPTION: Human-readable zone name
  // This is where we handle the CATEGORY field ambiguity (Fix #33)
  // ─────────────────────────────────────────────────────────────────────────
  let zoneDescription = findField(raw, ZONE_DESC_FIELDS);
  
  // Pasadena uses GEN_CODE as the zone description
  if (!zoneDescription && jurisdictionType === 'pasadena') {
    zoneDescription = findField(raw, GEN_CODE_FIELDS);
  }
  
  // Handle CATEGORY field based on jurisdiction type (Fix #33)
  const categoryValue = findField(raw, CATEGORY_FIELDS);
  
  if (categoryValue) {
    if (jurisdictionType === 'los_angeles') {
      // LA City: CATEGORY is the zone description (e.g., "Single Family Residential")
      if (!zoneDescription) {
        zoneDescription = categoryValue;
      }
    } else if (jurisdictionType === 'unincorporated') {
      // Unincorporated: Z_CATEGORY is zone code shorthand (e.g., "R-1")
      // Don't use it as description - use Z_DESC or DESCRIPTION instead
      // If we still don't have a description, look for specific county fields
      if (!zoneDescription) {
        zoneDescription = raw.Z_DESC || raw.DESCRIPTION || null;
      }
    } else {
      // Other cities: try to use CATEGORY as description if nothing else
      if (!zoneDescription) {
        zoneDescription = categoryValue;
      }
    }
  }
  
  // Fallback: if we still have no description, use zone code
  if (!zoneDescription && zone) {
    zoneDescription = zone;
  }
  
  // If we still have no zone code, try to extract from description or other fields
  if (!zone) {
    zone = 'Unknown';
  }
  
  if (!zoneDescription) {
    zoneDescription = 'Unknown';
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // GENERAL PLAN: Land use designation
  // ─────────────────────────────────────────────────────────────────────────
  const generalPlan = findField(raw, GENERAL_PLAN_FIELDS);
  const generalPlanDescription = findField(raw, GENERAL_PLAN_DESC_FIELDS);
  
  // ─────────────────────────────────────────────────────────────────────────
  // COMMUNITY/PLANNING AREA
  // ─────────────────────────────────────────────────────────────────────────
  const communityPlanArea = findField(raw, COMMUNITY_PLAN_FIELDS);
  
  // ─────────────────────────────────────────────────────────────────────────
  // SPECIFIC PLAN (if applicable)
  // ─────────────────────────────────────────────────────────────────────────
  const specificPlan = findField(raw, SPECIFIC_PLAN_FIELDS);
  
  return {
    jurisdiction,
    zone,
    zoneDescription,
    generalPlan,
    generalPlanDescription,
    communityPlanArea,
    specificPlan,
    raw,
  };
}

/* -------------------------------------------------------------------------- */
/*                    FORMAT NORMALIZED ZONING FOR CONTEXT                    */
/* -------------------------------------------------------------------------- */

/**
 * Format normalized zoning data into a consistent string for LLM context.
 * Only includes fields that have meaningful values.
 */
export function formatZoningForContext(zoning: NormalizedZoning): string {
  const lines: string[] = [];
  
  // Required fields - always show
  lines.push(`JURISDICTION: ${zoning.jurisdiction}`);
  lines.push(`ZONE: ${zoning.zone}`);
  
  // Zone description - only if different from zone code
  if (
    isValidValue(zoning.zoneDescription) &&
    zoning.zoneDescription.toLowerCase() !== zoning.zone.toLowerCase()
  ) {
    lines.push(`ZONE DESCRIPTION: ${zoning.zoneDescription}`);
  }
  
  // General plan - only if available
  if (isValidValue(zoning.generalPlan)) {
    lines.push(`GENERAL PLAN: ${zoning.generalPlan}`);
  }
  
  // General plan description - only if available and different from GP code
  if (
    isValidValue(zoning.generalPlanDescription) &&
    zoning.generalPlanDescription !== zoning.generalPlan
  ) {
    lines.push(`GENERAL PLAN DESCRIPTION: ${zoning.generalPlanDescription}`);
  }
  
  // Community/Planning area - only if available
  if (isValidValue(zoning.communityPlanArea)) {
    lines.push(`COMMUNITY/PLANNING AREA: ${zoning.communityPlanArea}`);
  }
  
  // Specific plan - only if available
  if (isValidValue(zoning.specificPlan)) {
    lines.push(`SPECIFIC PLAN: ${zoning.specificPlan}`);
  }
  
  return lines.join('\n');
}

/**
 * Create a sanitized card object for tool context JSON.
 * Excludes raw data and only includes meaningful fields.
 */
export function createZoningCard(zoning: NormalizedZoning): Record<string, any> {
  const card: Record<string, any> = {
    jurisdiction: zoning.jurisdiction,
    zone: zoning.zone,
  };
  
  if (
    isValidValue(zoning.zoneDescription) &&
    zoning.zoneDescription.toLowerCase() !== zoning.zone.toLowerCase()
  ) {
    card.zoneDescription = zoning.zoneDescription;
  }
  
  if (isValidValue(zoning.generalPlan)) {
    card.generalPlan = zoning.generalPlan;
  }
  
  if (
    isValidValue(zoning.generalPlanDescription) &&
    zoning.generalPlanDescription !== zoning.generalPlan
  ) {
    card.generalPlanDescription = zoning.generalPlanDescription;
  }
  
  if (isValidValue(zoning.communityPlanArea)) {
    card.communityPlanArea = zoning.communityPlanArea;
  }
  
  if (isValidValue(zoning.specificPlan)) {
    card.specificPlan = zoning.specificPlan;
  }
  
  return card;
}
