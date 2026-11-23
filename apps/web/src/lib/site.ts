/** Links shown in the public header and footer. One list, so the two never disagree. */
export interface SiteLink {
  href: string;
  label: string;
}

export const PRIMARY_NAV: SiteLink[] = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/about", label: "About us" },
  { href: "/safety", label: "Safety" },
  { href: "/contact", label: "Contact us" },
];

export const FOOTER_COLUMNS: { title: string; links: SiteLink[] }[] = [
  {
    title: "Product",
    links: [
      { href: "/how-it-works", label: "How it works" },
      { href: "/how-it-works#families", label: "For families" },
      { href: "/how-it-works#communities", label: "For communities" },
      { href: "/how-it-works#vendors", label: "For providers" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/about", label: "About us" },
      { href: "/contact", label: "Contact us" },
      { href: "/safety", label: "Safety" },
    ],
  },
  {
    title: "Get started",
    links: [
      { href: "/register", label: "Create account" },
      { href: "/login", label: "Sign in" },
    ],
  },
];
