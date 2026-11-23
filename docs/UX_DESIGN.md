# UX Design

Status: structure and principles (Phase 1). Visual design and tokens are finalized in Phase 2 after the brand name is chosen.

## Principles
1. **Warm, trustworthy, family-friendly, premium** but not childish. Clear hierarchy, generous spacing, real photography of experiences.
2. **Mobile-first for residents**: one-handed use, thumb-reachable primary actions, short forms in steps, progress saved as drafts.
3. **Ops workspace is a power tool**: dense, keyboard-friendly, fast filtering; desktop optimized, responsive down to tablet.
4. **Show status, always**: every request and booking has a visible state, next step and who owns it.
5. **Explain automation**: match scores show reasons; AI output (later) is labelled and editable.
6. **Accessible by default**: WCAG 2.2 AA target.

## Experience areas and navigation

| Area | Users | Primary navigation |
|---|---|---|
| Public site | Everyone | Home, How it works, Experiences, Communities, Vendors (become a vendor), About, FAQ, Contact, Sign in/Register |
| Resident app | Residents | Discover, Requests, Bookings, Notifications, Profile (family, privacy) |
| Vendor workspace | Vendor staff | Overview, Inquiries, Quotes, Bookings, Calendar, Offerings, Profile, Reviews |
| Ops workspace | Operations | Dashboard, Requests queue, Request detail, Vendors, Communities, Bookings, Reviews moderation, Settings |
| Community admin | Community staff | Approvals, Requests, Events/Bookings (read), Policies |
| Platform admin | Platform staff | Users and roles, Categories, Audit, Settings |

Navigation is generated from the user's permissions and active tenant.

## Key screens (wireframe priority)
1. Resident home (search, category chips, "request something", upcoming bookings)
2. Request form (stepper: what, when, who, budget, details, review) with draft save
3. Request tracking (timeline, resident-visible updates, quotes when shared, actions)
4. Ops queue (filters, saved views, SLA indicators, bulk actions)
5. Ops request detail (requirements, timeline, notes, match shortlist, inquiries, quotes comparison table, booking panel)
6. Vendor inquiry response (details, availability, quote line items)
7. Vendor profile (admin and public view)
8. Community admin approvals

## Implemented in Milestone 2.3 (design system v0 and web shell)

**Where:** `packages/ui` (tokens `src/styles.css`, components `src/components.tsx`) and `apps/web` (Next.js 16, React 19). Brand name and tagline come from one config value (`lib/brand.ts`, `NEXT_PUBLIC_BRAND_NAME`).

**Tokens:** warm paper background, deep teal primary, amber accent; semantic success/warning/danger/info surfaces; type scale with fluid headings; 4px-based spacing; radius and shadow scales; motion durations; automatic dark theme from `prefers-color-scheme` plus an explicit `data-theme` override; `prefers-reduced-motion` removes animation. Contrast of every text/background pair in both themes is asserted by an automated test that parses the tokens.

**Components built:** Button (variants, sizes, loading with busy state), ButtonLink, TextField, PasswordField (show/hide with stateful accessible name), SelectField, Alert (assertive for errors, polite otherwise, focusable for error summaries), Badge, Card, Spinner, Skeleton, EmptyState, TableWrap (focusable scroll region), SkipLink, VisuallyHidden, AppHeader (inline nav from 768px, disclosure menu below).

**Not built yet:** modal/dialog, drawer, toast, dropdown menu, breadcrumbs, tabs, filter bar, pagination control, timeline, calendar, date/time pickers, file upload with progress, seasonal themes. They are added when the first feature needs them, with the same test bar.

**Pages built:** home (value proposition), sign in, register, MFA verification (authenticator code or recovery code), forgot and reset password, email confirmation, signed-in home (status alerts, organizations with roles), security (two-step setup with QR code and manual key, recovery codes, turn-off, change password, active sessions with revoke), audit log (permission-gated, cursor "Load more"), not-found and error states.

**Added in Phase 3:** components TextAreaField, CheckboxField, FieldGroup. Screens: Join a community (invite code, or find the community and ask), My family (children with explicit consent, export, erase), Communities (platform team: list, register), Community detail (status workflow with readiness checklist and history, details, administrators, facilities, policies, invite codes, members with approve/decline/suspend/reinstate/remove). A "Platform mode" switch in the header (platform team only) widens the person's view to every community; navigation then shows "Communities", while a community administrator sees "My community". Tables have accessible names; destructive actions ask for confirmation in plain language; codes are shown once with a copy button.

**Added in Phase 4:** Screens for three audiences, no new components. *Platform team:* Vendors (list with search, status filter and "Load more"; register), and the vendor workspace, one page of sections with a jump list (status and readiness checklist with history, details, categories, places served, documents and vetting with verify / do-not-accept, offerings, availability, team). *Vendors* (a vendor's own team acting in the vendor): the same workspace under "My business", showing only what their permissions allow (no platform notes, no review buttons). *Community administrators:* "Community vendors" to approve, decline or withdraw approval with a note. *Residents:* "Find services" (search, category, child's age, pricing; cards with price, duration, ages and cancellation policy) and a vendor page with public details only. Principles applied: every blocked step says exactly what is missing instead of being a silent disabled button; documents are described as "Waiting for review", "Verified", "Not accepted" and "Expired" in words and badges (never colour alone); decisions that affect children (approving a vendor, withdrawing approval) ask for a note and take effect immediately.

**Added in Phase 5:** Requests, for three audiences on one set of screens that adapts to the person's permissions. *Families:* "My requests" (everything they asked for, newest first, with "Waiting for you" where a reply is needed), "Make a request" (what do you need, a short title, optional details, then the type's own questions; every error appears next to its field and in a summary), and the request page (a plain-language "We are on it" or "The team has a question for you" banner, details, messages, a history in words, and only the actions that apply: reply, or cancel with a confirmation). *Community administrators:* "Community requests", read-only, with who asked. *Operations:* "Request queue" with summary tiles (open, overdue, due within four hours, unassigned, mine), views and search, and a request page with the target, "Take it", the next steps as buttons, a note for the step (flagged as visible to the family), and internal notes. Principles applied: status and urgency are always words plus colour ("Overdue", "Due soon"), a family never sees the team's clock or staff names, a declined request keeps its reason on the page, and finished requests stay visible to the family by default so nothing seems to vanish. The catalog's "Ask for this" carries the offering into the form.

**Added in Phase 6:** *Operations* get a sourcing workspace on the request page, in the order they work: **Vendors to ask** (a table with the score and every reason in words, "Added by the team: reason" for manual additions, tick the vendors, a message, "Ask N selected vendors"), **Inquiries** (who has answered, with a decline reason, and a form to enter a quote a vendor gave by phone), **Compare quotes** (line items, total, validity, a "Lowest price" tag, shortlist or take off the list) and **Booking** (set the date and place; the page says whose move it is). The workflow buttons above ("Quotes are in", "Offer these options to the family", "Confirm the booking") explain refusals in plain language ("Shortlist at least one quote", "The vendor has not confirmed the booking yet"). *Vendors* get **Inquiries**: a list ("Needs your answer", "You quoted", "Chosen by the family"), and an inquiry page showing only what is needed to quote, with a quote form that totals as you type, a decline with a reason, and, once chosen, the booking with "Confirm this date". *Families* see **Your options** (vendor, line items, total, validity; choosing asks "Choose X for ₹N?" first) and **Your booking** ("You pay the vendor directly", date and place, "Waiting for the vendor" or "Confirmed"). Principles applied: nobody is asked to act on something they cannot see; money is always shown as rupees with a total; the family's choice is confirmed before it is final; the vendor never sees who asked.

**Added in Phase 6.3:** The home page gains **Waiting for you**, a short list of links to exactly what needs the person in the organization they are acting in ("Tell us how it went: Cricket weekend", "2 requests need your quote", "3 reviews need checking"); it disappears when nothing waits. **Payments**: on a confirmed or completed booking, everyone concerned sees "Paid in full / Part paid / Not paid yet", the amounts and references; operations also get two small forms (the platform fee; record a payment, who paid whom) and the vendor sees its fee; the family never does. **Reviews**: after completion the family sees "Your review" (a rating chosen in words, an optional comment with a warning not to name children), then its status ("Waiting to be checked", "Published", or "Why this was not published" with the moderator's reason); operations get a **Reviews** page to publish or decline (a reason is required to decline), vendors get the same page to read their reviews and reply once; the vendor page in the catalog shows "4.5 out of 5 from 12 reviews" and the reviews without names. Ratings are always words ("5 out of 5"); stars are decoration.

**Added in Phase 7 (first slice):** the catalog shows each vendor's rating in words ("Rated 4.5 out of 5 (2 reviews)" or "No reviews yet") and gains three filters: highest price (in rupees), rating (4 or 3 out of 5 or more, with a note that only vendors with reviews are then shown), and "Only the activities I have saved". Every card (and the vendor page) has a **Save** button whose label says what it will do next ("Save" or "Remove from saved", with the activity name for screen readers), a polite live message confirming the result, and it is never disabled mid-request so keyboard focus stays put. The empty saved list says "You have not saved any activities yet". No state is carried by colour or an icon alone.

**Added with the concerns channel (migration 0016):** a **Report a concern** page (and a link from every vendor page, which carries that vendor into the form). It opens with the emergency numbers (112 and 1098, Childline) in a warning box, then a short form: what it is about (a child's safety, how someone behaved, money, something else), a few words, and what happened; the send button waits until all three are filled in. A promise in plain words that the report goes to the platform team only and not to the vendor, the community or other families, and that the team can see who the reporter is. Below it, "Your reports" with each status in words ("Received", "The team is looking at it", "Decided") and, once decided, "What the team decided". The team gets **Concerns**: child-safety reports first with a danger badge, who reported and from where, the vendor linked, "Start looking", a required outcome box, "Mark resolved" and "Close without action", and after a decision a confirmation ("Marked resolved, and the reporter can now read the outcome: ...") because the report then leaves the "needs a decision" view. A person with no community or business selected sees a short message instead of a form. A public **Safety** page (no sign-in; linked from every footer) repeats the emergency numbers, explains who sees a report, offers "Sign in to report a concern", and shows the team's email and phone only when they have been configured. The team's queue says in words how long each report has waited ("Waiting 3 days") and adds a "Waiting over a day" badge to a child-safety report that has waited a day or more.



**Known UX gaps (Phase 6.3):** emails are plain text with a link (no branding, no preferences, no digest), nothing arrives until a mail provider is configured, no receipts or attachments on payments, no way to reverse a mistaken payment record, and the "Waiting for you" list refreshes on page load (it does not update live).

**Known UX gaps (Phase 6):** no attachments on quotes, no calendar for the team or the vendor, no messaging with vendors beyond the inquiry message, no reviews or payment records yet, and a vendor must refresh to see a new inquiry (no notifications).

**Known UX gaps (Phase 5):** requests have no attachments, no notifications (a family must open the app to see a question), no saved drafts, and no calendar or board view for the team; the queue sorts newest first, not by target time.

**Known UX gaps (Phase 4):** documents are references, not uploads; weekly hours allow one slot per day in the form (the API allows several); no calendar view of availability; prices are shown in rupees only; no vendor media (photos, videos); the catalog has no map or "near me".

**Behaviors worth knowing:** navigation links appear only when the user holds the permission (UI hint only; the API enforces); the organization selector in the header switches the active tenant and everything reloads for it; forms send focus to an error summary on failure and show field errors next to fields; `next=` redirects are limited to paths inside `/app`.

## Animated journey overview (home page, 2026-11-22)
Above the five numbered steps, `JourneyPlayer` (`apps/web/src/components/journey-player.tsx`) shows the whole path at a glance: five stops on a track, a marker that moves from stop to stop, and a card saying who is involved and what each does. It repeats the numbered story below it, from the same data, so it is a quick way in, never the only place something is said. Rules: plays only while on screen and never for people who ask for reduced motion; pressing a step takes over and stops it; a pause/play button is always available; the stops are real buttons; the track is decorative; no meaning by colour alone (involvement is also written); movement is transform only.

## Pictures: photographs, with drawn stand-ins (2026-11-22)
The founder asked for real pictures of people, families, mums and children, not drawings. **Photographs** cannot be created by the assistant. Nine free Pexels photographs, approved by the founder file by file, are in place (listed in `docs/PHOTOS.md`); the founder can replace any of them. Each place that carries a picture is a named slot (`family`, `mumAndChild`, `kids`, `community`, `celebrate`, `explore`, `stepIdea`, `stepMatch`, `stepBook`). Drop a photo with that name into `apps/web/public/photos/` and restart or rebuild: it replaces the drawing in every place that slot is used. `docs/PHOTOS.md` lists each slot, its shape, its size and where it appears. Until a photo arrives the page shows a drawn stand-in (set `NEXT_PUBLIC_ARTWORK_FALLBACK=none` to show nothing instead).
**Permission.** Pictures of people, and above all of children, need written permission from the people pictured (from a guardian for a child) or a licence that includes a model release. Every photo needs a record in `apps/web/photo-credits.json` (source, licence, how permission was obtained; kept outside the public folder because everything in `public/` is served to visitors) and a test fails without one.
**Where pictures are placed:** the home page (top picture, one for each "how it works" step, a neighbourhood picture), sign in and register (beside the form on wide screens only), the confirmed-email page, the signed-in Home (welcome picture on wide screens, community picture when you have no community yet), and the empty states of requests, the catalog, My family, Join a community and the not-found page. **Not placed, on purpose:** safety and reporting, concerns, payments, the operations queue, security and audit screens.
**Rules for any picture.** Decorative: it sits beside text that says the same thing, has an empty description and is hidden from screen readers. Photos are cropped to a set shape (so the page does not jump and every photo fills it) and kept under 400 KB. The drawn stand-ins (`Illustration`, `packages/ui/src/illustrations.tsx`) are made-up characters; their colours come only from the `--k-art-*` tokens, they use no ids, and every computed coordinate is rounded (the server and the browser disagree in the last digits of trigonometry, which React reports as a hydration mismatch; a test enforces it).

## Design system v0 (Phase 2)
Tokens: color (light/dark, semantic roles for status), typography scale, spacing, radius, elevation, motion durations. Components: button, input, select, textarea, checkbox, radio, switch, date and time pickers, file upload with progress, form field with error, card, table with sorting and pagination, modal, drawer, toast, dropdown, tabs, breadcrumbs, filter bar, status badge, timeline, calendar, empty/loading/error/success states, skeletons. Seasonal themes are token overrides (post-pilot).

## States and feedback
Every data view has loading (skeleton), empty (explain and offer action), error (retry, support link) and success states. Destructive actions ask for confirmation with plain language. Long operations show progress.

## Motion
Subtle transitions (150 to 250 ms), page and card transitions, skeletons, success confirmations. `prefers-reduced-motion` disables non-essential motion. No animation blocks input.

## Accessibility checklist (per feature)
Semantic landmarks and headings; labelled controls; error messages tied to fields and announced; focus management on modals and route changes; full keyboard operation; contrast 4.5:1 text, 3:1 UI; target size at least 24 px (44 px primary mobile targets); zoom to 400% without horizontal scroll; alt text for informative images; axe checks in CI plus manual keyboard and screen-reader smoke test.

## Content and tone
Plain language, short sentences, no jargon; reassure on safety (what vetting means); localize-ready strings (no hardcoded text in components); currency and dates formatted by locale.
