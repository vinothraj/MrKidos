# ADR 0005: Curated palettes instead of free colour choice

Date: 2026-11-23. Status: accepted (founder's polish brief).

## Context
The founder asked for an admin-configurable theme. Letting an administrator type any colour would break the
accessibility promise (WCAG AA contrast in light and dark) the moment someone picks a pale brand colour, and the
axe scans could not catch every combination.

## Decision
- A small closed list of palettes (Classic, Ocean, Forest) defined as tokens in `packages/ui/src/styles.css`, each with a
  light and a dark variant. `tokens.test.ts` checks every text and control pair in every palette in both themes.
- The database stores only the palette's name (`user_preferences.palette`, `community_branding.palette`), with a CHECK
  constraint listing the same names. No colour value is ever stored or accepted.
- Precedence: the person's own palette, else the community's, else Classic. Light, dark or device is per person.
- A copy of the choice is kept in the browser's local storage only to paint before the account loads; the server copy
  always wins. It contains two words, nothing personal.

## Consequences
Adding a palette = tokens (light and dark), the contrast test, a new migration widening both CHECK constraints, and
the lists in `apps/web/src/lib/theme.ts` and the two route schemas.
