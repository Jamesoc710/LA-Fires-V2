// app/landing/page.tsx
// Light, story-driven landing page. Forced light (no dark: variants) by design;
// the chat product itself is dark, and the hero mock previews it.
// Content follows .claude/plans/LANDING_PAGE_CONTEXT.md: metrics first, then
// mission/trust, then technical capability, then how-to. One page serves both
// homeowners and technical readers. Do not add claims beyond that doc.

import type { Metadata } from "next";
import { Fragment } from "react";
import Link from "next/link";
import { HeroChatDemo } from "./HeroChatDemo";
import { Reveal, StatCounter } from "./Reveal";

export const metadata: Metadata = {
  title: "Zoning, Hazards & Rebuild Guidance for LA County",
  description:
    "Free AI assistant for LA County fire rebuilds: instant parcel zoning, hazard overlays, assessor data, and Title 26 building-code answers with citations.",
  alternates: {
    canonical: "/landing",
  },
};

const STEPS = [
  {
    n: "01",
    title: "Ask in plain English",
    body: "Type an address or parcel number the way you'd say it out loud. Single matches resolve automatically; ambiguous addresses get a picker.",
  },
  {
    n: "02",
    title: "The right government is found",
    body: "Your parcel is checked against the county jurisdiction locator, because a Pasadena lot follows Pasadena's code, and an Altadena lot follows the county's, not a city's.",
  },
  {
    n: "03",
    title: "Official sources are queried live",
    body: "Base zoning, overlay zones, hazard layers, and assessor records are pulled in parallel from the correct jurisdiction's GIS services, never from a stale copy.",
  },
  {
    n: "04",
    title: "You get one clear answer",
    body: "Grouped cards with source attribution and timestamps, an AI summary constrained to the retrieved data, and links to the official viewers so you can verify everything.",
  },
];

const COVERAGE = [
  { title: "Base zoning", body: "Your zone designation and category, standardized so a Pasadena result reads like an LA City result." },
  { title: "Fire hazard severity", body: "Whether your parcel sits in a Very High Fire Hazard Severity Zone and what other hazard layers apply." },
  { title: "Seismic & geologic hazards", body: "Alquist-Priolo fault zones, liquefaction, landslide, tsunami, and coastal zones, checked for every jurisdiction." },
  { title: "Historic districts", body: "HPOZs, landmarks, and historic districts that can change what and how you rebuild." },
  { title: "Land use & development rules", body: "General Plan designations, Specific Plans, Community Standards Districts, hillside and environmental overlays." },
  { title: "Assessor records", body: "Living area, year built, lot details, and use type, useful for insurance documentation and like-for-like rebuilds." },
];

const UNDER_THE_HOOD = [
  { k: "Stack", v: "Next.js + TypeScript on Vercel" },
  { k: "Data layer", v: "25+ ArcGIS REST integrations across LA County, LA City, Pasadena, Malibu, Santa Monica, and Arcadia services" },
  { k: "LLM orchestration", v: "OpenRouter with deliberate cross-provider redundancy: Google primary, Anthropic fallback" },
  { k: "Performance", v: "Parallel GIS queries, in-memory caching, rate limiting; conditional context loading cut a standard query from ~175K to ~1.3K tokens" },
  { k: "Normalization", v: "One field-normalization layer reconciles six jurisdictions' incompatible schemas into a single consistent output" },
  { k: "Reliability", v: "Audit logging distinguishes “no data exists” from “query failed”, so every section shows an honest status instead of a silent gap" },
];

const OFFICIAL_VIEWERS = [
  { name: "ZIMAS (LA City)", href: "https://zimas.lacity.org/" },
  { name: "Z-NET (LA County)", href: "https://experience.arcgis.com/experience/0eecc2d2d0b944a787f282420c8b290c" },
  { name: "GIS-NET (LA County)", href: "https://egis-lacounty.hub.arcgis.com/" },
  { name: "County Assessor", href: "https://portal.assessor.lacounty.gov/" },
];

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-white text-stone-900 antialiased">
      {/* nav */}
      <header className="sticky top-0 z-20 border-b border-stone-100 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <span className="font-serif text-sm font-medium tracking-tight">
            LA Fires Assistant
          </span>
          <Link
            href="/chat"
            className="whitespace-nowrap rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-700"
          >
            <span className="sm:hidden">Look up your property</span>
            <span className="hidden sm:inline">Look up your property</span>
          </Link>
        </div>
      </header>

      {/* hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-gradient-to-b from-amber-50/70 via-white to-white"
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 pb-16 pt-16 sm:pt-24 lg:grid-cols-2 lg:gap-8">
          <div>
            <Reveal delay={100}>
              <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
                Find out what you can rebuild on your property.
              </h1>
            </Reveal>
            <Reveal delay={200}>
              <p className="mt-5 max-w-xl text-lg leading-relaxed text-stone-600">
                Rebuilding after the fires is overwhelming. Ask one question
                about any LA County address and get your zoning, hazard
                overlays, and assessor records in seconds, pulled live from
                official county and city data sources.
              </p>
            </Reveal>
            <Reveal delay={300}>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  href="/chat"
                  className="rounded-lg bg-stone-900 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-stone-700"
                >
                  Look up your property
                </Link>
                <a
                  href="#how"
                  className="rounded-lg px-5 py-3 text-sm font-semibold text-stone-700 transition hover:bg-stone-100"
                >
                  How it works ↓
                </a>
              </div>
            </Reveal>
            <Reveal delay={400}>
              <p className="mt-6 text-xs text-stone-400">
                Free to use · Informational only, not an official determination ·
                Every answer links to the official source
              </p>
            </Reveal>
          </div>
          <Reveal delay={250} className="flex justify-center lg:justify-end">
            <HeroChatDemo />
          </Reveal>
        </div>

        {/* stat band: priority #1, directly under the hero — ruled row, not boxes */}
        <div className="relative mx-auto max-w-6xl px-6 pb-20">
          <div className="grid grid-cols-2 gap-y-10 border-t border-stone-200 pt-10 sm:grid-cols-4">
            {[
              { target: 1000000, suffix: "+", label: "parcels covered across LA County" },
              { target: 25, suffix: "+", label: "live government data integrations" },
              { target: 6, suffix: "", label: "jurisdictions across LA County" },
              { target: 7, suffix: "s", prefix: "<", label: "to a sourced answer (about 1.5s cached)" },
            ].map((s, i) => (
              <div
                key={s.label}
                className={`px-0 sm:px-8 ${i > 0 ? "sm:border-l sm:border-stone-200" : "sm:pl-0"} ${i % 2 === 1 ? "border-l border-stone-200 pl-6 sm:pl-8" : ""}`}
              >
                <Reveal delay={i * 100}>
                  <div className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-amber-600 sm:text-3xl">
                    <StatCounter target={s.target} suffix={s.suffix} prefix={s.prefix ?? ""} />
                  </div>
                  <p className="mt-2 text-sm leading-snug text-stone-500">{s.label}</p>
                </Reveal>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* the problem */}
      <section id="why" className="border-t border-stone-100 bg-stone-50">
        <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
          <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
            <Reveal>
              <h2 className="text-3xl font-semibold tracking-tight">
                One question.
                <br />
                <span className="text-stone-400">Five government portals.</span>
              </h2>
            </Reveal>
            <Reveal delay={150}>
              <div className="space-y-4 text-base leading-relaxed text-stone-600">
                <p>
                  &ldquo;What am I allowed to build here?&rdquo; sounds simple.
                  Answering it means working out which government&apos;s rules
                  apply, then searching portals like Z-NET, GIS-NET, ZIMAS, and
                  the Assessor, each with its own interface and vocabulary, then
                  cross-referencing the zoning code and every overlay that
                  modifies it.
                </p>
                <p>
                  The jurisdiction alone trips people up: an Altadena address
                  says &ldquo;Altadena, CA&rdquo;, but it&apos;s governed by
                  unincorporated LA County, not a city. Days of confusing
                  research, across sites that were never designed to talk to
                  each other.
                </p>
                <p className="font-medium text-stone-900">
                  This tool collapses it into one conversation: enter an address
                  or parcel number, get a structured, jurisdiction-aware answer.
                </p>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* how it works */}
      <section id="how" className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <Reveal>
          <h2 className="text-3xl font-semibold tracking-tight">How it works</h2>
        </Reveal>
        <div className="mt-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <Reveal key={step.n} delay={i * 120}>
              <div className="relative border-t-2 border-stone-900 pt-6">
                <span className="font-mono text-sm font-semibold tabular-nums text-stone-400">
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

      {/* what you'll learn — ruled list, not cards */}
      <section className="border-t border-stone-100 bg-stone-50">
        <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
          <Reveal>
            <h2 className="text-3xl font-semibold tracking-tight">
              What you&apos;ll learn about your property
            </h2>
            <p className="mt-3 max-w-2xl text-stone-600">
              Every lookup surfaces the designations that shape a rebuild,
              grouped and explained, with a link to the official record.
            </p>
          </Reveal>
          <div className="mt-12 grid gap-x-16 sm:grid-cols-2">
            {COVERAGE.map((c, i) => (
              <Reveal key={c.title} delay={i * 60}>
                <div className="border-t border-stone-200 py-6">
                  <h3 className="font-serif text-lg font-semibold text-stone-900">
                    {c.title}
                  </h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-stone-600">
                    {c.body}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* demo video */}
      <section className="mx-auto max-w-4xl px-6 py-20 sm:py-24 text-center">
        <Reveal>
          <h2 className="text-3xl font-semibold tracking-tight">See it in action</h2>
          <p className="mx-auto mt-3 max-w-xl text-stone-600">
            A real session in 40 seconds: parcel lookup, hazard cards, a
            follow-up from memory, and a building-code answer with citations.
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
              poster="/demo-poster.webp"
              preload="none"
              controls
              muted
              loop
              playsInline
              width={1280}
              height={800}
              className="w-full"
            />
          </div>
        </Reveal>
      </section>

      {/* under the hood — spec-sheet rows, not cards */}
      <section className="border-t border-stone-100 bg-stone-50">
        <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <Reveal>
              <h2 className="text-3xl font-semibold tracking-tight">Under the hood</h2>
              <p className="mt-3 max-w-2xl text-stone-600">
                Truth over fluency: the AI is constrained to answer only from
                the live per-parcel data it just retrieved. When data
                isn&apos;t available, it says so and points to the official
                source.
              </p>
            </Reveal>
            <Reveal delay={100}>
              <a
                href="https://github.com/Jamesoc710/LA-Fires-V2"
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 transition hover:bg-stone-100"
              >
                View on GitHub ↗
              </a>
            </Reveal>
          </div>
          {/* dt/dd are direct children of dl (a11y: no intermediate wrapping
              div per row) — the ruled-row look comes from a grid on the dl
              itself, with the row border/rhythm applied to dt+dd directly so
              each pair still reads as one bordered row. */}
          <Reveal>
            <dl className="mt-12 grid grid-cols-1 sm:grid-cols-[200px_1fr]">
              {UNDER_THE_HOOD.map((item) => (
                <Fragment key={item.k}>
                  <dt className="mb-1 border-t border-stone-200 pt-5 font-mono text-[11px] font-medium uppercase tracking-wider text-stone-500 sm:mb-0 sm:pt-6">
                    {item.k}
                  </dt>
                  <dd className="pb-5 text-[15px] leading-relaxed text-stone-700 sm:border-t sm:border-stone-200 sm:pl-8 sm:pt-5">
                    {item.v}
                  </dd>
                </Fragment>
              ))}
            </dl>
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
            className="mt-8 inline-block rounded-lg bg-stone-900 px-6 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-stone-700"
          >
            Look up your property
          </Link>
        </Reveal>
      </section>

      {/* trust footer */}
      <footer className="border-t border-stone-100">
        <div className="mx-auto max-w-6xl px-6 py-10">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-md space-y-2 text-xs leading-relaxed text-stone-500">
              <p>
                A free community tool, built independently by a solo developer
                through the Artificial Intelligence Student Association (AISA).
              </p>
              <p>
                Informational only, not an official zoning determination, permit,
                or legal advice. Always verify with your planning department
                before making decisions.
              </p>
            </div>
            <div className="text-xs text-stone-500">
              <p className="mb-2 font-medium uppercase tracking-wider text-stone-600">
                Verify at the source
              </p>
              <ul className="space-y-1.5">
                {OFFICIAL_VIEWERS.map((v) => (
                  <li key={v.name}>
                    <a
                      href={v.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block py-1.5 text-amber-700 transition hover:text-amber-600"
                    >
                      {v.name} ↗
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
