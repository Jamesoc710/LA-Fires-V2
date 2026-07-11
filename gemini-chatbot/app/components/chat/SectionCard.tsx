import {
  DATA_SOURCES,
  formatFieldLabel,
  formatFieldValue,
  type SectionData,
  type CopiedSection,
} from './formatters';

// FIX #37, #40: Updated SectionCard with source attribution and clearer copy button
export function SectionCard({
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

// Non-data section states (no_data / error / not_configured / not_implemented).
export function SectionMessageCard({ title, message }: { title: string; message?: string }) {
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
