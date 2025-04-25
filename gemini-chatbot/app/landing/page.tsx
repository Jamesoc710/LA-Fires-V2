// app/landing/page.tsx

import { CalendarDaysIcon, ClockIcon, CreditCardIcon } from '@heroicons/react/20/solid'
import Link from 'next/link'

const features = [
  {
    name: 'Answers when you need them',
    description:
      'Instant help, any time, day or night',
    icon: CalendarDaysIcon,
  },
  {
    name: 'Build Faster',
    description:
      'Accelerate project timelines',
    icon: ClockIcon,
  },
  {
    name: 'Spend Less',
    description:
      'Reduce costly non-compliance corrections',
    icon: CreditCardIcon,
  },
]

export default function LandingPage() {
  return (
    <main className="min-h-screen overflow-x-hidden bg-white dark:bg-gray-900 text-black dark:text-white py-24 sm:py-32 flex items-center justify-center">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto grid max-w-2xl grid-cols-1 gap-x-8 gap-y-16 sm:gap-y-20 lg:mx-0 lg:max-w-none lg:grid-cols-2">
          
          {/* Text column */}
          <div className="lg:pt-4 lg:pr-8">
            <div className="lg:max-w-lg space-y-6">
              <h1 className="text-5xl font-bold text-indigo-600">LA Fires Project</h1>
              <p className="text-lg text-gray-600 dark:text-gray-300">
                Your AI-powered guide to LA building codes.
              </p>
              <Link
                href="/chat"
                className="inline-block px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition"
              >
                Chat Now
              </Link>
              <p className="mt-6 text-base text-gray-600 dark:text-gray-400">
                Features:
              </p>
              <dl className="mt-4 space-y-4 text-base text-gray-600 dark:text-gray-400">
                {features.map((feature) => (
                  <div key={feature.name} className="relative pl-9 flex flex-col">
                    <dt className="font-semibold text-gray-900 dark:text-white block">
                      <feature.icon className="absolute top-1 left-0 h-5 w-5 text-indigo-600" aria-hidden="true" />
                      {feature.name}
                    </dt>
                    <dd className="mt-1 text-base text-gray-600 dark:text-gray-400">{feature.description}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>

          {/* Image column */}
          <div className="flex items-center justify-center">
            <video
              src="BuildingCodeAssistantDemo.mp4"
              autoPlay
              loop
              muted
              playsInline
              width={2432}
              height={1442}
              className="w-[48rem] max-w-none rounded-xl shadow-xl ring-1 ring-gray-400/10 sm:w-[57rem] md:-ml-4 lg:-ml-0"
            />
          </div>

        </div>
      </div>
    </main>
  )
}