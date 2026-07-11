// app/landing/page.tsx
// Light-mode, story-driven landing page. Forced light (no dark: variants) by design.

import Link from "next/link";
import { HeroChatDemo } from "./HeroChatDemo";
import { Reveal, StatCounter } from "./Reveal";

const STEPS = [
  {
    n: "01",
    title: "Ask in plain English",
    body: "Type an address or APN the way you'd say it out loud. No parcel viewers, no layer toggles, no GIS training required.",
  },
  {
    n: "02",
    title: "We query the county live",
    body: "The assistant finds your parcel, works out which jurisdiction it falls under, and pulls zoning, hazard overlays, and assessor records straight from official LA County and city GIS services.",
  },
  {
    n: "03",
    title: "Decide with confidence",
    body: "You get the zone, every overlay that applies (fire severity, fault, flood, historic), assessor details, and links to the official viewers so you can verify everything.",
  },
];

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-white text-stone-900 antialiased">
      {/* nav */}
      <header className="sticky top-0 z-20 border-b border-stone-100 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <span className="text-sm font-semibold tracking-tight">
            LA Building Codes Assistant
          </span>
          <Link
            href="/chat"
            className="whitespace-nowrap rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-700"
          >
            <span className="sm:hidden">Open chat</span>
            <span className="hidden sm:inline">Open the assistant</span>
          </Link>
        </div>
      </header>

      {/* hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-gradient-to-b from-amber-50/70 via-white to-white"
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-16 sm:pt-24 lg:grid-cols-2 lg:gap-8">
          <div>
            <Reveal>
              <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">
                Built after the January 2025 fires
              </p>
            </Reveal>
            <Reveal delay={100}>
              <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
                Rebuilding starts with knowing your parcel.
              </h1>
            </Reveal>
            <Reveal delay={200}>
              <p className="mt-5 max-w-xl text-lg leading-relaxed text-stone-600">
                Ask about any address or APN in LA County and get zoning, fire
                and hazard overlays, and assessor records in seconds, with
                building-code answers grounded in Title 26.
              </p>
            </Reveal>
            <Reveal delay={300}>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  href="/chat"
                  className="rounded-lg bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700"
                >
                  Look up your parcel
                </Link>
                <a
                  href="#why"
                  className="rounded-lg px-5 py-3 text-sm font-semibold text-stone-700 transition hover:bg-stone-100"
                >
                  Why we built this ↓
                </a>
              </div>
            </Reveal>
            <Reveal delay={400}>
              <p className="mt-6 text-xs text-stone-400">
                Free to use · Live county data · Not an official determination
              </p>
            </Reveal>
          </div>
          <Reveal delay={250} className="flex justify-center lg:justify-end">
            <HeroChatDemo />
          </Reveal>
        </div>
      </section>

      {/* why / story */}
      <section id="why" className="border-t border-stone-100 bg-stone-50">
        <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
          <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
            <Reveal>
              <h2 className="text-3xl font-semibold tracking-tight">
                The information exists.
                <br />
                <span className="text-stone-400">Finding it is the problem.</span>
              </h2>
            </Reveal>
            <Reveal delay={150}>
              <div className="space-y-4 text-base leading-relaxed text-stone-600">
                <p>
                  The Eaton and Palisades fires destroyed more than 16,000
                  structures. Every one of those rebuilds starts with the same
                  questions: what zone is my lot in, which hazard overlays
                  apply, and what does the code actually allow me to build?
                </p>
                <p>
                  The answers are public, but they&apos;re scattered across separate
                  county and city GIS portals, a 500-plus page zoning code, and
                  planning-counter phone queues. Depending on which side of a
                  street you live on, a different government answers the phone.
                </p>
                <p className="font-medium text-stone-900">
                  We put all of it in one conversation.
                </p>
              </div>
            </Reveal>
          </div>

          {/* stats */}
          <div className="mt-16 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-stone-200 bg-stone-200 sm:grid-cols-4">
            {[
              { target: 16000, suffix: "+", label: "structures lost in the January 2025 fires" },
              { target: 3, suffix: "+", label: "separate GIS portals per parcel lookup" },
              { target: 500, suffix: "+", label: "pages in LA County's Title 26 building code" },
              { target: 1, suffix: "", label: "conversation to get your answers" },
            ].map((s, i) => (
              <div key={s.label} className="bg-white p-6 sm:p-8">
                <Reveal delay={i * 100}>
                  <div className="text-3xl font-semibold tabular-nums tracking-tight text-blue-600 sm:text-4xl">
                    <StatCounter target={s.target} suffix={s.suffix} />
                  </div>
                  <p className="mt-2 text-sm leading-snug text-stone-500">{s.label}</p>
                </Reveal>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* how it works */}
      <section className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <Reveal>
          <h2 className="text-3xl font-semibold tracking-tight">How it works</h2>
        </Reveal>
        <div className="mt-12 grid gap-10 lg:grid-cols-3">
          {STEPS.map((step, i) => (
            <Reveal key={step.n} delay={i * 150}>
              <div className="relative border-t-2 border-stone-900 pt-6">
                <span className="text-sm font-semibold tabular-nums text-stone-400">
                  {step.n}
                </span>
                <h3 className="mt-2 text-lg font-semibold">{step.title}</h3>
                <p className="mt-3 text-[15px] leading-relaxed text-stone-600">
                  {step.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* demo video */}
      <section className="border-t border-stone-100 bg-stone-50">
        <div className="mx-auto max-w-4xl px-6 py-20 sm:py-24 text-center">
          <Reveal>
            <h2 className="text-3xl font-semibold tracking-tight">
              See it in action
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-stone-600">
              A real lookup, from question to grouped hazard cards, in under a
              minute.
            </p>
          </Reveal>
          <Reveal delay={150}>
            <div className="mt-10 overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-lg shadow-stone-900/5">
              <div className="flex items-center gap-1.5 border-b border-stone-100 px-4 py-3">
                <span className="h-2.5 w-2.5 rounded-full bg-stone-200" />
                <span className="h-2.5 w-2.5 rounded-full bg-stone-200" />
                <span className="h-2.5 w-2.5 rounded-full bg-stone-200" />
              </div>
              <video
                src="/BuildingCodeAssistantDemo.mp4"
                poster="/demo-poster.png"
                preload="none"
                controls
                muted
                loop
                playsInline
                width={960}
                height={616}
                className="w-full"
              />
            </div>
          </Reveal>
        </div>
      </section>

      {/* closing CTA */}
      <section className="mx-auto max-w-6xl px-6 py-20 sm:py-24 text-center">
        <Reveal>
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Your parcel has answers.
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-stone-600">
            Zoning, overlays, hazards, and assessor records for any LA County
            address. Ask like you&apos;d ask a person.
          </p>
          <Link
            href="/chat"
            className="mt-8 inline-block rounded-lg bg-blue-600 px-6 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700"
          >
            Look up your parcel
          </Link>
        </Reveal>
      </section>

      {/* footer */}
      <footer className="border-t border-stone-100">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-8 text-xs text-stone-400 sm:flex-row">
          <span>A project from IF Lab</span>
          <span>
            Informational only. Always confirm with your planning department
            before making decisions.
          </span>
        </div>
      </footer>
    </main>
  );
}
