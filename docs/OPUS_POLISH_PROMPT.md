# Opus polish prompt (paste into a new session)

```
Read CLAUDE.md, MASTER_PROMPT.md and docs/DEVELOPMENT_PROGRESS.md first. Follow every rule in CLAUDE.md. Do not break anything: after each milestone run typecheck, eslint, vitest and the e2e suite (axe in light and dark), and fix regressions before moving on. Never edit an applied migration. Report anything unfinished as "Partially Completed", honestly.

GOAL: turn the whole app into a premium, enterprise-grade product: polished, smooth, calm, and obvious to a first-time user. Work in the milestones below, in order. Finish and verify each before starting the next. I have limited time, so do the highest-impact work first and keep a running checklist in docs/DEVELOPMENT_PROGRESS.md.

1. THEME AND DESIGN SYSTEM (packages/ui, tokens only)
- Classic, premium look: refined typography scale, consistent spacing, elevation, radius, subtle motion (respect reduced motion), focus rings, skeleton loaders, empty states, toasts, confirm dialogs.
- Admin-configurable theme: light / dark / system, plus a small set of curated brand presets (for example Classic, Ocean, Forest) and an accent colour choice per community. Colours come only from tokens; the WCAG contrast test must stay green for every preset in light and dark.
- Store the choice per user and per community as data. Do not hard-code it.

2. GUIDED FORMS (step by step)
- Any long form becomes a wizard: "Step 1 of 3" progress bar, one topic per step, Back / Next / Save draft, validation per step, a final Review screen before submit, and drafts that survive a refresh. Start with: community onboarding, vendor onboarding, family profile, offering creation, request creation.
- Each field has a clear label, helper text, and a small "?" tooltip explaining why we ask and who can see it. Errors say what to do next, in plain words. Required vs optional is always visible (not by colour alone).

3. ADMIN CONFIGURATION CENTRE
- One clear Settings area for community admins and platform staff, grouped into: Profile and branding, Members and roles, Security (two-step verification policy, session length, password rules, invite code rules), Privacy and consent text, Notifications, Vendors and approvals, Facilities and policies, Data export and erasure.
- Every setting has a description, a safe default, a tooltip, a "last changed by / when" line (audit), and a confirm step for risky changes. All settings are data, enforced server-side, permission-checked with requirePermission, tenant-scoped through withContext and dbContext(state). Add tests, including tenant isolation and permission denial. Extend the mutation checks in docs/TEST_PLAN.md for the security settings.

4. CLEAR FLOWS AND GUIDANCE
- For the main journeys (join a community, find an experience, send a request, compare quotes, book, review, report a concern; vendor: onboard, get approved, answer inquiries; admin: approve, configure), add: a short "What happens next" note on every step, a first-run checklist on dashboards, contextual help links, breadcrumbs, and clear success and error screens that say the next action.
- Reduce clicks: sensible defaults, inline editing where safe, keyboard shortcuts for staff queues, and a global search or command menu if cheap.
- No dead ends: every empty list explains what it is and offers the next action.

5. PICTURES
- Follow the picture rules in CLAUDE.md exactly: real photos only from the founder's files in apps/web/public/photos/ with credit records; otherwise use the drawn Illustration stand-ins with --k-art-* tokens. Never invent photos of people, never download a photo without my approval of that exact file. Pictures are decorative (aria-hidden) and never on safety, concerns, payments or ops screens. Use them on landing, empty states, onboarding steps and category tiles.

6. SECURITY AND TRUST UX
- Make security visible and understandable: a Security page showing two-step status, active sessions with "sign out everywhere", recent sign-in activity, and an audit trail view with filters. Add password strength guidance, rate-limit messages that explain, and clear consent screens for child data. No secrets in logs, audit metadata or error messages.

7. QUALITY BAR
- Every page passes the axe scans in light and dark; all interactive elements have accessible names; works on mobile widths; no layout shift; fast (run check:load after any list or policy change).
- Update docs (product, security, API, ADR for the theme and settings decisions) and the progress file. Finish with a short report: what is Completed, what is Partially Completed and why, what I (the founder) must supply (photos, email provider, legal review).

Before coding, give me a one-screen plan with the order and what you will skip if time runs short. Then begin, and do not stop to ask unless a decision is truly mine.
```

Tips: start the session on Opus 5.5 with auto/accept-edits mode so it does not pause for prompts; run it in parallel sessions only if they touch different files.
