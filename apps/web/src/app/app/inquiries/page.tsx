import type { Metadata } from "next";
import { InquiriesList } from "@/components/inquiries";

export const metadata: Metadata = { title: "Inquiries" };

export default function Page() {
  return <InquiriesList />;
}
