import type { Metadata } from "next";
import { JoinPage } from "@/components/join";

export const metadata: Metadata = { title: "Join a community" };

export default function Page() {
  return <JoinPage />;
}
