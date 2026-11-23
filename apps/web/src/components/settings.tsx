"use client";

import { Card } from "@kidos/ui";
import Link from "next/link";
import { useSession } from "@/lib/session";
import { AppearanceSettings, CommunityBranding } from "./appearance";
import { BannerManager } from "./banners";
import { PoliciesSection } from "./community-config";

interface Area {
  title: string;
  description: string;
  href: string;
  /** Shown only to people holding this permission in the context they are acting in (the API checks again). */
  requires?: string;
}

/**
 * One place to find every setting. Each card links to the screen that already manages it, so there is a single
 * source of truth per setting and nothing is configured in two places.
 */
export function SettingsPage() {
  const { me, can } = useSession();
  const community = me.platformScope ? undefined : me.tenants.find((t) => t.id === me.activeTenantId && t.type === "community");
  const business = me.platformScope ? undefined : me.tenants.find((t) => t.id === me.activeTenantId && t.type === "vendor");

  const areas: Area[] = [
    { title: "Security and sign-in", description: "Two-step verification, where you are signed in, and signing out everywhere.", href: "/app/security" },
    { title: "My family and privacy", description: "Your household, children's details, consent, and downloading or erasing your data.", href: "/app/family" },
    ...(community
      ? [
          { title: "Community profile", description: "Name, address, contacts and verification status.", href: `/app/communities/${community.id}#details`, requires: "communities.update" },
          { title: "Administrators", description: "Who can manage this community.", href: `/app/communities/${community.id}#administrators`, requires: "communities.assign_admin" },
          { title: "Members and invite codes", description: "Approve people who ask to join, and share or stop invite codes.", href: `/app/communities/${community.id}#members`, requires: "memberships.approve" },
          { title: "Facilities", description: "Halls, grounds and courts that events can use.", href: `/app/communities/${community.id}#facilities`, requires: "facilities.manage" },
          { title: "Policies", description: "Community rules such as quiet hours and whether vendors need approval.", href: `/app/communities/${community.id}#policies`, requires: "policies.manage" },
          { title: "Vendors and approvals", description: "Which vendors residents may see and book.", href: "/app/community-vendors", requires: "community.approve_vendor" },
        ]
      : []),
    ...(business ? [{ title: "Business profile", description: "Your profile, team, offerings, availability and documents.", href: `/app/vendors/${business.id}` }] : []),
    { title: "Audit log", description: "Every important change: who, what and when.", href: "/app/audit", requires: "audit.read" },
  ];
  const visible = areas.filter((a) => !a.requires || can(a.requires));

  return (
    <div className="k-stack k-stack-lg">
      <div>
        <h1>Settings</h1>
        <p className="k-muted">Everything you can set up, in one place. You only see what your role allows.</p>
      </div>
      <AppearanceSettings />
      {community && can("communities.update") && <CommunityBranding communityId={community.id} />}
      {community && can("communities.update") && <BannerManager communityId={community.id} />}
      {community && can("communities.read") && <PoliciesSection id={community.id} category="security" canManage={can("policies.manage")} />}
      <Card>
        <h2>Account rules for everyone</h2>
        <p className="k-muted">These protect every account on the platform. The platform team sets them for everyone, not per community.</p>
        <ul>
          <li>Passwords need at least 12 characters, and common passwords are refused.</li>
          <li>You are signed out after a period without use, and every sign-in ends after a set time.</li>
          <li>Administrators and vendor owners always need two-step verification.</li>
        </ul>
      </Card>
      <section aria-labelledby="areas-title" className="k-stack">
        <h2 id="areas-title">More settings</h2>
        <ul className="k-grid" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {visible.map((a) => (
            <li key={a.title}>
              <Card interactive>
                <h3>
                  <Link href={a.href}>{a.title}</Link>
                </h3>
                <p className="k-muted">{a.description}</p>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
