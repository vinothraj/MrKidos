import type { Metadata } from "next";
import { VendorNew } from "@/components/vendors-admin";

export const metadata: Metadata = { title: "Register a vendor" };

export default function Page() {
  return <VendorNew />;
}
