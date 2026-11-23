import type { Metadata } from "next";
import { FamilyPage } from "@/components/family";

export const metadata: Metadata = { title: "My family" };

export default function Page() {
  return <FamilyPage />;
}
