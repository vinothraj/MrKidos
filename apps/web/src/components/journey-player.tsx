"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
function subscribeToReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
function readReducedMotion() {
  return window.matchMedia(REDUCED_MOTION).matches;
}

export interface JourneyStop {
  /** One or two words for the stop on the track. */
  short: string;
  title: string;
  lines: { who: string; text: string }[];
}

/** Who can be involved at a step, in the order they are shown. `key` is the `who` used in the step's lines. */
const ACTORS = [
  { key: "You", label: "You" },
  { key: "Us", label: "Our team" },
  { key: "Providers", label: "Providers" },
];

const STEP_MS = 4500;

/**
 * The journey at a glance: five stops on a track, a marker that travels from one to the next, and a short card for the
 * step it is on that says who does what. It plays by itself while it is on screen, stops when the visitor presses a stop
 * or "Pause", and does not play at all for people who ask their device for less motion. Everything it says is also in the
 * numbered list below it, so it adds clarity without being the only place the information lives.
 */
export function JourneyPlayer({ stops }: { stops: JourneyStop[] }) {
  const [active, setActive] = useState(0);
  const [wantsPlay, setWantsPlay] = useState(true);
  const [visible, setVisible] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const last = stops.length - 1;

  // people who ask for less motion get a still picture that they step through themselves
  const reduceMotion = useSyncExternalStore(subscribeToReducedMotion, readReducedMotion, () => false);
  const playing = wantsPlay && !reduceMotion;

  // only move while it can be seen
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false), { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || !visible) return;
    const t = setTimeout(() => setActive((a) => (a >= last ? 0 : a + 1)), STEP_MS);
    return () => clearTimeout(t);
  }, [playing, visible, active, last]);

  const stop = stops[active];
  if (!stop) return null;
  const progress = last > 0 ? (active / last) * 100 : 0;

  return (
    <div ref={root} className="k-journey" role="group" aria-label="The journey at a glance" data-playing={playing && visible}>
      <div className="k-journey-track">
        <div className="k-journey-rail" aria-hidden="true">
          <div className="k-journey-fill" style={{ width: `${progress}%` }} />
          <span className="k-journey-marker" style={{ left: `${progress}%` }} />
        </div>
        <ol className="k-journey-stops">
          {stops.map((s, i) => (
            <li key={s.short}>
              <button
                type="button"
                className="k-journey-stop"
                data-state={i < active ? "done" : i === active ? "active" : "next"}
                aria-current={i === active ? "step" : undefined}
                onClick={() => {
                  setActive(i);
                  setWantsPlay(false);
                }}
              >
                <span className="k-journey-dot">{i + 1}</span>
                <span className="k-journey-label">{s.short}</span>
                <span className="k-sr-only">{`, step ${i + 1} of ${stops.length}: ${s.title}`}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>

      {/* the live region stays put; only the card inside it is replaced, so a change is announced when the visitor is stepping through */}
      <div aria-live={playing ? "off" : "polite"}>
        <div className="k-journey-card" key={active}>
          <p className="k-journey-title">
            <span className="k-eyebrow">
              Step {active + 1} of {stops.length}
            </span>
            <strong>{stop.title}</strong>
          </p>
          <ul className="k-journey-actors" aria-label="Who is involved in this step">
            {ACTORS.map((a) => {
              const involved = stop.lines.some((l) => l.who === a.key);
              return (
                <li key={a.key} className="k-journey-actor" data-on={involved}>
                  {a.label}
                  {involved ? null : <span className="k-sr-only"> (not involved)</span>}
                </li>
              );
            })}
          </ul>
          <ul className="k-step-lines">
            {stop.lines.map((l) => (
              <li key={l.who + l.text}>
                <span className="k-step-who">{l.who}</span>
                <span>{l.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="k-journey-controls">
        {reduceMotion ? null : (
          <button type="button" className="k-journey-toggle" onClick={() => setWantsPlay((p) => !p)}>
            {playing ? "Pause the tour" : "Play the tour"}
          </button>
        )}
        <span className="k-muted" style={{ fontSize: "var(--k-text-sm)" }}>
          Press a step to look closer. The full story is just below.
        </span>
      </div>
    </div>
  );
}
