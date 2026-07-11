"use client";

import { useEffect, useRef, useState } from "react";

const QUESTION = "What's the zoning for 3652 Monterosa Dr, Altadena?";

const ZONING_ROWS: [string, string][] = [
  ["JURISDICTION", "Unincorporated LA County"],
  ["ZONE", "R-1-10000"],
  ["ZONE DESCRIPTION", "Single-Family Residence"],
  ["PLANNING AREA", "West San Gabriel Valley"],
];

const HAZARD_CHIPS = ["Very High Fire Hazard Severity", "Hillside Management Area"];

// Animation phases: 0 idle, 1 typing, 2 thinking, 3 cards, 4 hold
export function HeroChatDemo() {
  const [typed, setTyped] = useState(0);
  const [phase, setPhase] = useState(0);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced.current) {
      setTyped(QUESTION.length);
      setPhase(3);
      return;
    }

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const wait = (ms: number) =>
      new Promise<void>((res) => timers.push(setTimeout(res, ms)));

    async function run() {
      while (!cancelled) {
        setPhase(1);
        setTyped(0);
        for (let i = 1; i <= QUESTION.length; i++) {
          if (cancelled) return;
          setTyped(i);
          await wait(28);
        }
        setPhase(2);
        await wait(900);
        setPhase(3);
        await wait(5200);
        setPhase(0);
        await wait(600);
      }
    }
    run();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, []);

  const showCards = phase >= 3;

  return (
    <div
      className="w-full max-w-lg rounded-2xl border border-stone-800 bg-stone-950 shadow-2xl shadow-stone-900/25 overflow-hidden text-left"
      aria-hidden="true"
    >
      {/* window chrome */}
      <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="ml-3 text-xs font-medium text-stone-500">
          LA Fires Assistant
        </span>
      </div>

      <div className="p-4 sm:p-5 space-y-3 min-h-[300px]">
        {/* user bubble */}
        <div className="flex justify-end">
          <div className="rounded-2xl rounded-br-sm bg-stone-100 px-4 py-2.5 text-sm text-stone-950 max-w-[85%]">
            {QUESTION.slice(0, typed)}
            {phase === 1 && (
              <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-stone-950/70 align-middle" />
            )}
          </div>
        </div>

        {/* thinking dots */}
        {phase === 2 && (
          <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm bg-stone-900 border border-white/10 px-4 py-3 w-fit">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-500 [animation-delay:0ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-500 [animation-delay:120ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-500 [animation-delay:240ms]" />
          </div>
        )}

        {/* zoning card */}
        <div
          className={`transition-all duration-500 ease-out ${
            showCards ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3 pointer-events-none"
          }`}
        >
          <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="font-serif text-sm font-semibold text-stone-100">Zoning</h4>
              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[11px] text-stone-300">
                APN 5843-018-021
              </span>
            </div>
            <dl className="space-y-1.5">
              {ZONING_ROWS.map(([k, v], i) => (
                <div
                  key={k}
                  className={`flex justify-between gap-3 text-[13px] transition-opacity duration-300 ${
                    showCards ? "opacity-100" : "opacity-0"
                  }`}
                  style={{ transitionDelay: `${200 + i * 120}ms` }}
                >
                  <dt className="text-[10px] uppercase tracking-wider font-medium text-stone-500">{k}</dt>
                  <dd className="text-right font-mono text-stone-200">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        {/* hazard chips */}
        <div
          className={`flex flex-wrap gap-2 transition-all duration-500 ease-out ${
            showCards ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
          }`}
          style={{ transitionDelay: "700ms" }}
        >
          {HAZARD_CHIPS.map((c) => (
            <span
              key={c}
              className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-1 text-[11px] font-medium text-amber-300"
            >
              ⚠ {c}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
