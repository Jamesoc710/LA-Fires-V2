'use client';

import Link from 'next/link';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-stone-950 px-6 text-center text-stone-100">
      <h1 className="font-serif text-2xl font-semibold">Something went wrong</h1>
      <p className="max-w-md text-stone-400">
        We hit an unexpected error. Please try again, or head back to the
        homepage if the problem persists.
      </p>
      <div className="flex gap-3">
        <button
          onClick={() => reset()}
          className="rounded-lg bg-stone-100 px-4 py-2 text-sm font-medium text-stone-950 transition hover:bg-white"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-stone-300 transition hover:bg-white/10"
        >
          Go home
        </Link>
      </div>
    </main>
  );
}
