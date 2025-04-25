

// app/landing/page.tsx
import Link from 'next/link';

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-white dark:bg-gray-900 text-black dark:text-white flex items-center justify-center p-8">
      <div className="max-w-3xl text-center space-y-6">
        <h1 className="text-5xl font-bold">🔥 BuildAssist</h1>
        <p className="text-lg">
          Your AI-powered guide to LA building codes. Get clear, accurate answers fast.
        </p>
        <Link
          href="/chat"
          className="inline-block px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition"
        >
          Chat Now
        </Link>
      </div>
    </main>
  );
}