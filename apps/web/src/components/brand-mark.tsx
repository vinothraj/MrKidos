import { BRAND_NAME } from "@/lib/brand";

export function BrandMark() {
  return (
    <>
      <span className="k-brand-mark" aria-hidden="true">
        {BRAND_NAME.slice(0, 1).toUpperCase()}
      </span>
      <span>{BRAND_NAME}</span>
    </>
  );
}
