import type { Metadata } from "next";
import { CommunityVendors } from "@/components/community-vendors";

export const metadata: Metadata = { title: "Community vendors" };

export default function Page() {
  return <CommunityVendors />;
}
