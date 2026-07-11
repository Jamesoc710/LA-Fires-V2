import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Citation } from '../../types/chat';
import CitationChips from './CitationChips';

// Plain markdown chat bubble for general Q&A replies (no parcel cards).
function MarkdownBubble({ text, citations }: { text: string; citations?: Citation[] }) {
  return (
    <div className="max-w-[92%] sm:max-w-[80%] rounded-xl p-4 shadow-md bg-stone-900 border border-white/10 text-stone-200 space-y-3">
      <div className="prose prose-invert prose-sm max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
      <CitationChips citations={citations} />
    </div>
  );
}

export default MarkdownBubble;
