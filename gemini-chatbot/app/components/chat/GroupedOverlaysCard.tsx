import {
  DATA_SOURCES,
  type GroupedOverlays,
  type OverlayViewCategory,
  type CopiedSection,
} from './formatters';

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
  const categoriesWithPlaceholders: OverlayViewCategory[] = [...data.categories];

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

export default GroupedOverlaysCard;
