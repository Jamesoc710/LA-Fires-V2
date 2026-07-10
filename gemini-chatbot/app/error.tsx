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
    <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-white dark:bg-slate-900 px-6 text-center">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
        Something went wrong
      </h1>
      <p className="max-w-md text-slate-600 dark:text-slate-300">
        We hit an unexpected error. Please try again, or head back to the
        homepage if the problem persists.
      </p>
      <div className="flex gap-3">
        <button
          onClick={() => reset()}
          className="rounded-md bg-blue-600 px-4 py-2 text-white transition hover:bg-blue-700"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-md bg-slate-100 dark:bg-slate-800 px-4 py-2 text-slate-800 dark:text-slate-100 transition hover:bg-slate-200 dark:hover:bg-slate-700"
        >
          Go home
        </Link>
      </div>
    </main>
  );
}
