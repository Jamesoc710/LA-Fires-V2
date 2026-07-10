// app/landing/page.tsx

import {
  MapPinIcon,
  ShieldExclamationIcon,
  BookOpenIcon,
} from '@heroicons/react/24/outline'
import Link from 'next/link'

const features = [
  {
    name: 'Parcel lookup',
    description:
      'Look up any LA County parcel by street address or APN and get zoning, general plan, and planning-area details instantly.',
    icon: MapPinIcon,
  },
  {
    name: 'Hazard & overlay awareness',
    description:
      'See fire severity zones, fault and liquefaction hazards, and historic districts that apply to a property.',
    icon: ShieldExclamationIcon,
  },
  {
    name: 'Building-code guidance',
    description:
      'Get answers grounded in LA County Title 26 to help you navigate the rules for your rebuild.',
    icon: BookOpenIcon,
  },
]

export default function LandingPage() {
  return (
    <main className="min-h-screen overflow-x-hidden bg-white dark:bg-slate-900 text-slate-900 dark:text-white flex flex-col">
      <div className="flex-1 flex items-center justify-center py-24 sm:py-32">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="mx-auto max-w-3xl text-center">
            <h1 className="text-4xl sm:text-5xl font-bold text-blue-600">
              Rebuild with confidence
            </h1>
            <p className="mt-6 text-lg text-slate-600 dark:text-slate-300">
              Instant zoning, overlay, and assessor lookups for any LA County
              parcel — plus building-code answers for your rebuild.
            </p>
            <Link
              href="/chat"
              className="mt-8 inline-block px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition"
            >
              Chat Now
            </Link>
          </div>

          {/* Feature cards */}
          <div className="mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-6 sm:grid-cols-3">
            {features.map((feature) => (
              <div
                key={feature.name}
                className="rounded-2xl bg-slate-50 dark:bg-slate-800 ring-1 ring-slate-200 dark:ring-slate-700 p-6"
              >
                <feature.icon
                  className="h-8 w-8 text-blue-600"
                  aria-hidden="true"
                />
                <h2 className="mt-4 font-semibold text-slate-900 dark:text-white">
                  {feature.name}
                </h2>
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>

          {/* Demo video */}
          <div className="mx-auto mt-16 max-w-4xl">
            <video
              src="/BuildingCodeAssistantDemo.mp4"
              poster="/demo-poster.png"
              width={480}
              height={308}
              controls
              loop
              muted
              playsInline
              preload="none"
              className="w-full rounded-xl shadow-xl ring-1 ring-slate-900/10 dark:ring-slate-100/10"
            />
          </div>
        </div>
      </div>

      <footer className="py-6 text-center text-xs text-slate-400 dark:text-slate-500">
        A project from IF Lab
      </footer>
    </main>
  )
}
