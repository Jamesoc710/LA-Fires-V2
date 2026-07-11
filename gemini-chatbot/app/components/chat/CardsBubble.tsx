import type { Message, ParcelCards } from '../../types/chat';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Viewer links (safe to import client-side; they're static urls)
import {
  assessorParcelUrl,
  znetViewerUrl,
  gisnetViewerUrl,
  // FIX #5: Import new viewer URL helpers
  getViewerUrlForJurisdiction,
  shouldShowCountyViewers,
} from '@/lib/la/endpoints';

import {
  downloadFile,
  formatFieldLabel,
  formatFieldValue,
  formatApnDisplay,
  buildZoningData,
  buildAssessorData,
  buildGroupedFromCards,
  buildGroupedOverlaysCopyText,
  type CopiedSection,
} from './formatters';
import Chip from './Chip';
import MarkdownBubble from './MarkdownBubble';
import { SectionCard, SectionMessageCard } from './SectionCard';
import GroupedOverlaysCard from './GroupedOverlaysCard';
import ParcelNotFoundCard from './ParcelNotFoundCard';

// Phase 1: render sections DIRECTLY from structured cards (no text parsing).
function CardsBubble({
  text,
  cards,
  metadata,
  showRaw,
  onToggleRaw,
  copiedSection,
  onCopy,
  onRetry,
}: {
  text: string;
  cards: ParcelCards;
  metadata?: Message['metadata'];
  showRaw: boolean;
  onToggleRaw: () => void;
  copiedSection: CopiedSection;
  onCopy: (section: CopiedSection, text: string) => void;
  onRetry?: () => void;
}) {
  const z = cards.zoning;
  const o = cards.overlays;
  const a = cards.assessor;

  const isRenderable = (s: string) => s !== 'skipped' && s !== 'address_multiple';
  const renderableSections = [z, o, a].filter(s => isRenderable(s.status));
  const anySection = renderableSections.length > 0;

  // General Q&A (all sections skipped) or the address-picker prompt: render the
  // narrative as a plain chat bubble; the picker itself renders separately.
  if (!anySection) {
    return <MarkdownBubble text={text} />;
  }

  // Parcel not found / total lookup failure: every requested section errored
  // (e.g. an invalid APN). Surface the helpful recovery card, keyed off the
  // structured card statuses rather than any text heuristic.
  const allError = renderableSections.every(s => s.status === 'error');
  if (allError) {
    return (
      <div className="w-full max-w-[92%] sm:max-w-[80%] space-y-3">
        {text.trim() && (
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        )}
        <ParcelNotFoundCard apn={cards.apn} message={z.message} onRetry={onRetry} />
      </div>
    );
  }

  const jurisdiction = cards.jurisdiction ?? null;
  const showCountyViewers = shouldShowCountyViewers(jurisdiction);
  const cityViewer = getViewerUrlForJurisdiction(jurisdiction);

  const apn = cards.apn;
  const ain = a.card?.ain != null ? String(a.card.ain) : undefined;
  const assessorAin = ain ?? apn;

  const zoningData = z.status === 'success' && z.card ? buildZoningData(z.card) : null;
  const assessorData = a.status === 'success' && a.card ? buildAssessorData(a.card) : null;
  const groupedOverlays =
    o.status === 'success' && o.groups ? buildGroupedFromCards(o.groups, jurisdiction ?? undefined) : null;

  const buildCopyAll = () => {
    const blocks: string[] = [];
    if (zoningData) {
      blocks.push('Zoning');
      blocks.push(...Object.entries(zoningData).map(([k, v]) => `${formatFieldLabel(k)}: ${formatFieldValue(k, v)}`));
      blocks.push('');
    }
    if (groupedOverlays) {
      blocks.push(buildGroupedOverlaysCopyText(groupedOverlays));
      blocks.push('');
    }
    if (assessorData) {
      blocks.push('Assessor');
      blocks.push(...Object.entries(assessorData).map(([k, v]) => `${formatFieldLabel(k)}: ${formatFieldValue(k, v)}`));
    }
    return blocks.length ? blocks.join('\n').trim() : text;
  };

  const viewerLinkClass =
    'inline-flex items-center rounded-full border border-amber-400/20 bg-amber-400/10 text-amber-300 hover:text-amber-200 px-2 py-0.5 text-xs font-medium';

  return (
    <div className="w-full max-w-[92%] sm:max-w-[80%] space-y-3">
      {/* header row: chips + viewer links + actions */}
      <div className="flex flex-wrap gap-2 items-center">
        {apn && <Chip>APN: {formatApnDisplay(apn)}</Chip>}
        {ain && <Chip>AIN: {ain}</Chip>}

        {cityViewer && (
          <a href={cityViewer.url} target="_blank" rel="noreferrer" className={viewerLinkClass} title={`Open ${cityViewer.name}`}>
            {cityViewer.name} ↗
          </a>
        )}

        {assessorAin && (
          <a href={assessorParcelUrl(assessorAin)} target="_blank" rel="noreferrer" className={viewerLinkClass} title="Open Assessor Portal">
            Assessor ↗
          </a>
        )}

        {showCountyViewers && (
          <>
            <a href={znetViewerUrl} target="_blank" rel="noreferrer" className={viewerLinkClass} title="Open ZNET Viewer">
              ZNET ↗
            </a>
            <a href={gisnetViewerUrl} target="_blank" rel="noreferrer" className={viewerLinkClass} title="Open GISNET">
              GISNET ↗
            </a>
          </>
        )}

        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={() => onCopy('all', buildCopyAll())}
            className={`text-xs px-3 py-1.5 rounded-md min-h-[36px] transition-colors ${
              copiedSection === 'all'
                ? 'bg-green-400/10 text-green-300 border border-green-400/20'
                : 'bg-white/5 hover:bg-white/10 border border-white/10 text-stone-300'
            }`}
            title="Copy entire response to clipboard"
          >
            {copiedSection === 'all' ? '✓ Copied!' : 'Copy All'}
          </button>

          <button
            type="button"
            onClick={() =>
              downloadFile(
                'lafires-reply.json',
                JSON.stringify({ apn: cards.apn ?? null, cards, content: text, metadata: metadata ?? null }, null, 2)
              )
            }
            className="text-xs px-3 py-1.5 rounded-md min-h-[36px] bg-white/5 hover:bg-white/10 border border-white/10 text-stone-300"
            title="Download response as JSON file"
          >
            Download JSON
          </button>
        </div>
      </div>

      {metadata?.queriedAt && (
        <p className="text-xs text-stone-500">
          Retrieved {new Date(metadata.queriedAt).toLocaleString()}
        </p>
      )}

      {/* LLM narrative answer (streams in) rendered above the data cards */}
      {text.trim() && (
        <div className="prose prose-invert prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      )}

      {/* Zoning */}
      {isRenderable(z.status) &&
        (zoningData ? (
          <SectionCard
            title="Zoning"
            data={zoningData}
            sectionKey="zoning"
            copiedSection={copiedSection}
            onCopy={() =>
              onCopy(
                'zoning',
                `Zoning\n${Object.entries(zoningData)
                  .map(([k, v]) => `${formatFieldLabel(k)}: ${formatFieldValue(k, v)}`)
                  .join('\n')}`
              )
            }
          />
        ) : (
          <SectionMessageCard title="Zoning" message={z.message} />
        ))}

      {/* Overlays */}
      {isRenderable(o.status) &&
        (groupedOverlays ? (
          <GroupedOverlaysCard
            data={groupedOverlays}
            copiedSection={copiedSection}
            onCopy={() => onCopy('overlays', buildGroupedOverlaysCopyText(groupedOverlays))}
          />
        ) : (
          <SectionMessageCard title="Overlays" message={o.message} />
        ))}

      {/* Assessor */}
      {isRenderable(a.status) &&
        (assessorData ? (
          <SectionCard
            title="Assessor"
            data={assessorData}
            sectionKey="assessor"
            copiedSection={copiedSection}
            onCopy={() =>
              onCopy(
                'assessor',
                `Assessor\n${Object.entries(assessorData)
                  .map(([k, v]) => `${formatFieldLabel(k)}: ${formatFieldValue(k, v)}`)
                  .join('\n')}`
              )
            }
          />
        ) : (
          <SectionMessageCard title="Assessor" message={a.message} />
        ))}

      {/* raw text toggle (raw = the LLM narrative content) */}
      <button
        type="button"
        onClick={onToggleRaw}
        aria-expanded={showRaw}
        className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-md
                   bg-white/5 hover:bg-white/10 border border-white/10
                   text-stone-300
                   transition-colors min-h-[44px]"
        title={showRaw ? 'Hide raw response' : 'Show raw response'}
      >
        <span>{showRaw ? '▼' : '▶'}</span>
        <span>{showRaw ? 'Hide raw text' : 'Show raw text'}</span>
      </button>

      {showRaw && (
        <div className="rounded-lg border border-white/10 p-3 bg-white/5">
          <pre className="whitespace-pre-wrap text-xs">{text}</pre>
        </div>
      )}
    </div>
  );
}

export default CardsBubble;
