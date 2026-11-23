import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * jsdom cannot compute colors, so contrast is verified here directly from the design tokens.
 * WCAG 2.2 AA: 4.5:1 for normal text, 3:1 for large text, UI component boundaries and focus indicators.
 */
const css = readFileSync(path.resolve(__dirname, "../src/styles.css"), "utf8");

function block(selectorStart: string): string {
  const start = css.indexOf(selectorStart);
  if (start === -1) throw new Error(`Block not found: ${selectorStart}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error("Unbalanced CSS");
}

function tokens(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/--(k-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/gu)) {
    if (m[1] && m[2]) out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const light = tokens(block(":root {"));
const darkExplicit = tokens(block(':root[data-theme="dark"]'));
const darkMedia = { ...light, ...tokens(block(":root:not([data-theme=\"light\"])")) };
const dark = { ...light, ...darkExplicit };

const TEXT_PAIRS: [string, string][] = [
  ["k-ink", "k-bg"],
  ["k-ink", "k-surface"],
  ["k-ink", "k-surface-2"],
  ["k-ink-muted", "k-bg"],
  ["k-ink-muted", "k-surface"],
  ["k-ink-muted", "k-surface-2"],
  ["k-primary-ink", "k-primary"],
  ["k-primary-ink", "k-primary-hover"],
  ["k-primary", "k-bg"], // links and ghost buttons
  ["k-primary", "k-surface"],
  ["k-primary-hover", "k-bg"],
  ["k-primary-hover", "k-surface-2"],
  ["k-accent-ink", "k-accent"],
  ["k-success-ink", "k-success-bg"],
  ["k-warning-ink", "k-warning-bg"],
  ["k-danger-ink", "k-danger-bg"],
  ["k-info-ink", "k-info-bg"],
  ["k-danger", "k-bg"], // field error text
  ["k-danger", "k-surface"],
  ["k-danger-solid-ink", "k-danger-solid"], // destructive button label
];

const UI_PAIRS: [string, string][] = [
  ["k-border-strong", "k-bg"], // input borders
  ["k-border-strong", "k-surface"],
  ["k-focus", "k-bg"], // focus ring
  ["k-focus", "k-surface"],
  ["k-danger", "k-surface"], // invalid input border
];

describe.each([
  ["light", light],
  ["dark", dark],
] as const)("%s theme contrast", (_name, t) => {
  it.each(TEXT_PAIRS)("%s on %s reaches 4.5:1", (fg, bg) => {
    const f = t[fg];
    const b = t[bg];
    expect(f, `missing token ${fg}`).toBeDefined();
    expect(b, `missing token ${bg}`).toBeDefined();
    expect(contrast(f as string, b as string)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(UI_PAIRS)("%s on %s reaches 3:1 (UI components)", (fg, bg) => {
    expect(contrast(t[fg] as string, t[bg] as string)).toBeGreaterThanOrEqual(3);
  });
});

/* Curated palettes: each overrides brand colours on top of the base theme, in light and dark. */
const PALETTES = ["ocean", "forest"] as const;

describe.each(PALETTES)("palette %s", (palette) => {
  const pLight = tokens(block(`:root[data-palette="${palette}"] {`));
  const pDarkExplicit = tokens(block(`:root[data-palette="${palette}"][data-theme="dark"]`));
  const pDarkMedia = tokens(block(`:root[data-palette="${palette}"]:not([data-theme="light"])`));
  const variants = [
    ["light", { ...light, ...pLight }],
    ["dark", { ...dark, ...pLight, ...pDarkExplicit }],
  ] as const;

  describe.each(variants)("%s", (_name, t) => {
    it.each(TEXT_PAIRS)("%s on %s reaches 4.5:1", (fg, bg) => {
      expect(contrast(t[fg] as string, t[bg] as string)).toBeGreaterThanOrEqual(4.5);
    });
    it.each(UI_PAIRS)("%s on %s reaches 3:1", (fg, bg) => {
      expect(contrast(t[fg] as string, t[bg] as string)).toBeGreaterThanOrEqual(3);
    });
  });

  it("the dark palette overrides every colour the light palette sets (so nothing light leaks into dark)", () => {
    expect(Object.keys(pDarkExplicit).sort()).toEqual(Object.keys(pLight).sort());
  });

  it("the automatic and explicit dark palettes stay identical", () => {
    expect(pDarkMedia).toEqual(pDarkExplicit);
  });
});

describe("theme definitions", () => {
  it("the automatic dark theme (media query) and the explicit data-theme=dark stay identical", () => {
    for (const key of Object.keys(darkExplicit)) {
      expect(darkMedia[key], key).toBe(darkExplicit[key]);
    }
  });

  it("respects reduced motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/u);
  });

  it("keeps touch targets at 44px or larger for primary controls", () => {
    expect(css).toMatch(/--k-tap:\s*2\.75rem/u);
  });
});
