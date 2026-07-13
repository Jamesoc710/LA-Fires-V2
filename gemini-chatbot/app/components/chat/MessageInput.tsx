function MessageInput({
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        onSubmit();
      }}
      className="border-t border-white/10 p-4 sticky bg-stone-950/90 backdrop-blur z-10"
      style={{ bottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex space-x-2">
        <input
          type="text"
          value={value}
          onKeyDown={handleKeyDown}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          placeholder="Enter APN (5843-004-015) or address (3652 Monterosa Dr)…"
          aria-label="Message input"
          className="flex-1 p-2 rounded-md bg-white/5 border border-white/10 text-stone-100 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-amber-400/40 focus:border-amber-400/40 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          className="bg-stone-100 text-stone-950 px-4 py-2 rounded-md hover:bg-white focus:outline-none focus:ring-2 focus:ring-amber-400/40 disabled:bg-white/10 disabled:text-stone-600"
        >
          Send
        </button>
      </div>
      <p className="mt-1 text-[11px] text-stone-400">
        Press Enter to send • Supports APN or street address
      </p>
    </form>
  );
}

export default MessageInput;
