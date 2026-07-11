import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-stone-950 px-6 text-center text-stone-100">
      <h1 className="font-serif text-2xl font-semibold">Page not found</h1>
      <p className="max-w-md text-stone-400">
        The page you&apos;re looking for doesn&apos;t exist or may have moved.
      </p>
      <Link
        href="/"
        className="rounded-lg bg-stone-100 px-4 py-2 text-sm font-medium text-stone-950 transition hover:bg-white"
      >
        Back to home
      </Link>
    </main>
  );
}
