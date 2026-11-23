import type { Metadata } from "next";
import { Catalog } from "@/components/catalog";

export const metadata: Metadata = { title: "Find activities and services" };

export default function Page() {
  return <Catalog />;
}
