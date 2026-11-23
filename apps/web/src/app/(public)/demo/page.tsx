import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DemoTour } from "@/components/demo-tour";

export const metadata: Metadata = { title: "Demo tour" };

/** Local development only: a production build answers 404 here. */
export default function DemoPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <div className="k-stack k-stack-lg">
      <div className="k-page-hero">
        <span className="k-eyebrow">Development demo</span>
        <h1>Try every flow, step by step</h1>
        <p className="k-hero-lead">
          Each step signs you in as the right person and opens the right page. The demo family, vendor, offerings and requests were created when the development stack started.
        </p>
      </div>
      <DemoTour />
    </div>
  );
}
