import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { BRAND_NAME, SUPPORT, TAGLINE } from "@/lib/brand";
import { FOOTER_COLUMNS } from "@/lib/site";
import { phoneHref } from "@/lib/support";

/** The public site footer. Contact details appear only when the team has set them (nothing is invented). */
export function SiteFooter() {
  return (
    <footer className="k-footer-site">
      <div className="k-container">
        <div className="k-footer-grid">
          <div className="k-stack">
            <BrandMark />
            <p>{TAGLINE}</p>
            <p>
              {BRAND_NAME} helps families and residential communities find trusted activities, shows and services for children, and book them with
              confidence.
            </p>
            {(SUPPORT.email || SUPPORT.phone) && (
              <p>
                {SUPPORT.email && (
                  <>
                    <a href={`mailto:${SUPPORT.email}`}>{SUPPORT.email}</a>
                    <br />
                  </>
                )}
                {SUPPORT.phone && <a href={phoneHref(SUPPORT.phone)}>{SUPPORT.phone}</a>}
              </p>
            )}
          </div>
          {FOOTER_COLUMNS.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <h2>{col.title}</h2>
              <ul>
                {col.links.map((l) => (
                  <li key={l.href + l.label}>
                    <Link href={l.href}>{l.label}</Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="k-footer-base">
          <span>
            © {new Date().getFullYear()} {BRAND_NAME}. All rights reserved.
          </span>
          <span>If a child is in danger right now, call 112 (emergency) or 1098 (Childline).</span>
        </div>
      </div>
    </footer>
  );
}
