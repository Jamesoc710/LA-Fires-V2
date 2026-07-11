// Skeleton mirroring CardsBubble while the server resolves GIS data.
function CardsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Looking up parcel data"
      className="w-full max-w-[92%] sm:max-w-[80%] space-y-3 animate-pulse"
    >
      {/* chips row */}
      <div className="flex gap-2">
        <div className="h-5 w-32 rounded-full bg-white/10" />
        <div className="h-5 w-24 rounded-full bg-white/5" />
        <div className="h-5 w-20 rounded-full bg-white/5" />
      </div>
      {/* narrative lines */}
      <div className="space-y-2">
        <div className="h-3 w-3/4 rounded bg-white/10" />
        <div className="h-3 w-1/2 rounded bg-white/5" />
      </div>
      {/* three section-card placeholders */}
      {[0, 1, 2].map(i => (
        <div key={i} className="rounded-2xl bg-white/[0.04] border border-white/10 p-4 space-y-3">
          <div className="h-4 w-24 rounded bg-white/10" />
          <div className="h-3 w-full rounded bg-white/5" />
          <div className="h-3 w-2/3 rounded bg-white/5" />
        </div>
      ))}
    </div>
  );
}
export default CardsSkeleton;
