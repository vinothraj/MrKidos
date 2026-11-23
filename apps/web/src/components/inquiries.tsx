"use client";

import { Alert, Badge, Button, Card, EmptyState, SelectField, Skeleton, TableWrap, TextField, type BadgeTone } from "@kidos/ui";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import { useSession } from "@/lib/session";
import { useLoad } from "@/lib/use-load";
import type { Review } from "./reviews";
import { Rating } from "./reviews";
import { BOOKING_STATUS, PaymentSummary, QuoteBreakdown, QuoteForm, rupees, type Booking, type Quote } from "./sourcing";

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : "—");

const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  sent: { label: "Needs your answer", tone: "warning" },
  quoted: { label: "You quoted", tone: "success" },
  declined: { label: "You declined", tone: "neutral" },
  withdrawn: { label: "No longer needed", tone: "neutral" },
};

/* -------------------------------------------------------------------- list */

interface Row {
  id: string;
  status: string;
  sentAt: string;
  respondedAt: string | null;
  quoteStatus: string | null;
  title: string;
  preferredDate: string | null;
  participantCount: number | null;
  community: string;
}

function InquiryTable({ status }: { status: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    api<{ data: Row[] }>(`/inquiries${status ? `?status=${status}` : ""}`).then(
      (r) => active && setRows(r.data),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [status]);

  if (failed) return <Alert variant="danger">We could not load your inquiries. Please try again.</Alert>;
  if (rows === null) return <Skeleton height="4rem" />;
  if (rows.length === 0) return <EmptyState title="Nothing here">When the team asks you to quote for a family&rsquo;s request, it appears here.</EmptyState>;
  return (
    <TableWrap label="Inquiries">
      <table className="k-table" aria-label="Inquiries">
        <thead>
          <tr>
            <th scope="col">Request</th>
            <th scope="col">Community</th>
            <th scope="col">When</th>
            <th scope="col">Status</th>
            <th scope="col">Received</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const st = r.quoteStatus === "accepted" ? { label: "Chosen by the family", tone: "success" as BadgeTone } : (STATUS[r.status] ?? { label: r.status, tone: "neutral" as BadgeTone });
            return (
              <tr key={r.id}>
                <td>
                  <Link href={`/app/inquiries/${r.id}`}>{r.title}</Link>
                  {r.participantCount !== null && <div className="k-muted">{r.participantCount} children</div>}
                </td>
                <td>{r.community}</td>
                <td>{r.preferredDate ?? "Flexible"}</td>
                <td>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </td>
                <td>{when(r.sentAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}

export function InquiriesList() {
  const { me, can } = useSession();
  const [status, setStatus] = useState("");
  const vendor = !me.platformScope && me.tenants.find((t) => t.id === me.activeTenantId && t.type === "vendor");
  if (!vendor || !can("inquiries.respond")) {
    return (
      <div className="k-stack">
        <h1>Inquiries</h1>
        <Alert variant="info" title="This is the vendor's inbox">
          Select the vendor you work for from the menu at the top to see the requests it has been asked to quote for.
        </Alert>
      </div>
    );
  }
  return (
    <div className="k-stack k-stack-lg">
      <div>
        <h1>Inquiries</h1>
        <p className="k-muted">Requests the team has asked {vendor.name} to quote for. You see what is needed to quote, never who asked.</p>
      </div>
      <div style={{ maxWidth: "16rem" }}>
        <SelectField label="Show" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Everything</option>
          <option value="sent">Needs your answer</option>
          <option value="quoted">You quoted</option>
          <option value="declined">You declined</option>
          <option value="withdrawn">No longer needed</option>
        </SelectField>
      </div>
      <InquiryTable key={status} status={status} />
    </div>
  );
}

/* ------------------------------------------------------------------ detail */

interface Snapshot {
  title: string;
  description: string | null;
  category: string | null;
  preferredDate: string | null;
  flexibleDates: boolean;
  participantCount: number | null;
  ageMin: number | null;
  ageMax: number | null;
  budgetMaxMinor: number | null;
  venueText: string | null;
  community: { name: string; locality: string | null; city: string | null };
  answers: { label: string; value: string }[];
}
interface InquiryDetailData {
  id: string;
  status: string;
  message: string | null;
  request: Snapshot;
  sentAt: string;
  respondedAt: string | null;
  declineReason: string | null;
  quotes: (Quote & { createdAt: string })[];
  booking: Booking | null;
  review: Review | null;
}

function Decline({ id, onDone }: { id: string; onDone: () => void }) {
  const submit = useSubmit();
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  async function go() {
    const res = await submit.run(() => api(`/inquiries/${id}/decline`, { method: "POST", body: { reason: reason.trim() } }));
    if (res) onDone();
  }
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        I cannot do this
      </Button>
    );
  }
  return (
    <div className="k-stack" role="group" aria-label="Decline this request">
      <ErrorSummary submit={submit} />
      <TextField label="Why not?" hint="The team reads this. Keep it short." value={reason} onChange={(e) => setReason(e.target.value)} error={submit.error?.fields["reason"]} />
      <div className="k-row">
        <Button loading={submit.submitting} disabled={reason.trim().length < 3} onClick={() => void go()}>
          Send my answer
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function BookingCard({ booking, onChanged }: { booking: Booking; onChanged: () => void }) {
  const submit = useSubmit();
  const [reason, setReason] = useState("");
  const [declining, setDeclining] = useState(false);
  const st = BOOKING_STATUS[booking.status];
  async function confirm() {
    const res = await submit.run(() => api(`/bookings/${booking.id}/vendor-confirm`, { method: "POST" }));
    if (res) onChanged();
  }
  async function decline() {
    const res = await submit.run(() => api(`/bookings/${booking.id}/vendor-decline`, { method: "POST", body: { reason: reason.trim() } }));
    if (res) onChanged();
  }
  return (
    <Card>
      <h2>Booking</h2>
      <p>
        <Badge tone={st.tone}>{st.label}</Badge> The family chose your quote of {rupees(booking.agreedTotalMinor)}.
      </p>
      <p className="k-muted">{booking.scheduledStart ? `${when(booking.scheduledStart)} to ${when(booking.scheduledEnd)}${booking.venueText ? ` · ${booking.venueText}` : ""}` : "The team is setting the date and place. You will be able to confirm once it is set."}</p>
      <PaymentSummary booking={booking} showFee />
      {booking.status === "pending_vendor" && (
        <div className="k-stack">
          <ErrorSummary submit={submit} />
          {booking.vendorConfirmedAt ? (
            <p>You confirmed this date. The team will confirm the booking.</p>
          ) : booking.scheduledStart ? (
            <div className="k-row">
              <Button loading={submit.submitting} onClick={() => void confirm()}>
                Confirm this date
              </Button>
              {!declining && (
                <Button variant="secondary" onClick={() => setDeclining(true)}>
                  I cannot do this date
                </Button>
              )}
            </div>
          ) : null}
          {declining && (
            <div className="k-stack" role="group" aria-label="Decline this booking">
              <TextField label="Why can you not do it?" value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="k-row">
                <Button loading={submit.submitting} disabled={reason.trim().length < 3} onClick={() => void decline()}>
                  Decline the booking
                </Button>
                <Button variant="ghost" onClick={() => setDeclining(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export function InquiryDetail({ id }: { id: string }) {
  const loader = useCallback(() => api<InquiryDetailData>(`/inquiries/${id}`), [id]);
  const { state, reload } = useLoad(loader);
  const submit = useSubmit();

  if (state.status === "loading") return <Skeleton height="8rem" />;
  if (state.status === "error") {
    const notFound = state.error instanceof ApiError && (state.error.status === 404 || state.error.status === 403);
    return (
      <Alert variant="danger" title={notFound ? "Inquiry not found" : "We could not load this inquiry"}>
        {notFound ? "It may not exist, or it may belong to another vendor." : "Please try again in a moment."}
      </Alert>
    );
  }
  const d = state.data;
  const r = d.request;
  const live = d.quotes.find((q) => q.status !== "withdrawn" && q.status !== "rejected");
  const st = STATUS[d.status] ?? { label: d.status, tone: "neutral" as BadgeTone };

  async function withdraw(quoteId: string) {
    const res = await submit.run(() => api(`/quotes/${quoteId}/withdraw`, { method: "POST" }));
    if (res) reload();
  }
  const facts: [string, string][] = [];
  facts.push(["Community", [r.community.name, r.community.locality, r.community.city].filter(Boolean).join(", ")]);
  if (r.category) facts.push(["Category", r.category]);
  facts.push(["When", r.preferredDate ? `${r.preferredDate}${r.flexibleDates ? " (flexible)" : ""}` : r.flexibleDates ? "Flexible" : "Not fixed yet"]);
  if (r.participantCount !== null) facts.push(["Children", String(r.participantCount)]);
  if (r.ageMin !== null || r.ageMax !== null) facts.push(["Ages", `${r.ageMin ?? 0} to ${r.ageMax ?? "any"}`]);
  if (r.budgetMaxMinor !== null) facts.push(["Budget up to", rupees(r.budgetMaxMinor)]);
  if (r.venueText) facts.push(["Where", r.venueText]);
  for (const a of r.answers) facts.push([a.label, a.value]);

  return (
    <div className="k-stack k-stack-lg">
      <div>
        <p>
          <Link href="/app/inquiries">Back to inquiries</Link>
        </p>
        <div className="k-row">
          <h1 style={{ margin: 0 }}>{r.title}</h1>
          <Badge tone={st.tone}>{st.label}</Badge>
        </div>
        <p className="k-muted">Received {when(d.sentAt)}</p>
      </div>

      <Card>
        <h2>What is needed</h2>
        {r.description && <p style={{ whiteSpace: "pre-wrap" }}>{r.description}</p>}
        <dl className="k-stack k-stack-sm" style={{ margin: 0 }}>
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt className="k-muted">{k}</dt>
              <dd style={{ margin: 0 }}>{v}</dd>
            </div>
          ))}
        </dl>
        {d.message && (
          <Alert variant="info" title="A message from the team">
            {d.message}
          </Alert>
        )}
      </Card>

      {d.status === "sent" && (
        <Card>
          <h2>Your quote</h2>
          <QuoteForm inquiryId={d.id} onDone={reload} />
          <div style={{ marginTop: "var(--k-space-4)" }}>
            <Decline id={d.id} onDone={reload} />
          </div>
        </Card>
      )}

      {d.status === "declined" && d.declineReason && (
        <Alert variant="info" title="You declined this request">
          {d.declineReason}
        </Alert>
      )}
      {d.status === "withdrawn" && <Alert variant="info" title="This request is no longer waiting for you">The team has withdrawn it or it has been decided.</Alert>}

      {d.status === "quoted" && live && (
        <Card>
          <h2>Your quote</h2>
          <ErrorSummary submit={submit} />
          <QuoteBreakdown quote={live} />
          <p>
            <Badge tone={live.status === "accepted" ? "success" : live.status === "shortlisted" ? "success" : "info"}>
              {live.status === "accepted" ? "Chosen by the family" : live.status === "shortlisted" ? "Offered to the family" : "Sent to the team"}
            </Badge>
          </p>
          {live.status === "submitted" && (
            <div>
              <Button variant="secondary" loading={submit.submitting} onClick={() => void withdraw(live.id)}>
                Withdraw this quote to correct it
              </Button>
            </div>
          )}
        </Card>
      )}
      {d.status === "quoted" && !live && (
        <Card>
          <h2>Send a corrected quote</h2>
          <p className="k-muted">Your earlier quote was withdrawn.</p>
          <QuoteForm inquiryId={d.id} onDone={reload} />
        </Card>
      )}

      {d.booking && <BookingCard booking={d.booking} onChanged={reload} />}
      {d.review && (
        <Card>
          <h2>A review of this booking</h2>
          <p>
            <Rating value={d.review.rating} />
          </p>
          {d.review.body && <p style={{ whiteSpace: "pre-wrap" }}>{d.review.body}</p>}
          {d.review.reply ? <p><strong>Your reply:</strong> {d.review.reply}</p> : <p className="k-muted">You can reply on the <Link href="/app/reviews">Reviews page</Link>.</p>}
        </Card>
      )}
    </div>
  );
}
