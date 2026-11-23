"use client";

import { AppHeader, Button, SkipLink, Spinner, Skeleton, type NavItem } from "@kidos/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ChangeEvent, type ReactNode } from "react";
import { api } from "@/lib/api";
import { BRAND_NAME } from "@/lib/brand";
import { SessionProvider, useSession, type Me } from "@/lib/session";
import { useApplyAppearance } from "./appearance";
import { BrandMark } from "./brand-mark";

interface NavDefinition {
  href: string;
  label: string;
  /** UI-only hint. The API enforces the permission regardless of what is shown here. */
  requires?: string;
  exact?: boolean;
}

/** Navigation is data: a link appears only when the user holds the permission it needs, in the context they are acting in. */
function navFor(me: Me): NavDefinition[] {
  const myCommunity = me.platformScope ? undefined : me.tenants.find((t) => t.id === me.activeTenantId && t.type === "community");
  const myBusiness = me.platformScope ? undefined : me.tenants.find((t) => t.id === me.activeTenantId && t.type === "vendor");
  return [
    { href: "/app", label: "Home", exact: true },
    // Platform team: every community and vendor. Community administrators: the community they are acting in.
    ...(me.platformScope ? [{ href: "/app/communities", label: "Communities", requires: "communities.read" }] : []),
    ...(me.platformScope ? [{ href: "/app/vendors", label: "Vendors", requires: "vendors.read" }] : []),
    ...(myCommunity ? [{ href: `/app/communities/${myCommunity.id}`, label: "My community", requires: "communities.read" }] : []),
    ...(myCommunity ? [{ href: "/app/community-vendors", label: "Community vendors", requires: "community.approve_vendor" }] : []),
    ...(myCommunity ? [{ href: "/app/catalog", label: "Find services", requires: "catalog.read" }] : []),
    ...(myBusiness ? [{ href: `/app/vendors/${myBusiness.id}`, label: "My business", requires: "vendors.read" }] : []),
    ...(myBusiness ? [{ href: "/app/inquiries", label: "Inquiries", requires: "inquiries.respond" }] : []),
    ...(myBusiness ? [{ href: "/app/reviews", label: "Reviews", requires: "reviews.reply" }] : []),
    ...(me.platformScope ? [{ href: "/app/reviews", label: "Reviews", requires: "reviews.moderate" }] : []),
    // Requests: the platform team's queue, a community administrator's view of their community, or a family's own.
    ...(me.platformScope ? [{ href: "/app/requests", label: "Request queue", requires: "requests.read_all" }] : []),
    ...(myCommunity && me.permissions.includes("requests.read_community") ? [{ href: "/app/requests", label: "Community requests" }] : []),
    ...(myCommunity && !me.permissions.includes("requests.read_community") ? [{ href: "/app/requests", label: "My requests", requires: "requests.read_own" }] : []),
    // Concerns: anyone acting in a community or business can report; the platform team decides.
    ...(!me.platformScope ? [{ href: "/app/concerns", label: "Report a concern", requires: "concerns.create" }] : []),
    ...(me.platformScope ? [{ href: "/app/concerns", label: "Concerns", requires: "concerns.manage" }] : []),
    { href: "/app/family", label: "My family" },
    { href: "/app/join", label: "Join a community" },
    { href: "/app/audit", label: "Audit log", requires: "audit.read" },
    { href: "/app/security", label: "Security" },
    { href: "/app/settings", label: "Settings" },
  ];
}

/** Names of the app's sections, for breadcrumbs. An id in the path reads "Details". */
const CRUMB_LABELS: Record<string, string> = {
  requests: "Requests",
  new: "New",
  settings: "Settings",
  communities: "Communities",
  vendors: "Vendors",
  catalog: "Find services",
  family: "My family",
  security: "Security",
  audit: "Audit log",
  inquiries: "Inquiries",
  reviews: "Reviews",
  concerns: "Concerns",
  join: "Join a community",
  "community-vendors": "Community vendors",
};
const ID = /^[0-9a-f-]{36}$/u;

/** "Home / Requests / Details": where you are, and the way back. Not shown on Home itself. */
function Breadcrumbs({ pathname, platformScope }: { pathname: string; platformScope: boolean }) {
  const parts = pathname.split("/").filter(Boolean).slice(1); // drop "app"
  if (parts.length === 0) return null;
  const crumbs = parts.map((p, i) => ({ href: `/app/${parts.slice(0, i + 1).join("/")}`, label: ID.test(p) ? "Details" : (CRUMB_LABELS[p] ?? p) }));
  return (
    <nav className="k-crumbs" aria-label="Breadcrumb">
      <ol>
        <li>
          <Link href="/app">Home</Link>
        </li>
        {crumbs.map((c, i) => (
          <li key={c.href}>
            {i === crumbs.length - 1 ? (
              <span aria-current="page">{c.label}</span>
            ) : // plain text where there is no page for this person: "vendors" under the catalog, and the platform-only lists
            (parts[i] === "vendors" && parts[0] === "catalog") || (!platformScope && (parts[i] === "communities" || parts[i] === "vendors")) ? (
              <span>{c.label}</span>
            ) : (
              <Link href={c.href}>{c.label}</Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function LoadingFrame() {
  return (
    <>
      <SkipLink />
      <header className="k-header">
        <div className="k-container k-header-inner">
          <span className="k-brand">
            <BrandMark />
          </span>
        </div>
      </header>
      <main id="main" className="k-container k-main" aria-busy="true">
        <p>
          <Spinner label="Loading your account" /> Loading your account…
        </p>
        <Skeleton height="2rem" width="40%" />
      </main>
    </>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { me, can, signOut, refresh, platformMode, setPlatformModeOn } = useSession();
  const pathname = usePathname();
  const [switching, setSwitching] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [togglingMode, setTogglingMode] = useState(false);
  useApplyAppearance(me);

  const items: (NavItem & { key: string })[] = navFor(me).filter((n) => !n.requires || can(n.requires)).map((n) => ({
    key: n.href,
    href: n.href,
    label: n.label,
    current: n.exact ? pathname === n.href : pathname.startsWith(n.href),
  }));

  async function onTenantChange(e: ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    setSwitching(true);
    try {
      await api("/me/tenants/switch", { method: "POST", body: { tenantId: value === "" ? null : value } });
      await refresh();
    } finally {
      setSwitching(false);
    }
  }

  return (
    <>
      <SkipLink />
      <AppHeader
        brand={<BrandMark />}
        brandHref="/app"
        nav={items}
        navLabel="Account"
        renderLink={(item) => (
          <Link href={item.href} aria-current={item.current ? "page" : undefined}>
            {item.label}
          </Link>
        )}
        actions={
          <>
            {me.platformStaff && (
              <Button
                size="sm"
                variant={platformMode ? "primary" : "secondary"}
                aria-pressed={platformMode}
                loading={togglingMode}
                onClick={() => {
                  setTogglingMode(true);
                  void setPlatformModeOn(!platformMode).finally(() => setTogglingMode(false));
                }}
              >
                Platform mode
              </Button>
            )}
            {me.tenants.length > 0 && (
              <label className="k-row">
                <span className="k-sr-only">Active organization</span>
                <select
                  className="k-input"
                  style={{ minWidth: "10rem", maxWidth: "16rem" }}
                  value={me.activeTenantId ?? ""}
                  onChange={(e) => void onTenantChange(e)}
                  disabled={switching}
                >
                  <option value="">No organization selected</option>
                  {me.tenants.map((t) => (
                    <option key={t.id} value={t.id} disabled={t.status === "suspended"}>
                      {t.status === "suspended" ? `${t.name} (suspended)` : t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button
              variant="secondary"
              size="sm"
              loading={signingOut}
              onClick={() => {
                setSigningOut(true);
                void signOut();
              }}
            >
              Sign out
            </Button>
          </>
        }
      />
      <main id="main" className="k-container k-main" tabIndex={-1}>
        <Breadcrumbs pathname={pathname} platformScope={me.platformScope} />
        {children}
      </main>
      <footer className="k-footer">
        <div className="k-container k-row">
          <span>
            Signed in as {me.user.email} · {BRAND_NAME}
          </span>
          <Link href="/safety">Safety</Link>
        </div>
      </footer>
    </>
  );
}

export function AppFrame({ children }: { children: ReactNode }) {
  return (
    <SessionProvider fallback={<LoadingFrame />}>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
