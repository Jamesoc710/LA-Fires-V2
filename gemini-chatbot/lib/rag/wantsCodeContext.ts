// Cheap regex gate deciding whether a user message is likely asking about the
// building code, so we only run municode retrieval when it can plausibly help.

const CODE_TERMS = [
  'title\\s*(?:22|26)', 'building\\s+code', 'zoning\\s+code', 'municode', 'ordinance',
  'appendix\\s+[a-z]\\b', 'code\\s+(?:say|says|require\\w*|section)',
  'permit(?:s|ting)?\\b', 'inspection', 'setback', 'height\\s+limit',
  'square\\s+(?:feet|footage)', 'sq\\.?\\s?ft',
  'egress', 'emergency\\s+escape', 'window', 'stair\\w*', 'guardrail', 'handrail',
  'roof(?:ing|s)?\\b', 'chimney', 'deck\\b', 'balcon\\w*',
  'grading', 'retaining\\s+wall', 'foundation', 'soils?\\b', 'seismic', 'retrofit',
  'sprinkler', 'defensible\\s+space',
  'fire[-\\s]?(?:rated|resistan\\w*|hazard|zone|proof|wall|place)', 'wildfire',
  'garage', 'fence', 'pool', 'driveway', 'solar', 'shipping\\s+container',
  'adu\\b', 'accessory\\s+dwelling', 'addition\\b', 'remodel', 'renovat\\w*',
  'demoli(?:sh|tion)', 'emergency\\s+housing',
];
const CODE_CONTEXT_REGEX = new RegExp(`\\b(?:${CODE_TERMS.join('|')})`, 'i');
export function wantsCodeContext(query: string): boolean {
  return CODE_CONTEXT_REGEX.test(query);
}
