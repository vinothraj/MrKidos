import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Illustration, type IllustrationName } from "../src";

const css = readFileSync(path.resolve(__dirname, "../src/styles.css"), "utf8");
const NAMES: IllustrationName[] = ["family", "mumAndChild", "kids", "community", "celebrate", "explore", "stepIdea", "stepMatch", "stepBook"];

describe("illustrations", () => {
  it.each(NAMES)("%s is decorative by default: hidden from assistive technology, no text, nothing focusable", (name) => {
    const html = renderToStaticMarkup(<Illustration name={name} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
    expect(html).not.toContain("role=");
    expect(html).not.toContain("<text");
    expect(html).not.toContain("<title");
  });

  it("gets an accessible name only when a title is given", () => {
    const html = renderToStaticMarkup(<Illustration name="family" title="A family holding hands" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="A family holding hands"');
    expect(html).not.toContain("aria-hidden");
  });

  it.each(NAMES)("%s has no broken numbers", (name) => {
    expect(renderToStaticMarkup(<Illustration name={name} />)).not.toMatch(/NaN|Infinity|undefined/u);
  });

  it("every coordinate computed with trigonometry is rounded (the server and the browser disagree in the last digits, which React reports as a hydration mismatch)", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/illustrations.tsx"), "utf8");
    const trig = /Math\.(sin|cos|tan|atan2?|pow|exp|log)\(/gu;
    /** Is the call at `index` inside the parentheses of some `q(...)`? */
    const insideRounding = (index: number): boolean => {
      let depth = 0;
      for (let j = index - 1; j >= 0 && index - j < 400; j -= 1) {
        const ch = source[j];
        if (ch === ")") depth += 1;
        else if (ch === "(") {
          if (depth === 0) {
            if (source[j - 1] === "q" && !/[\w.]/u.test(source[j - 2] ?? " ")) return true;
          } else depth -= 1;
        } else if (ch === ";" && depth === 0) return false;
      }
      return false;
    };
    const lineAt = (i: number): string => source.slice(source.lastIndexOf("\n", i) + 1, source.indexOf("\n", i)).trim().slice(0, 90);
    const offenders = [...source.matchAll(trig)].filter((m) => !insideRounding(m.index ?? 0)).map((m) => lineAt(m.index ?? 0));
    expect(offenders, offenders.join(" | ")).toEqual([]);
  });

  it.each(NAMES)("%s uses no ids, so several copies on a page never collide", (name) => {
    expect(renderToStaticMarkup(<Illustration name={name} />)).not.toMatch(/\sid="/u);
  });

  it("every artwork colour it asks for exists as a design token", () => {
    const defined = new Set([...css.matchAll(/--(k-art-[a-z0-9-]+):/gu)].map((m) => m[1]));
    const used = new Set<string>();
    for (const name of NAMES) {
      for (const m of renderToStaticMarkup(<Illustration name={name} />).matchAll(/var\(--(k-art-[a-z0-9-]+)\)/gu)) used.add(m[1] as string);
    }
    expect(used.size).toBeGreaterThan(15);
    for (const token of used) expect(defined.has(token), `${token} is used but not defined`).toBe(true);
  });

  it("uses only design tokens for colour (no hard-coded hex or rgb)", () => {
    for (const name of NAMES) expect(renderToStaticMarkup(<Illustration name={name} />)).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/iu);
  });

  it("the scenery colours that change in dark mode are defined for light, the automatic dark theme and the explicit dark theme alike", () => {
    for (const token of ["k-art-sky", "k-art-ground", "k-art-hill", "k-art-cloud", "k-art-blob-a", "k-art-blob-b", "k-art-sunball"]) {
      const count = [...css.matchAll(new RegExp(`--${token}:`, "gu"))].length;
      expect(count, `${token} should be defined in light, automatic dark and explicit dark`).toBe(3);
    }
  });
});
