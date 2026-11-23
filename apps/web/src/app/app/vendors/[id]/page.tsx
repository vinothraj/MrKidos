import type { Metadata } from "next";
import { VendorDetail } from "@/components/vendor-detail";

export const metadata: Metadata = { title: "Vendor" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VendorDetail id={id} />;
}
