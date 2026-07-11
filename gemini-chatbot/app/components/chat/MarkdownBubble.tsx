import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Plain markdown chat bubble for general Q&A replies (no parcel cards).
function MarkdownBubble({ text }: { text: string }) {
  return (
    <div className="max-w-[92%] sm:max-w-[80%] rounded-xl p-4 shadow-md bg-stone-900 border border-white/10 text-stone-200">
      <div className="prose prose-invert prose-sm max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </div>
  );
}

export default MarkdownBubble;
