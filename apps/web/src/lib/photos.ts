/**
 * Real photographs for the places that carry artwork. A photo is just a file dropped into `apps/web/public/photos/`
 * with a slot name (see PHOTO_SLOTS), for example `family.jpg`. When a slot has no photo the drawn stand-in is shown
 * (or nothing, see NEXT_PUBLIC_ARTWORK_FALLBACK). Which files exist is read when the web app is built or started
 * (next.config.mjs), so adding or removing a photo needs a restart or a rebuild.
 *
 * Photos of people, and above all of children, need permission from the people pictured (or their guardians) for this
 * use: every photo must have a record in `apps/web/photo-credits.json` (a test enforces it).
 */
import type { IllustrationName } from "@kidos/ui";

export const PHOTO_SLOTS = ["family", "mumAndChild", "kids", "community", "celebrate", "explore", "stepIdea", "stepMatch", "stepBook", "bannerCandles", "bannerBirthday", "bannerPicnic", "bannerPark"] as const satisfies readonly IllustrationName[];
export type PhotoSlot = (typeof PHOTO_SLOTS)[number];

export const PHOTO_EXTENSIONS = ["jpg", "jpeg", "webp", "avif"] as const;

/** The shape each slot is cropped to (width : height), so the page does not jump while a photo loads and every photo fills it. */
export const PHOTO_ASPECT: Record<PhotoSlot, readonly [number, number]> = {
  family: [3, 2],
  mumAndChild: [6, 5],
  kids: [8, 5],
  community: [26, 15],
  celebrate: [9, 7],
  explore: [9, 7],
  stepIdea: [3, 2],
  stepMatch: [3, 2],
  stepBook: [3, 2],
  bannerCandles: [2, 1],
  bannerBirthday: [2, 1],
  bannerPicnic: [2, 1],
  bannerPark: [2, 1],
};

/** Suggested file size in pixels for each slot (twice the largest it is shown at, for sharp screens). */
export const PHOTO_RECOMMENDED_PX: Record<PhotoSlot, readonly [number, number]> = {
  family: [1500, 1000],
  mumAndChild: [960, 800],
  kids: [1200, 750],
  community: [1300, 750],
  celebrate: [900, 700],
  explore: [900, 700],
  stepIdea: [800, 534],
  stepMatch: [800, 534],
  stepBook: [800, 534],
  bannerCandles: [1600, 800],
  bannerBirthday: [1600, 800],
  bannerPicnic: [1600, 800],
  bannerPark: [1600, 800],
};

/** The largest a single photo file may be, so pages stay fast on a phone. */
export const PHOTO_MAX_BYTES = 400 * 1024;

const isSlot = (s: string): s is PhotoSlot => (PHOTO_SLOTS as readonly string[]).includes(s);
const isExtension = (s: string): boolean => (PHOTO_EXTENSIONS as readonly string[]).includes(s);

/** Parses "family.jpg,kids.webp" into slot to file name; anything that is not a known slot with an allowed extension is ignored. */
export function parsePhotoList(list: string | undefined): Map<PhotoSlot, string> {
  const out = new Map<PhotoSlot, string>();
  for (const raw of (list ?? "").split(",")) {
    const file = raw.trim();
    const dot = file.lastIndexOf(".");
    if (dot <= 0) continue;
    const slot = file.slice(0, dot);
    const ext = file.slice(dot + 1).toLowerCase();
    if (isSlot(slot) && isExtension(ext) && !out.has(slot)) out.set(slot, file);
  }
  return out;
}

/** The public address of the photo for a slot, or null when there is none. */
export function photoUrl(slot: PhotoSlot, list: string | undefined = process.env.NEXT_PUBLIC_PHOTOS): string | null {
  const file = parsePhotoList(list).get(slot);
  return file ? `/photos/${encodeURIComponent(file)}` : null;
}

/** What to show for a slot with no photo: the drawn stand-in (default) or nothing. */
export function showDrawingsWhenNoPhoto(value: string | undefined = process.env.NEXT_PUBLIC_ARTWORK_FALLBACK): boolean {
  return (value ?? "drawings") !== "none";
}
