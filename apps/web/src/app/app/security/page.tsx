import type { Metadata } from "next";
import { SecurityPage } from "@/components/security";

export const metadata: Metadata = { title: "Security" };

export default function Page() {
  return <SecurityPage />;
}
