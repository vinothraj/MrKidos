import type { Metadata } from "next";
import { RequestDetail } from "@/components/requests";

export const metadata: Metadata = { title: "Request" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RequestDetail id={id} />;
}
