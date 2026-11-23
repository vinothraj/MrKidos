/**
 * Appearance: light / dark / follow the device, and a curated palette. The choice is stored as data on the server
 * (PUT /me/appearance; community default via /communities/:id/branding). A copy is kept in this browser only so the
 * page can paint in the right colours before the account has loaded; the server copy always wins.
 */
export type ThemeMode = "system" | "light" | "dark";
export type Palette = "classic" | "ocean" | "forest";

export const PALETTES: { id: Palette; name: string; description: string; chips: string[] }[] = [
  { id: "classic", name: "Classic", description: "Deep teal with warm amber. Our original, calm look.", chips: ["--k-swatch-classic", "--k-swatch-gold"] },
  { id: "ocean", name: "Ocean", description: "Navy blue with gold. Formal and quiet.", chips: ["--k-swatch-ocean", "--k-swatch-gold"] },
  { id: "forest", name: "Forest", description: "Garden green with gold. Warm and natural.", chips: ["--k-swatch-forest", "--k-swatch-gold"] },
];

export const THEME_MODES: { id: ThemeMode; name: string }[] = [
  { id: "system", name: "Same as my device" },
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
];

const STORE_KEY = "kidos.appearance";

export function isPalette(v: unknown): v is Palette {
  return v === "classic" || v === "ocean" || v === "forest";
}
export function isThemeMode(v: unknown): v is ThemeMode {
  return v === "system" || v === "light" || v === "dark";
}

/** Applies a choice to <html>. Classic is the default palette, so it needs no attribute. */
export function applyAppearance(mode: ThemeMode, palette: Palette): void {
  const root = document.documentElement;
  if (mode === "system") delete root.dataset["theme"];
  else root.dataset["theme"] = mode;
  if (palette === "classic") delete root.dataset["palette"];
  else root.dataset["palette"] = palette;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify({ mode, palette }));
  } catch {
    // storage unavailable (private window, blocked site data): the page still works, it just repaints after loading
  }
}

/**
 * Runs before React, inline in <head>, so a dark-theme visitor never sees a white flash. It only reads two known
 * words from this browser's storage and sets two attributes; anything unexpected is ignored.
 */
export const EARLY_THEME_SCRIPT = `try{var a=JSON.parse(localStorage.getItem("${STORE_KEY}")||"{}"),r=document.documentElement;if(a.mode==="light"||a.mode==="dark")r.dataset.theme=a.mode;if(a.palette==="ocean"||a.palette==="forest")r.dataset.palette=a.palette}catch(e){}`;
