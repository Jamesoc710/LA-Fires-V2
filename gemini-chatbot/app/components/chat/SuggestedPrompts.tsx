const suggestions = [
  "Zoning, overlays and assessor details for 5314 La Crescenta Ave",
  "Overlay details for APN 5843-004-015",
  "Show zoning for 2013 Lemoyne St",
  "Assessor details for AIN 5843003012",
];

function SuggestedPrompts({ onPick }: { onPick: (s: string) => void }) {
  return (
    <div className="px-4 pb-2 space-x-2 overflow-x-auto whitespace-nowrap">
      {suggestions.map(s => (
        <button
          key={s}
          onClick={() => onPick(s)}
          className="mb-2 rounded-full px-3 py-1 text-xs bg-white/5 hover:bg-white/10 border border-white/10 text-stone-300"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

export default SuggestedPrompts;
