import type { Metadata } from "next";
import { CommunitiesList } from "@/components/communities-admin";

export const metadata: Metadata = { title: "Communities" };

export default function Page() {
  return <CommunitiesList />;
}
