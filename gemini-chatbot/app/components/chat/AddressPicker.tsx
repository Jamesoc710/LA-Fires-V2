import type { AddressMatch } from '../../types/chat';
import { formatApnDisplay } from './formatters';

function AddressPicker({
  results,
  onSelect,
  onCancel,
}: {
  results: AddressMatch[];
  onSelect: (result: AddressMatch) => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-2xl bg-white/[0.04] border border-white/10 text-stone-200 p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0">
          <svg className="h-6 w-6 text-amber-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold font-serif text-stone-100 mb-1">Multiple Parcels Found</h3>
          <p className="text-sm text-stone-400 mb-3">
            Select the correct property to continue:
          </p>
        </div>
      </div>

      <div className="space-y-2 max-h-64 overflow-y-auto">
        {results.map((r, idx) => (
          <button
            key={r.apn || idx}
            onClick={() => onSelect(r)}
            className="w-full text-left p-3 rounded-lg bg-white/[0.02]
                       hover:bg-white/5
                       border border-white/10
                       transition-colors group"
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="font-medium text-stone-100 group-hover:text-amber-300">
                  {r.address}
                </div>
                <div className="text-sm text-stone-500">
                  {r.city}{r.zip ? `, ${r.zip}` : ''}
                </div>
              </div>
              <div className="text-xs font-mono bg-white/5 border border-white/10 px-2 py-1 rounded-full text-stone-300">
                {formatApnDisplay(r.apn)}
              </div>
            </div>
          </button>
        ))}
      </div>

      <button
        onClick={onCancel}
        className="text-sm text-amber-300 hover:text-amber-200 hover:underline"
      >
        ← Cancel and try a different address
      </button>
    </div>
  );
}

export default AddressPicker;
