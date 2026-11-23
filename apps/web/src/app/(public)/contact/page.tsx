import { ButtonLink, Card } from "@kidos/ui";
import type { Metadata } from "next";
import { BRAND_NAME, SUPPORT } from "@/lib/brand";
import { phoneHref } from "@/lib/support";

export const metadata: Metadata = { title: "Contact us" };

export default function ContactPage() {
  const hasDirect = Boolean(SUPPORT.email || SUPPORT.phone);
  return (
    <div className="k-stack k-stack-lg">
      <div className="k-page-hero">
        <span className="k-eyebrow">Contact us</span>
        <h1>We would love to hear from you</h1>
        <p className="k-hero-lead">Questions, ideas, or want {BRAND_NAME} in your community? Choose the way that suits you best.</p>
      </div>

      <div className="k-cols-3">
        <Card style={{ height: "100%" }}>
          <h2>I am a family</h2>
          <p className="k-muted">Create an account, then make a request from inside your community. The team replies in the request, so everything stays in one place.</p>
          <ButtonLink href="/register">Create your account</ButtonLink>
        </Card>
        <Card style={{ height: "100%" }}>
          <h2>I run a community or offer a service</h2>
          <p className="k-muted">
            {hasDirect ? "Write to us with the name of your community or business and a line about what you need. We will set you up." : "Direct contact details will be published here before we open to more communities. In the meantime, create an account and we will find you."}
          </p>
          {hasDirect && (
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
          )}
        </Card>
        <Card style={{ height: "100%" }}>
          <h2>Something worries me</h2>
          <p className="k-muted">If a child is in danger right now, call 112 (emergency) or 1098 (Childline) first. Then tell us. Reports go to our team only.</p>
          <ButtonLink href="/safety" variant="secondary">
            Safety and reporting
          </ButtonLink>
        </Card>
      </div>

      <Card>
        <h2>Already have an account?</h2>
        <p className="k-muted">Signed-in members can message the team from their request and report a concern from the menu.</p>
        <ButtonLink href="/login" variant="secondary">
          Sign in
        </ButtonLink>
      </Card>
    </div>
  );
}
