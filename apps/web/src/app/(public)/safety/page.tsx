import { Alert, ButtonLink, Card } from "@kidos/ui";
import type { Metadata } from "next";
import { BRAND_NAME, SUPPORT } from "@/lib/brand";
import { phoneHref } from "@/lib/support";

export const metadata: Metadata = { title: "Safety and reporting a concern" };

export default function SafetyPage() {
  return (
    <div className="k-stack k-stack-lg">
      <div>
        <h1>Safety and reporting a concern</h1>
        <p className="k-muted">If something worries you about a child&apos;s safety, how someone behaved, or money, tell us.</p>
      </div>
      <Alert variant="warning" title="If a child is in danger right now">
        Call 112 (emergency) or 1098 (Childline) first. Then tell us.
      </Alert>
      <Card>
        <h2>Tell the team in the app</h2>
        <p>
          If you belong to a community or a business on {BRAND_NAME}, sign in and choose <strong>Report a concern</strong> in the menu. Your report goes to the {BRAND_NAME} team only. It is not shown to the vendor, to your community or to other
          families. The team reads child-safety reports first, decides what to do, and tells you the outcome.
        </p>
        <p>
          <ButtonLink href="/login?next=/app/concerns">Sign in to report a concern</ButtonLink>
        </p>
      </Card>
      {(SUPPORT.email || SUPPORT.phone) && (
        <Card>
          <h2>Contact the team directly</h2>
          <p>Use this if you cannot sign in or do not belong to a community yet.</p>
          <ul>
            {SUPPORT.email && (
              <li>
                Email: <a href={`mailto:${SUPPORT.email}`}>{SUPPORT.email}</a>
              </li>
            )}
            {SUPPORT.phone && (
              <li>
                Phone: <a href={phoneHref(SUPPORT.phone)}>{SUPPORT.phone}</a>
              </li>
            )}
          </ul>
        </Card>
      )}
    </div>
  );
}
