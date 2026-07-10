import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-white dark:bg-slate-900 px-6 text-center">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
        Page not found
      </h1>
      <p className="max-w-md text-slate-600 dark:text-slate-300">
        The page you&apos;re looking for doesn&apos;t exist or may have moved.
      </p>
      <Link
        href="/"
        className="rounded-md bg-blue-600 px-4 py-2 text-white transition hover:bg-blue-700"
      >
        Back to home
      </Link>
    </main>
  );
}
