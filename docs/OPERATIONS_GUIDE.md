# Operations Desk Guide: how to work the queue

For the person (or small team) who runs the desk: looks at every request, finds and asks vendors, books, records offline payments, checks reviews, onboards vendors and decides safety reports. Written from the screens and rules as built (checked against the code on 2026-11-22). Nothing here has been used by a real person yet: the first rehearsal (`LAUNCH_READINESS.md` section 4) should correct this guide wherever it is wrong.

Words in **bold** are what you will see on screen.

## 1. Before your first day
- You need a platform role. **Business Operations** covers everything in this guide except reading the **Audit log** (platform administrators and super administrators only). **Customer Support** can decide concerns. Every platform role requires two-step sign-in (an authenticator app), so enrol at first sign-in and keep your recovery codes somewhere safe.
- After signing in, press **Platform mode** at the top (it stays pressed while you are working for the whole platform). Without it you are acting inside one community and the queue is not shown.
- **Home** shows **Waiting for you**: what needs a person right now (overdue requests, requests nobody owns, bookings ready to confirm, bookings without a full payment recorded, reviews to check, safety reports, vendors with lapsed documents). Start there.
- Email: the shared desk mailbox (`OPS_ALERT_EMAIL`) is told when something needs you. The emails never contain names, prices or what a family wrote; they say what happened and link to the screen. Do not forward them with private details added.

## 2. The daily round (in this order)
1. **Concerns** (menu, platform mode). Read every child-safety report first. If a child may be at risk, suspend the vendor first (section 7), then look into it. Target in `LAUNCH_READINESS.md` 5.1: a child-safety report the same day.
2. **Request queue**, tiles at the top: **Overdue** (past its target), **Due within 4 hours**, **Unassigned**, **Assigned to me**. Work Overdue, then Due within 4 hours, then take Unassigned ones (**Take it** on the request puts your name on it; **Unassign** hands it back).
3. **Reviews**: **Publish** or **Do not publish** (section 8).
4. **Vendors**: lapsed documents (Home says how many).
5. **Bookings and money**: bookings ready to confirm, and anything without a full payment recorded (section 6).

A request waiting for the family (**We need more information**, **Shortlisted**) is the family's clock, not yours: it is not counted as overdue. The queue says how many are waiting for a family.

## 3. A request from start to finish
The buttons you see are decided by the request's step and your permissions; you cannot skip a step. Targets are how long a request may sit in that step (always counted around the clock, including nights and weekends).

| Step the request is in | Target | What you do | Rules to know |
|---|---|---|---|
| **Submitted** | 24 h | **Start review**, or **Cannot take this on** | Declining needs a note the family will read. |
| **Under review** | 48 h | **Approve**; or **Ask for more information**; or **Cannot take this on** | Asking and declining need a note. The family's reply puts it back in review. |
| **We need more information** | 120 h (family's clock) | Wait; **Back to review** if you no longer need the answer | |
| **Approved** | none set | **Start finding vendors** (or **Close without a booking**, with a note) | |
| **Finding options** | 72 h | **Find matching vendors**, tick the right ones, write an optional message, **Ask N selected vendors** | The score and the reasons beside each vendor are a guide, not a rule. Only vendors a family in that community could be offered appear. To add one yourself, use **Add a vendor yourself**; it needs a reason (**Why add them?**), which is recorded. Asking moves the request to **Asking vendors** by itself. Vendors see the request details and your message, never who asked. |
| **Asking vendors** | 96 h | Wait for quotes. If a vendor gave a quote outside the app, **Enter a quote they gave us**. Then **Quotes are in** | Needs at least one quote. A vendor can decline; you can ask others. |
| **Quotes received** | 24 h | **Compare quotes**; **Shortlist** the ones to offer (**Take off the list** to undo); **Offer these options to the family**; or **Ask more vendors** | Offering needs at least one shortlisted quote. Once offered, vendors can no longer quote. |
| **Shortlisted** | 120 h (family's clock) | Wait for the family. **Change the options** if needed | Only the family can accept (**Choose this option**). That moves it to **Booking pending**. |
| **Booking pending** | 48 h | **Save date and place** (**Set the date and place**); then the vendor confirms; then **Confirm the booking** | Confirming is refused until the vendor has confirmed. Changing the time asks the vendor to confirm again. You can **Start again with other vendors** or **Close without a booking**, each with a note. |
| **Confirmed** | none | After it happens: **Mark as completed**. Record payments (section 6) | **Cancel the booking** needs a note. |
| **Completed** | | The family is reminded to review; you check the review (section 8) | |

Notes:
- **Note for this step** is read by the family and their community's administrators. Anything private goes in an **Internal note** (tick **Internal note (only the team can see it)** when writing a message, or use **Add internal note**). Never put a child's full name, a phone number or a safety detail in a note for the step.
- The step **Waiting for community approval** exists but is not used yet: a community cannot yet require its administrator to approve each booking (decision B5 in `LAUNCH_READINESS.md`).
- Search the queue by title or number (**Search by title or number**); **Show** filters by view (Open, Overdue, Due within 4 hours, Unassigned, Assigned to me, Finished, Everything).

## 4. Matching: what the score means
Out of 100, fixed weights: category 40, children's ages 15, group size 10, budget 15, availability 10, experience 5. Every suggestion shows its reasons (for example "+15 ages fit"). Do not trust a high score blindly: check the vendor's page and its reviews. Every manual addition is logged with its reason; review these weekly (`LAUNCH_READINESS.md`, B2).

## 5. Onboarding a vendor
1. **Vendors** (platform mode) then **Register vendor**.
2. Fill in the profile. Moving to verification needs: a description, country, state, city, a contact person, a contact email or phone, at least one category, and at least one place served (a community or a city). The screen lists what is missing.
3. The vendor's people add documents. You verify them (identity proof, background check and a child-safety briefing are required by default; see decision B3). Going **active** is refused until every required document is verified and not expired, and it needs a note.
4. A community must also **Approve** the vendor before its families see it (the community administrator does this under **Community vendors**; **Do not approve** and **Withdraw approval** also exist). Keep this on for the pilot.
5. Vendor owners must use two-step sign-in.
6. To remove a vendor from families at once: **suspend** it (needs a written note). Reinstating also needs a note.

## 6. Money (offline payments only)
The platform records payments made outside it; it does not move money. On a confirmed or completed booking:
- **Platform fee**: enter the fee in rupees and **Save the fee**. Set it before recording a fee payment.
- **Record the payment**: **Who paid whom** (**The family paid the vendor** or **The vendor paid the platform fee**), the amount, how, the date (not in the future), and an optional reference (a UPI or receipt number).
- A payment cannot be larger than what is still owed. Records are append-only: there is no editing or deleting, and no reversal yet (a mistake is a known gap; write it as a note and tell the founder).
- The family never sees the fee. The vendor sees the fee and its own payments.

## 7. Concerns (safety and conduct reports)
Reports go only to you: never to the vendor, the community or other families. **Start looking** takes one on. **Mark resolved** and **Close without action** both need words for the reporter (**Outcome for the reporter**): write what happened or what happens next, in plain words, without blame and without internal findings. Put findings in the vendor's internal notes. The queue shows how long each has waited; a child-safety report waiting a day or more is marked **Waiting over a day**. Nothing escalates by itself: if you are away, someone else must be named. Process and open questions: `LAUNCH_READINESS.md` section 5.1.

## 8. Reviews
Only you publish reviews. **Publish** or **Do not publish**. Not publishing needs a note (**Note for** the review) and **the author reads it**, so write it kindly and without blame. A published review shows its star rating and text without the family's name; the vendor may reply once. Do not publish a review that names a child, contains contact details, or is clearly about something else (that is what a report is for).

## 9. When something looks wrong
- **Audit log** (platform administrators): who did what and when, newest first.
- A request stuck in a step: the buttons shown are the only moves allowed; if the one you need is missing, you lack the permission or the rule is not met (the screen says which, for example "Ask at least one vendor first").
- A family cannot sign in or a vendor cannot see something: do not change the database by hand. Note it and tell the founder; most such cases are a missing approval, a lapsed document or an unverified email.
- Never promise a family a specific vendor, price or date before the vendor has confirmed it in the app.

## 10. What this guide cannot tell you yet
Real response times, which targets you can keep, who covers nights and weekends, what a family needs to hear when a request is declined, and how often vendors decline. Write these down during the rehearsal and the first weeks, then change the targets (decision B1) rather than missing them.
