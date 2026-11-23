/** Working name. Changing it here (or via NEXT_PUBLIC_BRAND_NAME) renames the product everywhere in the web app. */
export const BRAND_NAME = process.env["NEXT_PUBLIC_BRAND_NAME"] ?? "Kidos";
export const TAGLINE = "Discover More. Experience More. Together.";

import { parseSupport } from "./support";

/** Contact details for the public safety page. Empty until the founder sets them (see docs/LAUNCH_READINESS.md). */
export const SUPPORT = parseSupport(process.env["NEXT_PUBLIC_SUPPORT_EMAIL"], process.env["NEXT_PUBLIC_SUPPORT_PHONE"]);
