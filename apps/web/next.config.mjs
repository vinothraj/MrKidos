/** @type {import('next').NextConfig} */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiOrigin = process.env.API_ORIGIN ?? "http://127.0.0.1:4000";

// Which photos have been supplied (files in public/photos named after a slot, see src/lib/photos.ts). Read when the
// app is built or started, so adding or removing a photo needs a restart or a rebuild.
const photosDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public", "photos");
const photoFiles = existsSync(photosDir) ? readdirSync(photosDir).filter((f) => /\.(jpe?g|webp|avif)$/iu.test(f)) : [];

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // Partial CSP (no script-src yet: Next inline bootstrap scripts need nonces, planned before production).
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@kidos/ui"],
  env: { NEXT_PUBLIC_PHOTOS: photoFiles.join(",") },
  // The browser talks only to the web origin; /api is proxied to the API so session cookies stay first-party.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
