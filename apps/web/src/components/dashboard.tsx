"use client";

import { Alert, Badge, Button, Card, EmptyState } from "@kidos/ui";
import Link from "next/link";
import { useCallback, useState } from "react";
import { Artwork } from "@/components/artwork";
import { CommunityBanners } from "@/components/banners";
import { GettingStarted } from "@/components/getting-started";
import { api } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import { useSession } from "@/lib/session";
import { useLoad } from "@/lib/use-load";

function humanRole(key: string): string {
  return key.replace(/_/gu, " ").replace(/^./u, (c) => c.toUpperCase());
}

/** What is waiting for this person in the organization they are acting in. Derived from live state, so it is never stale. */
// (keyed by the parent on the organization and platform mode, so switching either reloads it)
function WaitingForYou() {
  const loader = useCallback(() => api<{ items: { key: string; label: string; href: string }[] }>("/me/attention"), []);
  const { state } = useLoad(loader);
  if (state.status !== "ready" || state.data.items.length === 0) return null;
  return (
    <section aria-labelledby="waiting-title" className="k-stack">
      <h2 id="waiting-title">Waiting for you</h2>
      <Card>
        <ul className="k-stack k-stack-sm" style={{ margin: 0, paddingLeft: "var(--k-space-5)" }}>
          {state.data.items.map((i) => (
            <li key={i.key}>
              <Link href={i.href}>{i.label}</Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

export function Dashboard() {
  const { me } = useSession();
  const resend = useSubmit();
  const [resent, setResent] = useState(false);

  async function onResend() {
    const ok = await resend.run(async () => {
      await api("/auth/email/resend", { method: "POST" });
      return true;
    });
    if (ok) setResent(true);
  }

  const needsOrganization = me.tenants.some((t) => t.status !== "suspended") && me.activeTenantId === null;

  return (
    <div className="k-stack-lg k-stack">
      <div className={me.platformScope ? undefined : "k-welcome"}>
        <div>
          <h1>Welcome, {me.user.displayName}</h1>
          <p className="k-muted">Here is where things stand with your account.</p>
        </div>
        {!me.platformScope && <Artwork slot="family" className="k-welcome-art" />}
      </div>

      {/* Keyed by the organization, so switching community shows that community's news. */}
      {!me.platformScope && <CommunityBanners key={me.activeTenantId ?? "none"} />}
      <GettingStarted />

      <div className="k-stack" aria-label="Things that need your attention" role="region">
        {!me.user.emailVerified && (
          <Alert variant="warning" title="Confirm your email address">
            We sent a confirmation link to {me.user.email}. Some features stay locked until you confirm it.
            <div className="k-row" style={{ marginTop: "var(--k-space-3)" }}>
              <Button size="sm" variant="secondary" loading={resend.submitting} onClick={() => void onResend()} disabled={resent}>
                {resent ? "Link sent" : "Resend confirmation"}
              </Button>
            </div>
            <ErrorSummary submit={resend} />
          </Alert>
        )}
        {me.mfaEnrollmentRequired && (
          <Alert variant="danger" title="Two-step verification is required for your role">
            Your role, or the community you are acting in, asks everyone to use two-step verification. Set it up on the{" "}
            <Link href="/app/security">Security page</Link> (it takes about two minutes with an authenticator app) to unlock your tools.
          </Alert>
        )}
        {me.tenants.some((t) => t.status === "suspended") && (
          <Alert variant="warning" title="An organization of yours is suspended">
            {me.tenants.filter((t) => t.status === "suspended").map((t) => t.name).join(", ")} cannot be used right now. Please contact the platform team if you
            think this is a mistake.
          </Alert>
        )}
        {needsOrganization && (
          <Alert variant="info" title="Choose an organization">
            Use the selector at the top of the page to pick the community or business you want to work in.
          </Alert>
        )}
        {me.user.emailVerified && !me.mfaEnrollmentRequired && !needsOrganization && !me.mfaEnabled && (
          <Alert variant="info" title="Protect your account">
            Add a second step to sign-in on the <Link href="/app/security">Security page</Link>.
          </Alert>
        )}
      </div>

      <WaitingForYou key={`${me.activeTenantId ?? "none"}|${me.platformScope}`} />

      <section aria-labelledby="orgs-title" className="k-stack">
        <h2 id="orgs-title">Your organizations</h2>
        {me.tenants.length === 0 ? (
          <EmptyState title="You are not part of a community yet" art={<Artwork slot="community" />}>
            Joining a community arrives in the next release. We will let you know when your community is ready.
          </EmptyState>
        ) : (
          <ul className="k-grid" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {me.tenants.map((t) => (
              <li key={t.id}>
                <Card style={{ height: "100%" }}>
                  <h3>{t.name}</h3>
                  <p className="k-muted">{t.type === "platform" ? "Platform team" : t.type === "vendor" ? "Provider" : "Community"}</p>
                  <div className="k-row">
                    {t.roles.length === 0 && <Badge>Member</Badge>}
                    {t.roles.map((r) => (
                      <Badge key={r} tone="info">
                        {humanRole(r)}
                      </Badge>
                    ))}
                    {t.id === me.activeTenantId && <Badge tone="success">Selected</Badge>}
                    {t.status === "suspended" && <Badge tone="danger">Suspended</Badge>}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
