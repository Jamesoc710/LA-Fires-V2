function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-white/5 border border-white/10 text-stone-300 px-2 py-0.5 text-xs font-mono font-medium">
      {children}
    </span>
  );
}

export default Chip;
