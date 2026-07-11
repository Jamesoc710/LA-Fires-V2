import type { Citation } from '../../types/chat';
import Chip from './Chip';

// Amber viewer-link pill, copied from CardsBubble's `viewerLinkClass` so a
// linked citation matches the parcel viewer links exactly.
const citationLinkClass =
  'inline-flex items-center rounded-full border border-amber-400/20 bg-amber-400/10 text-amber-300 hover:text-amber-200 px-2 py-0.5 text-xs font-medium';

// Compact label for a citation:
//   "SECTION 1031 - EMERGENCY ESCAPE AND RESCUE" -> "§ 1031"
//   "SECTION H103 - LOCATION"                    -> "§ H103"
//   "(chapter introduction)" / ""                -> chapter short id (below)
// Chapter fallback (no section):
//   "CHAPTER 10 - MEANS OF EGRESS" -> "CH 10"
//   "APPENDIX H - SIGNS"           -> "APP H"
function citationLabel(citation: Citation): string {
  const sectionMatch = citation.section.match(/SECTION\s+([0-9A-Z]+)/i);
  if (sectionMatch) return `§ ${sectionMatch[1]}`;

  const chapterMatch = citation.chapter.match(/^(CHAPTER|APPENDIX)\s+(\S+)/i);
  if (chapterMatch) {
    const prefix = chapterMatch[1].toUpperCase() === 'APPENDIX' ? 'APP' : 'CH';
    return `${prefix} ${chapterMatch[2]}`;
  }
  return citation.chapter || 'Code section';
}

// Shared chip row of Title 26 code-section citations backing a narrative answer.
function CitationChips({ citations }: { citations?: Citation[] }) {
  if (!citations || citations.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <span className="text-xs text-stone-500">Code sections</span>
      {citations.map((c, idx) => {
        const label = citationLabel(c);
        const description = `${c.chapter} — ${c.section}`;
        const key = `${c.chapter}|${c.section}|${idx}`;

        return c.url ? (
          <a
            key={key}
            href={c.url}
            target="_blank"
            rel="noopener noreferrer"
            className={citationLinkClass}
            title={description}
            aria-label={description}
          >
            {label} ↗
          </a>
        ) : (
          <span key={key} title={description} aria-label={description}>
            <Chip>{label}</Chip>
          </span>
        );
      })}
    </div>
  );
}

export default CitationChips;
