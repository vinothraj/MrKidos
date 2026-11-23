import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppFrame } from "@/components/app-shell";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function SignedInLayout({ children }: { children: ReactNode }) {
  return <AppFrame>{children}</AppFrame>;
}
