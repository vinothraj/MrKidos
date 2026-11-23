import type { Metadata } from "next";
import { Suspense } from "react";
import { ConcernsPage } from "@/components/concerns";

export const metadata: Metadata = { title: "Concerns" };

export default function Page() {
  // useSearchParams (the optional link from a vendor page) needs a Suspense boundary in the App Router
  return (
    <Suspense fallback={null}>
      <ConcernsPage />
    </Suspense>
  );
}
