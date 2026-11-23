# Metrics Dictionary (pilot)

Each metric has exactly one definition. Dashboards and AI insights must use these.

| Metric | Definition | Source | Pilot target |
|---|---|---|---|
| Requests submitted | Count of requests that reached Submitted in period | status_history | track |
| Request rate | Requests submitted per 100 verified households per month | requests, memberships | 3+ (hypothesis) |
| Time to first response | Submitted to first resident-visible ops update (business hours) | status_history, comments | under 4 h |
| Sourcing time | Approved to Quotes Received | status_history | under 3 days |
| Vendor response rate | Inquiries answered (any answer) within 24 h / inquiries sent | inquiries | 70% |
| Quote coverage | Requests with 2+ quotes / requests reaching Sourcing | quotes | 70% |
| Booking conversion | Confirmed / Approved requests | status_history | 40% |
| Completion rate | Completed / Confirmed | bookings | 90% |
| Cancellation rate | Cancelled after Confirmed / Confirmed | bookings | under 10% |
| Repeat resident | Residents with 2+ confirmed bookings / residents with 1+ | bookings | track |
| Review rate | Reviews / Completed bookings | reviews | 40% |
| Average rating | Mean rating of approved reviews | reviews | 4.3+ |
| Gross booking value (GBV) | Sum of confirmed booking totals (before platform fee) | bookings | track |
| Platform fee revenue | Sum of recorded platform fees on completed bookings | ledger | track |
| Active vendors | Vendors with 1+ response or booking in last 60 days | inquiries, bookings | track |
| SLA breach rate | Requests exceeding a status SLA / requests | sla records | under 15% |

Rules: business hours are configurable per platform; period boundaries use the platform time zone; test and demo data are excluded via a flag.
