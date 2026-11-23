import type { Metadata } from "next";
import { Suspense } from "react";
import { RequestNew } from "@/components/requests";

export const metadata: Metadata = { title: "Make a request" };

export default function Page() {
  // useSearchParams (the optional catalog link) needs a Suspense boundary in the App Router
  return (
    <Suspense fallback={null}>
      <RequestNew />
    </Suspense>
  );
}
