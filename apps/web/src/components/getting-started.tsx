"use client";

import { Badge, Card } from "@kidos/ui";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

interface Step {
  key: string;
  label: string;
  why: string;
  href?: string;
  done: boolean;
}

/**
 * First-run checklist for families: what to do first, in order, each with a reason and a link. Every tick comes from
 * live data (the account, the family, the person's own requests), so it is never stale, and the card disappears once
 * everything is done. Read failures leave a step unticked rather than guessing.
 */
export function GettingStarted() {
  const { me, can } = useSession();
  const inCommunity = me.tenants.some((t) => t.type === "community" && t.status === "active");
  const acting = !me.platformScope && me.tenants.some((t) => t.id === me.activeTenantId && t.type === "community");
  const canRequest = acting && can("requests.create_own");
  const [hasChildren, setHasChildren] = useState(false);
  const [hasRequest, setHasRequest] = useState(false);

  useEffect(() => {
    let live = true;
    void api<{ children: unknown[] }>("/me/family")
      .then((f) => live && setHasChildren(f.children.length > 0))
      .catch(() => undefined);
    if (canRequest) {
      void api<{ data: unknown[] }>("/requests?limit=1")
        .then((r) => live && setHasRequest(r.data.length > 0))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [canRequest, me.activeTenantId]);

  // Vendor staff and the platform team have their own tools; this list is for families.
  if (me.platformScope || me.tenants.some((t) => t.id === me.activeTenantId && t.type === "vendor")) return null;

  const steps: Step[] = [
    { key: "email", label: "Confirm your email address", why: "So we can reach you about bookings.", done: me.user.emailVerified },
    { key: "mfa", label: "Turn on two-step verification", why: "A code from your phone keeps your account yours.", href: "/app/security", done: me.mfaEnabled },
    { key: "join", label: "Join your community", why: "Activities and providers are shown community by community.", href: "/app/join", done: inCommunity },
    { key: "family", label: "Add your children", why: "A nickname, a year of birth and interests help us suggest the right things. Only you see them.", href: "/app/family", done: hasChildren },
    ...(canRequest || hasRequest
      ? [{ key: "request", label: "Make your first request", why: "Tell us what you need; the team finds trusted options for you.", href: "/app/requests/new", done: hasRequest }]
      : []),
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;

  return (
    <Card>
      <section aria-labelledby="getting-started-title" className="k-stack">
        <div className="k-row" style={{ justifyContent: "space-between" }}>
          <h2 id="getting-started-title" style={{ margin: 0 }}>
            Getting started
          </h2>
          <Badge tone="info">
            {doneCount} of {steps.length} done
          </Badge>
        </div>
        <div className="k-progress" aria-hidden="true">
          <span style={{ width: `${Math.round((doneCount / steps.length) * 100)}%` }} />
        </div>
        <ol className="k-checklist">
          {steps.map((s) => (
            <li key={s.key} data-done={s.done}>
              <span className="k-check-mark" aria-hidden="true">
                {s.done ? "✓" : ""}
              </span>
              <div>
                <p className="k-checklist-label">
                  {s.href && !s.done ? <Link href={s.href}>{s.label}</Link> : s.label}
                  <span className="k-sr-only">{s.done ? " (done)" : " (to do)"}</span>
                </p>
                {!s.done && <p className="k-hint">{s.why}</p>}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </Card>
  );
}
