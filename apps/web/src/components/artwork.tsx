import { Illustration, cx } from "@kidos/ui";
import { PHOTO_ASPECT, photoUrl, showDrawingsWhenNoPhoto, type PhotoSlot } from "@/lib/photos";

/**
 * The picture for a place on a page: a real photograph when one has been supplied for that slot, otherwise the drawn
 * stand-in (or nothing). Always decorative: the text beside it carries the meaning, so it has an empty description and
 * is hidden from screen readers. `priority` is for the one picture at the top of a page (loaded first).
 */
export function Artwork({ slot, className, priority = false, photos, fallback }: { slot: PhotoSlot; className?: string; priority?: boolean; photos?: string | undefined; fallback?: string | undefined }) {
  const url = photoUrl(slot, photos ?? process.env.NEXT_PUBLIC_PHOTOS);
  if (url) {
    const [w, h] = PHOTO_ASPECT[slot];
    return (
      // A plain image on purpose: the files are supplied already sized (see PHOTO_RECOMMENDED_PX) and this needs no image service.
      <img
        src={url}
        alt=""
        aria-hidden="true"
        width={w * 100}
        height={h * 100}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        {...(priority ? { fetchPriority: "high" as const } : {})}
        className={cx("k-photo", className)}
        style={{ aspectRatio: `${w} / ${h}` }}
      />
    );
  }
  return showDrawingsWhenNoPhoto(fallback ?? process.env.NEXT_PUBLIC_ARTWORK_FALLBACK) ? <Illustration name={slot} {...(className ? { className } : {})} /> : null;
}
