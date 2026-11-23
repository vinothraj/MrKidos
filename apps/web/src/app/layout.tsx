import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@kidos/ui/styles.css";
import { BRAND_NAME, TAGLINE } from "@/lib/brand";
import { EARLY_THEME_SCRIPT } from "@/lib/theme";

export const metadata: Metadata = {
  title: { default: `${BRAND_NAME}: ${TAGLINE}`, template: `%s · ${BRAND_NAME}` },
  description:
    "Discover extraordinary experiences, trusted services, exciting activities and opportunities for your family and community.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The early script may set data-theme / data-palette before hydration, hence suppressHydrationWarning on <html>.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* A fixed string from our own code (lib/theme.ts), no user input. */}
        <script dangerouslySetInnerHTML={{ __html: EARLY_THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
