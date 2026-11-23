import type { Metadata } from "next";
import { MfaVerifyForm } from "@/components/auth-forms";

export const metadata: Metadata = { title: "Two-step verification" };

export default function MfaPage() {
  return <MfaVerifyForm />;
}
