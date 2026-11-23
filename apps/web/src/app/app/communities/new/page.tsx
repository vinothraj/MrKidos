import type { Metadata } from "next";
import { CommunityNew } from "@/components/communities-admin";

export const metadata: Metadata = { title: "Register a community" };

export default function Page() {
  return <CommunityNew />;
}
