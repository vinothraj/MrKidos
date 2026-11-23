import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JOURNEY } from "../src/components/flow-steps";
import { JourneyPlayer } from "../src/components/journey-player";

const stops = JOURNEY.map((s, i) => ({ short: s.short ?? `Step ${i + 1}`, title: s.title, lines: s.lines }));

describe("the animated journey overview", () => {
  it("gives every step of the journey a short, distinct label", () => {
    const shorts = JOURNEY.map((s) => s.short);
    expect(shorts.every((s) => typeof s === "string" && s.length > 0 && s.length <= 10)).toBe(true);
    expect(new Set(shorts).size).toBe(JOURNEY.length);
  });

  it("starts at step 1 with one real button per step, each named in full for a screen reader", () => {
    const html = renderToStaticMarkup(<JourneyPlayer stops={stops} />);
    expect((html.match(/<button[^>]*class="k-journey-stop"/gu) ?? []).length).toBe(JOURNEY.length);
    expect((html.match(/aria-current="step"/gu) ?? []).length).toBe(1);
    expect(html).toContain(`step 1 of ${JOURNEY.length}: ${JOURNEY[0]?.title}`);
    expect(html).toContain(`step ${JOURNEY.length} of ${JOURNEY.length}: ${JOURNEY[JOURNEY.length - 1]?.title}`);
    expect(html).toContain("Pause the tour");
  });

  it("says who is involved in words as well as by style, and shows what each one does", () => {
    const html = renderToStaticMarkup(<JourneyPlayer stops={stops} />);
    // step 1: you and our team act; providers are not involved yet
    expect(html).toMatch(/data-on="true">You</u);
    expect(html).toMatch(/data-on="true">Our team</u);
    expect(html).toMatch(/data-on="false">Providers<span class="k-sr-only"> \(not involved\)/u);
    for (const l of JOURNEY[0]?.lines ?? []) expect(html).toContain(l.text);
  });

  it("does not move until it is on screen, and is hidden from nothing a screen reader needs", () => {
    const html = renderToStaticMarkup(<JourneyPlayer stops={stops} />);
    expect(html).toContain('data-playing="false"');
    // the animated track is decoration; the buttons and the card are not hidden
    expect(html).toContain('class="k-journey-rail" aria-hidden="true"');
    expect(html).not.toMatch(/<(button|ol)[^>]*aria-hidden/u);
  });
});
