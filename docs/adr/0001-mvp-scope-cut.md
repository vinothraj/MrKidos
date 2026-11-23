# ADR 0001: Cut MVP scope to fit a 6-month pilot

Status: Accepted (founder, 2026-11-21)

## Context
The Phase 0 estimate for Phases 2 to 6 was 22 to 30 weeks with a solo founder plus Claude. The pilot target is 6 months (about 26 weeks).

## Decision
Keep the Phase 2 to 6 sequence but reduce the MVP as follows:
1. **Vendors are entered and onboarded by Operations.** Vendors get logins only to view inquiries, submit quotes, confirm bookings and edit limited profile fields. A self-serve onboarding wizard is post-pilot.
2. **The offering catalog is read-only for residents**, populated by Operations and vendor staff. Resident self-serve instant booking is out; every booking goes through a request.
3. **The workflow is a single seeded default** stored as data (statuses, transitions, permissions, SLAs). Editing is through seed/config files and migrations, not an admin UI. A workflow admin UI is post-pilot.
4. **Request forms per category are seeded JSON schemas** with a minimal admin editor deferred.
5. **Configuration UI is limited** to categories, communities and roles assignment. Other configuration lives in versioned config files.

## Consequences
- Fits the 6-month target with buffer for review latency.
- The data model stays generic (tables for workflows, forms, rules) so post-pilot admin UIs need no redesign.
- Ops staff carry more manual work during the pilot; ops tooling gets design priority.

## Assumptions recorded for undecided items (founder to confirm)
- B Payments: resident pays vendor directly; platform fee is invoiced to the vendor offline. The ledger still records amounts and statuses.
- C Name: "Kidos" is a working name read from one config value.
- D Ops desk: the founder operates it during the pilot.
- E Rentals: after the request-to-booking loop is proven.
- F Legal: consultation to be booked in parallel with Phases 2 to 4.
