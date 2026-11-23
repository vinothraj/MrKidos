# Photos (real pictures for the web app)

Drop a photo into `apps/web/public/photos/` named after the place it is for, then restart (or rebuild) the web app. Until a slot has a photo, the
page shows a drawn stand-in (or nothing: set `NEXT_PUBLIC_ARTWORK_FALLBACK=none`).

| File name (jpg, jpeg, webp or avif) | Where it appears | Shown at | Suggested size (px) |
|---|---|---|---|
| `family` | Home page (top) and the signed-in Home | 3:2 | 1500 x 1000 |
| `mumAndChild` | Sign in, and "No children added yet" | 6:5 | 960 x 800 |
| `kids` | Register, and "No requests here yet" | 8:5 | 1200 x 750 |
| `community` | Home page "Made for neighbourhoods", "Join a community", "not part of a community yet" | 26:15 | 1300 x 750 |
| `celebrate` | Email confirmed | 9:7 | 900 x 700 |
| `explore` | Catalog "Nothing to show yet", page not found | 9:7 | 900 x 700 |
| `stepIdea`, `stepMatch`, `stepBook` | The three "How it works" steps | 3:2 | 800 x 534 |

Every photo is cropped to the shape above (the middle is kept), so keep faces away from the edges. Keep each file under
400 KB (export for the web at about 75 to 80 percent quality). They are decorative: the text beside each one says the
same thing, so they carry no description for screen readers.

## Photos in use (2026-11-22)
Picked from Pexels at the founder's request and approved by the founder file by file. Pexels License: free for commercial use, no credit needed; identifiable people must not be shown in a bad light or as endorsing the product; **no model release**. Each file was cropped to its slot, resized, re-encoded (hidden metadata removed) and kept under 400 KB.

| Slot | Pexels photo | Photographer | What it shows |
|---|---|---|---|
| `family` | 9345636 | Anna Pou | Indian family of three in festive clothes on a sofa |
| `mumAndChild` | 11708049 | Rahul Lavhande | Mother and toddler outdoors |
| `kids` | 11344264 | Dev Raj | Children playing in a field |
| `community` | 33808945 | sagar tiwari | Women in saris and children at a neighbourhood celebration |
| `celebrate` | 8104203 | Ivan S | Children with confetti |
| `explore` | 12719277 | Roman Odintsov | Girl looking at a flower through a magnifying glass |
| `stepIdea` | 7692895 | kaboompics | A hand painting a yellow lightbulb (no face) |
| `stepMatch` | 7979605 | Kindel Media | Couple shaking hands with an advisor |
| `stepBook` | 5571743 | Antoni Shkraba | Family looking at a laptop in a kitchen |

Page address of each: `https://www.pexels.com/photo/<id>/`. Incidental details: the `community` photo shows a lorry with a visible brand name; the `family` photo includes small national flags (the photo was taken for Independence Day). To replace a photo, put a new file with the same slot name in `apps/web/public/photos/`, update its record in `apps/web/photo-credits.json`, and restart or rebuild.

## Permission (required)
Pictures of people, and above all of children, need written permission from the people pictured (from a guardian for a
child) for this use, or a licence that includes a model release for commercial use. A free-stock licence usually does
**not** include a model release. For every photo add a record to `apps/web/photo-credits.json` (not public); a test fails without one:

```json
{
  "file": "family.jpg",
  "source": "Where it came from (a stock site and its picture id, or 'own photo by Asha Rao')",
  "licence": "The licence or agreement (for example 'Adobe Stock standard licence, order 123', 'written agreement 2026-12-01')",
  "permission": "How permission to show the people pictured was obtained (for example 'model release on file', 'guardian consent forms, folder X')",
  "credit": "Optional text the licence requires you to show"
}
```
Never use a photo of a real, identifiable child from a vendor, a family on the platform or a community without their
written permission, and remove a photo promptly if the person asks.

## Banner photos (approved 2026-11-23)
Approved by the founder file by file on 2026-11-23, knowing Pexels gives no model release. Downloaded from images.pexels.com (2400 px rendition), cropped to 2:1 at 1600 x 800 with `sharp`, re-encoded, metadata removed, each under 220 KB. Choosable as banner pictures (migration 0021); records in `apps/web/photo-credits.json`.

| Slot | Pexels photo | Photographer | What it shows |
|---|---|---|---|
| `bannerCandles` | 7328336 | pnw-Prod | Parents and children blowing out birthday candles indoors |
| `bannerBirthday` | 27175709 | Helena Lopes | Family celebrating a child's second birthday with a cake |
| `bannerPicnic` | 7669144 | Kampus Production | Family picnic in a park with two children |
| `bannerPark` | 5290393 | Nataliya Vaitkevich | Parents and three children on a picnic blanket |

Banner slots are shown at 2:1 (suggested 1600 x 800); a missing file falls back to a drawing.
