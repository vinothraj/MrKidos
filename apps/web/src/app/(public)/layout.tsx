import { AppHeader, ButtonLink, SkipLink } from "@kidos/ui";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { SiteFooter } from "@/components/site-footer";
import { PRIMARY_NAV } from "@/lib/site";

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SkipLink />
      <AppHeader
        brand={<BrandMark />}
        brandHref="/"
        nav={PRIMARY_NAV}
        actions={
          <>
            <ButtonLink href="/login" variant="ghost" size="sm">
              Sign in
            </ButtonLink>
            <ButtonLink href="/register" size="sm">
              Create account
            </ButtonLink>
          </>
        }
      />
      <main id="main" className="k-container k-main" tabIndex={-1}>
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
