import type { Metadata } from "next";
import { VendorsList } from "@/components/vendors-admin";

export const metadata: Metadata = { title: "Vendors" };

export default function Page() {
  return <VendorsList />;
}
