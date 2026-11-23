import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Artwork } from "../src/components/artwork";
import { PHOTO_ASPECT, PHOTO_EXTENSIONS, PHOTO_MAX_BYTES, PHOTO_SLOTS, parsePhotoList, photoUrl, showDrawingsWhenNoPhoto } from "../src/lib/photos";

const webRoot = path.resolve(__dirname, "..");
const photosDir = path.join(webRoot, "public", "photos");

describe("which photos have been supplied", () => {
  it("reads a slot name with an allowed extension and ignores everything else", () => {
    const m = parsePhotoList("family.jpg, kids.WEBP ,mumAndChild.avif,notaslot.jpg,community.png,celebrate,.jpg,explore.jpeg");
    expect([...m.entries()]).toEqual([
      ["family", "family.jpg"],
      ["kids", "kids.WEBP"],
      ["mumAndChild", "mumAndChild.avif"],
      ["explore", "explore.jpeg"],
    ]);
  });

  it("cannot be steered to another path or another site", () => {
    const m = parsePhotoList("../family.jpg,family/../kids.jpg,https://evil.example/kids.jpg,/family.jpg,family.jpg.exe,kids.jpg/../../x.jpg");
    expect([...m.keys()]).toEqual([]);
  });

  it("keeps the first photo when a slot has two", () => {
    expect(parsePhotoList("family.jpg,family.webp").get("family")).toBe("family.jpg");
  });

  it("gives the public address of a photo, or null when there is none", () => {
    expect(photoUrl("family", "family.jpg")).toBe("/photos/family.jpg");
    expect(photoUrl("kids", "family.jpg")).toBeNull();
    expect(photoUrl("kids", "")).toBeNull();
    expect(photoUrl("kids", undefined)).toBeNull();
  });

  it("shows the drawn stand-in unless told to show nothing", () => {
    expect(showDrawingsWhenNoPhoto(undefined)).toBe(true);
    expect(showDrawingsWhenNoPhoto("drawings")).toBe(true);
    expect(showDrawingsWhenNoPhoto("none")).toBe(false);
  });
});

describe("the picture shown for a place on a page", () => {
  it("is the photo, as a decorative image of the right shape, when one was supplied", () => {
    const html = renderToStaticMarkup(<Artwork slot="family" photos="family.jpg" className="k-welcome-art" />);
    expect(html).toContain('src="/photos/family.jpg"');
    expect(html).toContain('alt=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("aspect-ratio:3 / 2");
    expect(html).toContain("k-photo");
    expect(html).toContain("k-welcome-art");
    expect(html).not.toContain("<svg");
  });

  it("loads the top-of-page picture first", () => {
    const html = renderToStaticMarkup(<Artwork slot="family" photos="family.jpg" priority />);
    expect(html).toContain('loading="eager"');
    expect(html.toLowerCase()).toContain('fetchpriority="high"');
  });

  it("falls back to the drawing when no photo was supplied for that place", () => {
    const html = renderToStaticMarkup(<Artwork slot="kids" photos="family.jpg" />);
    expect(html).toContain("<svg");
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("<img");
  });

  it("shows nothing at all when the fallback is switched off", () => {
    expect(renderToStaticMarkup(<Artwork slot="kids" photos="" fallback="none" />)).toBe("");
  });

  it("a photo wins even when the fallback is switched off", () => {
    expect(renderToStaticMarkup(<Artwork slot="kids" photos="kids.jpg" fallback="none" />)).toContain("<img");
  });
});

interface Credit {
  file?: string;
  source?: string;
  licence?: string;
  permission?: string;
}

describe("the photo files in the repository", () => {
  const files = existsSync(photosDir) ? readdirSync(photosDir).filter((f) => !f.startsWith(".")) : [];
  const credits = JSON.parse(readFileSync(path.join(webRoot, "photo-credits.json"), "utf8")) as Credit[];

  it("the permission records are not inside the public folder (everything there is served to visitors)", () => {
    expect(files.filter((f) => /\.(json|md|txt|csv)$/iu.test(f))).toEqual([]);
  });

  it("every file is a known slot with an allowed extension, small enough for a phone", () => {
    for (const f of files) {
      const dot = f.lastIndexOf(".");
      const slot = f.slice(0, dot);
      const ext = f.slice(dot + 1).toLowerCase();
      expect((PHOTO_SLOTS as readonly string[]).includes(slot), `${f}: unknown slot (use one of ${PHOTO_SLOTS.join(", ")})`).toBe(true);
      expect((PHOTO_EXTENSIONS as readonly string[]).includes(ext), `${f}: use ${PHOTO_EXTENSIONS.join(", ")}`).toBe(true);
      expect(statSync(path.join(photosDir, f)).size, `${f} is over ${PHOTO_MAX_BYTES / 1024} KB`).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
    }
  });

  it("every photo has a permission record naming its source, its licence and how the people pictured agreed", () => {
    for (const f of files) {
      const c = credits.find((x) => x.file === f);
      expect(c, `${f} has no record in apps/web/photo-credits.json (source, licence, permission)`).toBeDefined();
      for (const field of ["source", "licence", "permission"] as const) {
        expect((c?.[field] ?? "").trim().length, `${f}: "${field}" is empty`).toBeGreaterThan(5);
      }
    }
  });

  it("no record is left behind for a photo that is gone", () => {
    for (const c of credits) expect(files.includes(c.file ?? ""), `${c.file ?? "(no file)"} has a record but no file`).toBe(true);
  });

  it("every slot has a shape to be cropped to", () => {
    for (const slot of PHOTO_SLOTS) expect(PHOTO_ASPECT[slot].every((n) => n > 0)).toBe(true);
  });
});
