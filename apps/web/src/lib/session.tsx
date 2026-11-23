"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, setPlatformMode } from "./api";

const PLATFORM_KEY = "kidos.platformMode";

function readStoredPlatformMode(): boolean {
  try {
    return typeof window !== "undefined" && window.sessionStorage.getItem(PLATFORM_KEY) === "on";
  } catch {
    return false; // storage can be unavailable (private windows, blocked site data)
  }
}

export interface Tenant {
  id: string;
  name: string;
  type: string;
  /** draft, verification, active or suspended. People cannot act inside a suspended organization. */
  status: string;
  roles: string[];
}

export interface Me {
  user: { id: string; email: string; displayName: string; emailVerified: boolean };
  mfaEnabled: boolean;
  mfaEnrollmentRequired: boolean;
  tenants: Tenant[];
  activeTenantId: string | null;
  platformScope: boolean;
  /** The person is on the platform team and may switch to platform mode. */
  platformStaff: boolean;
  /** The organization this session was acting in has been suspended, so no organization is active. */
  activeOrganizationSuspended: boolean;
  permissions: string[];
  /** Display preferences (migration 0018). `palette` null means: use the community's palette. */
  appearance?: { themeMode: string; palette: string | null; communityPalette: string | null };
}

interface SessionValue {
  me: Me;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  can: (permission: string) => boolean;
  platformMode: boolean;
  setPlatformModeOn: (on: boolean) => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}

/**
 * Loads the signed-in user once and keeps it fresh. Unauthenticated visitors are sent to sign-in; sessions that still
 * owe a second factor are sent to the MFA step. The API remains the authority: this only decides what to render.
 */
export function SessionProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [platformMode, setMode] = useState<boolean>(() => {
    const stored = readStoredPlatformMode();
    setPlatformMode(stored); // must be in place before the first request
    return stored;
  });

  /** Fetches the current user. Resolves to null after redirecting an unauthenticated visitor. */
  const fetchMe = useCallback(async (): Promise<Me | null> => {
    try {
      return await api<Me>("/me");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        if (err.code === "mfa_required") router.replace("/login/mfa");
        else router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        return null;
      }
      throw err;
    }
  }, [router, pathname]);

  useEffect(() => {
    let active = true;
    void fetchMe().then((fresh) => {
      if (active && fresh) setMe(fresh);
    });
    return () => {
      active = false;
    };
  }, [fetchMe]);

  const refresh = useCallback(async () => {
    const fresh = await fetchMe();
    if (fresh) setMe(fresh);
  }, [fetchMe]);

  const signOut = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
    }
  }, [router]);

  const setPlatformModeOn = useCallback(
    async (on: boolean) => {
      setPlatformMode(on);
      setMode(on);
      try {
        window.sessionStorage.setItem(PLATFORM_KEY, on ? "on" : "off");
      } catch {
        // not persisted; the choice still applies until the page is reloaded
      }
      const fresh = await fetchMe();
      if (fresh) setMe(fresh);
    },
    [fetchMe],
  );

  const value = useMemo<SessionValue | null>(
    () => (me ? { me, refresh, signOut, can: (p) => me.permissions.includes(p), platformMode, setPlatformModeOn } : null),
    [me, refresh, signOut, platformMode, setPlatformModeOn],
  );

  if (!value) return <>{fallback}</>;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
