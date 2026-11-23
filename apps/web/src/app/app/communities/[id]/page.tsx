import type { Metadata } from "next";
import { CommunityDetail } from "@/components/community-detail";

export const metadata: Metadata = { title: "Community" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CommunityDetail id={id} />;
}
