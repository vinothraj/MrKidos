"use client";

import { Alert, Badge, Button, Card, CheckboxField, EmptyState, SelectField, Skeleton, TableWrap, TextAreaField, TextField, type BadgeTone } from "@kidos/ui";
import { useCallback, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import { useLoad } from "@/lib/use-load";

export const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : "—");

/* ------------------------------------------------------------------- types */

export interface QuoteLine {
  kind: string;
  description: string;
  quantity: number;
  unitMinor: number;
}
export interface Quote {
  id: string;
  vendorId: string;
  vendorName: string | null;
  inquiryId: string;
  status: string;
  totalMinor: number;
  currency: string;
  validUntil: string | null;
  notes: string | null;
  lines: QuoteLine[];
}
export interface Booking {
  id: string;
  status: "pending_vendor" | "confirmed" | "completed" | "cancelled";
  vendorId: string;
  vendorName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  venueText: string | null;
  agreedTotalMinor: number;
  vendorConfirmedAt: string | null;
  confirmedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  payments: Payment[];
  paidMinor: number;
  balanceMinor: number;
  paymentStatus: "unpaid" | "partial" | "paid";
  /** For the team and the vendor only. */
  platformFeeMinor?: number | null;
  feePaidMinor?: number;
}
export interface Payment {
  id: string;
  kind: string;
  amountMinor: number;
  method: string;
  reference: string | null;
  paidOn: string;
  note: string | null;
}

export const BOOKING_STATUS: Record<Booking["status"], { label: string; tone: BadgeTone }> = {
  pending_vendor: { label: "Waiting for the vendor", tone: "warning" },
  confirmed: { label: "Confirmed", tone: "success" },
  completed: { label: "Completed", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

const METHOD: Record<string, string> = { cash: "Cash", upi: "UPI", bank_transfer: "Bank transfer", card_offline: "Card (paid directly)", other: "Other" };
const PAYMENT_STATUS: Record<Booking["paymentStatus"], { label: string; tone: BadgeTone }> = {
  unpaid: { label: "Not paid yet", tone: "warning" },
  partial: { label: "Part paid", tone: "info" },
  paid: { label: "Paid in full", tone: "success" },
};

/** What has been paid, read-only. Shown to the family (what they paid), the vendor (also its fee) and the team. */
export function PaymentSummary({ booking, showFee }: { booking: Booking; showFee: boolean }) {
  const st = PAYMENT_STATUS[booking.paymentStatus];
  if (booking.status !== "confirmed" && booking.status !== "completed") return null;
  return (
    <div className="k-stack k-stack-sm">
      <p style={{ margin: 0 }}>
        <strong>Payment</strong> <Badge tone={st.tone}>{st.label}</Badge> {rupees(booking.paidMinor)} of {rupees(booking.agreedTotalMinor)}
        {booking.balanceMinor > 0 ? `, ${rupees(booking.balanceMinor)} still to pay the vendor` : ""}
      </p>
      {booking.payments.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: "var(--k-space-5)" }}>
          {booking.payments.map((p) => (
            <li key={p.id}>
              {rupees(p.amountMinor)} by {METHOD[p.method] ?? p.method} on {p.paidOn}
              {p.reference ? ` (${p.reference})` : ""}
            </li>
          ))}
        </ul>
      )}
      {showFee && booking.platformFeeMinor !== undefined && booking.platformFeeMinor !== null && (
        <p className="k-muted" style={{ margin: 0 }}>
          Platform fee {rupees(booking.platformFeeMinor)}; paid {rupees(booking.feePaidMinor ?? 0)}.
        </p>
      )}
    </div>
  );
}

/** Operations record money that moved offline, and set the platform fee. Nothing here moves money. */
function PaymentsEditor({ booking, onChanged }: { booking: Booking; onChanged: () => void }) {
  const pay = useSubmit();
  const fee = useSubmit();
  const [kind, setKind] = useState("family_to_vendor");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("upi");
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [feeInput, setFeeInput] = useState(booking.platformFeeMinor != null ? String(booking.platformFeeMinor / 100) : "");

  async function record(e: FormEvent) {
    e.preventDefault();
    const body = { kind, amountMinor: Math.round(Number(amount) * 100), method, paidOn, reference: reference.trim() || null };
    const res = await pay.run(() => api(`/bookings/${booking.id}/payments`, { method: "POST", body }));
    if (res) {
      setAmount("");
      setReference("");
      onChanged();
    }
  }
  async function saveFee(e: FormEvent) {
    e.preventDefault();
    const res = await fee.run(() => api(`/bookings/${booking.id}/fee`, { method: "PUT", body: { feeMinor: feeInput.trim() === "" ? null : Math.round(Number(feeInput) * 100) } }));
    if (res) onChanged();
  }
  return (
    <div className="k-stack k-stack-lg">
      <form onSubmit={saveFee} className="k-stack" noValidate aria-label="Platform fee">
        <ErrorSummary submit={fee} />
        <div className="k-grid">
          <TextField label="Platform fee in rupees" hint="What the vendor owes the platform for this booking." type="number" inputMode="decimal" min={0} step="0.01" value={feeInput} onChange={(e) => setFeeInput(e.target.value)} error={fee.error?.fields["feeMinor"]} />
        </div>
        <div>
          <Button type="submit" variant="secondary" size="sm" loading={fee.submitting}>
            Save the fee
          </Button>
        </div>
      </form>
      <form onSubmit={record} className="k-stack" noValidate aria-label="Record a payment">
        <ErrorSummary submit={pay} />
        <div className="k-grid">
          <SelectField label="Who paid whom" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="family_to_vendor">The family paid the vendor</option>
            <option value="vendor_to_platform">The vendor paid the platform fee</option>
          </SelectField>
          <TextField label="Amount in rupees" type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} error={pay.error?.fields["amountMinor"]} />
          <SelectField label="How" value={method} onChange={(e) => setMethod(e.target.value)}>
            {Object.entries(METHOD).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </SelectField>
          <TextField label="Paid on" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} error={pay.error?.fields["paidOn"]} />
          <TextField label="Reference (optional)" hint="A UPI or receipt number." value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        <div>
          <Button type="submit" loading={pay.submitting} disabled={amount.trim() === ""}>
            Record the payment
          </Button>
        </div>
      </form>
    </div>
  );
}

/** A quote's lines as a readable list, with the total. Used for the family, the vendor and the team. */
export function QuoteBreakdown({ quote }: { quote: Pick<Quote, "lines" | "totalMinor" | "validUntil" | "notes"> }) {
  return (
    <div>
      <ul style={{ margin: 0, paddingLeft: "var(--k-space-5)" }}>
        {quote.lines.map((l, i) => (
          <li key={`${l.description}-${i}`}>
            {l.description}
            {l.quantity > 1 ? ` × ${l.quantity}` : ""}: {rupees(l.quantity * l.unitMinor)}
          </li>
        ))}
      </ul>
      <p style={{ margin: "var(--k-space-2) 0 0" }}>
        <strong>Total {rupees(quote.totalMinor)}</strong>
        {quote.validUntil ? <span className="k-muted"> · valid until {quote.validUntil}</span> : null}
      </p>
      {quote.notes && <p className="k-muted" style={{ margin: 0 }}>{quote.notes}</p>}
    </div>
  );
}

/* -------------------------------------------------------------- quote form */

interface LineInput {
  description: string;
  quantity: string;
  price: string;
}
const emptyLine = (): LineInput => ({ description: "", quantity: "1", price: "" });

/** Used by a vendor answering an inquiry, and by operations capturing a quote they obtained by phone. */
export function QuoteForm({ inquiryId, onDone, label = "Send your quote" }: { inquiryId: string; onDone: () => void; label?: string }) {
  const submit = useSubmit();
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");
  const err = submit.error?.fields ?? {};
  const total = lines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * Math.round((Number(l.price) || 0) * 100), 0);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = {
      lines: lines.filter((l) => l.description.trim() !== "" || l.price.trim() !== "").map((l) => ({ description: l.description.trim(), quantity: Number(l.quantity) || 1, unitMinor: Math.round(Number(l.price) * 100) })),
      validUntil: validUntil || null,
      notes: notes.trim() || null,
    };
    const res = await submit.run(() => api(`/inquiries/${inquiryId}/quote`, { method: "POST", body }));
    if (res) onDone();
  }
  const set = (i: number, patch: Partial<LineInput>) => setLines((cur) => cur.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  return (
    <form onSubmit={onSubmit} className="k-stack" noValidate aria-label={label}>
      <ErrorSummary submit={submit} />
      {lines.map((l, i) => (
        <div key={i} className="k-grid">
          <TextField label={`Item ${i + 1}`} {...(i === 0 ? { hint: "For example: Coaching for 12 children" } : {})} value={l.description} onChange={(e) => set(i, { description: e.target.value })} error={err[`lines.${i}.description`]} />
          <TextField label={`Quantity ${i + 1}`} type="number" inputMode="numeric" min={1} value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} error={err[`lines.${i}.quantity`]} />
          <TextField label={`Price each in rupees ${i + 1}`} type="number" inputMode="decimal" min={0} step="0.01" value={l.price} onChange={(e) => set(i, { price: e.target.value })} error={err[`lines.${i}.unitMinor`]} />
        </div>
      ))}
      <div className="k-row">
        <Button variant="ghost" size="sm" onClick={() => setLines((cur) => [...cur, emptyLine()])} disabled={lines.length >= 20}>
          Add another item
        </Button>
        {lines.length > 1 && (
          <Button variant="ghost" size="sm" onClick={() => setLines((cur) => cur.slice(0, -1))}>
            Remove the last item
          </Button>
        )}
        <strong>Total {rupees(total)}</strong>
      </div>
      <div className="k-grid">
        <TextField label="Valid until (optional)" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} error={err["validUntil"]} />
      </div>
      <TextAreaField label="Notes (optional)" hint="What is included, travel, equipment, anything the family should know." rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} error={err["notes"]} />
      <div>
        <Button type="submit" loading={submit.submitting} disabled={lines.every((l) => l.description.trim() === "")}>
          {label}
        </Button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------- the ops workspace */

interface Match {
  vendorId: string;
  vendorName: string;
  offering: { id: string; name: string | null } | null;
  score: number;
  reasons: { points: number; text: string }[];
  source: string;
  manualReason: string | null;
  asked: boolean;
}
interface InquiryRow {
  id: string;
  vendorId: string;
  vendorName: string;
  status: string;
  message: string | null;
  sentAt: string;
  respondedAt: string | null;
  declineReason: string | null;
}
interface SourcingView {
  status: string;
  canMatch: boolean;
  matches: Match[];
  inquiries: InquiryRow[];
  quotes: Quote[];
  booking: Booking | null;
  cancelledBookings: (Booking & { cancelReason: string | null })[];
}

const INQUIRY_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  sent: { label: "Waiting for an answer", tone: "warning" },
  quoted: { label: "Quoted", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};
const QUOTE_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  submitted: { label: "Received", tone: "info" },
  shortlisted: { label: "Offered to the family", tone: "success" },
  accepted: { label: "Chosen by the family", tone: "success" },
  rejected: { label: "Not chosen", tone: "neutral" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

function MatchesPanel({ requestId, view, onChanged }: { requestId: string; view: SourcingView; onChanged: () => void }) {
  const run = useSubmit();
  const send = useSubmit();
  const manual = useSubmit();
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [reason, setReason] = useState("");
  const vendorsLoader = useCallback(() => api<{ data: { id: string; name: string }[] }>("/vendors?status=active&limit=100"), []);
  const vendors = useLoad(vendorsLoader);
  const listed = new Set(view.matches.map((m) => m.vendorId));

  async function runMatching() {
    const res = await run.run(() => api(`/requests/${requestId}/matching/run`, { method: "POST" }));
    if (res) onChanged();
  }
  async function ask(e: FormEvent) {
    e.preventDefault();
    const res = await send.run(() => api(`/requests/${requestId}/inquiries`, { method: "POST", body: { vendorIds: picked, ...(message.trim() ? { message: message.trim() } : {}) } }));
    if (res) {
      setPicked([]);
      setMessage("");
      onChanged();
    }
  }
  async function addManual(e: FormEvent) {
    e.preventDefault();
    const res = await manual.run(() => api(`/requests/${requestId}/matching/manual`, { method: "POST", body: { vendorId, reason: reason.trim() } }));
    if (res) {
      setVendorId("");
      setReason("");
      onChanged();
    }
  }

  return (
    <Card>
      <h2>Vendors to ask</h2>
      <p className="k-muted">Only vendors a family in this community could be offered appear here: active, serving the community, approved by it, with current documents. The score is a guide; every point is explained.</p>
      <ErrorSummary submit={run} />
      {view.canMatch && (
        <div>
          <Button variant="secondary" loading={run.submitting} onClick={() => void runMatching()}>
            {view.matches.length > 0 ? "Run matching again" : "Find matching vendors"}
          </Button>
        </div>
      )}
      {view.matches.length === 0 ? (
        <EmptyState title="No vendors suggested yet">{view.canMatch ? "Run matching to see which vendors fit this request." : "Matching is available while the request is at the stage of finding vendors."}</EmptyState>
      ) : (
        <form onSubmit={ask} className="k-stack" noValidate aria-label="Ask vendors">
          <ErrorSummary submit={send} />
          <TableWrap label="Suggested vendors">
            <table className="k-table" aria-label="Suggested vendors">
              <thead>
                <tr>
                  <th scope="col">Ask</th>
                  <th scope="col">Vendor</th>
                  <th scope="col">Score</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {view.matches.map((m) => (
                  <tr key={m.vendorId}>
                    <td>
                      {m.asked ? (
                        <Badge tone="info">Asked</Badge>
                      ) : (
                        <CheckboxField label={`Ask ${m.vendorName}`} checked={picked.includes(m.vendorId)} onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, m.vendorId] : cur.filter((x) => x !== m.vendorId)))} />
                      )}
                    </td>
                    <td>
                      <strong>{m.vendorName}</strong>
                      <div className="k-muted">{m.offering?.name ?? "No published offering"}</div>
                      {m.source === "manual" && <Badge tone="warning">Added by the team: {m.manualReason}</Badge>}
                    </td>
                    <td>{m.score} / 100</td>
                    <td>
                      <ul style={{ margin: 0, paddingLeft: "var(--k-space-4)" }}>
                        {m.reasons.map((r, i) => (
                          <li key={`${r.text}-${i}`}>
                            {r.points >= 0 ? `+${r.points}` : r.points} {r.text}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          {view.canMatch && (
            <>
              <TextAreaField label="Message for the vendors (optional)" hint="Vendors see the request details and this message, never who asked." rows={2} value={message} onChange={(e) => setMessage(e.target.value)} />
              <div>
                <Button type="submit" loading={send.submitting} disabled={picked.length === 0}>
                  Ask {picked.length > 0 ? `${picked.length} ` : ""}selected {picked.length === 1 ? "vendor" : "vendors"}
                </Button>
              </div>
            </>
          )}
        </form>
      )}
      {view.canMatch && (
        <form onSubmit={addManual} className="k-stack" noValidate aria-label="Add a vendor yourself" style={{ marginTop: "var(--k-space-5)" }}>
          <h3>Add a vendor yourself</h3>
          <ErrorSummary submit={manual} />
          <div className="k-grid">
            <SelectField label="Vendor" value={vendorId} onChange={(e) => setVendorId(e.target.value)} error={manual.error?.fields["vendorId"]}>
              <option value="">Choose a vendor</option>
              {vendors.state.status === "ready" &&
                vendors.state.data.data
                  .filter((v) => !listed.has(v.id))
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
            </SelectField>
            <TextField label="Why add them?" hint="Recorded with the request." value={reason} onChange={(e) => setReason(e.target.value)} error={manual.error?.fields["reason"]} />
          </div>
          <div>
            <Button type="submit" variant="secondary" loading={manual.submitting} disabled={vendorId === "" || reason.trim().length < 3}>
              Add vendor
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function InquiriesPanel({ view, onChanged }: { view: SourcingView; onChanged: () => void }) {
  const submit = useSubmit();
  const [capturing, setCapturing] = useState<string | null>(null);
  async function withdraw(id: string) {
    const res = await submit.run(() => api(`/inquiries/${id}/withdraw`, { method: "POST" }));
    if (res) onChanged();
  }
  if (view.inquiries.length === 0) return null;
  return (
    <Card>
      <h2>Inquiries</h2>
      <ErrorSummary submit={submit} />
      <ul className="k-stack k-stack-lg" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {view.inquiries.map((i) => {
          const st = INQUIRY_STATUS[i.status] ?? { label: i.status, tone: "neutral" as BadgeTone };
          return (
            <li key={i.id} className="k-stack k-stack-sm">
              <div className="k-row" style={{ justifyContent: "space-between" }}>
                <div>
                  <strong>{i.vendorName}</strong> <Badge tone={st.tone}>{st.label}</Badge>
                  <div className="k-muted">Asked {when(i.sentAt)}{i.respondedAt ? ` · answered ${when(i.respondedAt)}` : ""}</div>
                  {i.declineReason && <div>Reason: {i.declineReason}</div>}
                </div>
                {i.status === "sent" && (
                  <div className="k-row">
                    <Button size="sm" variant="secondary" onClick={() => setCapturing(capturing === i.id ? null : i.id)}>
                      Enter a quote they gave us<span className="k-sr-only"> for {i.vendorName}</span>
                    </Button>
                    <Button size="sm" variant="ghost" loading={submit.submitting} onClick={() => void withdraw(i.id)}>
                      Withdraw<span className="k-sr-only"> the inquiry to {i.vendorName}</span>
                    </Button>
                  </div>
                )}
              </div>
              {capturing === i.id && (
                <QuoteForm
                  inquiryId={i.id}
                  label={`Save the quote from ${i.vendorName}`}
                  onDone={() => {
                    setCapturing(null);
                    onChanged();
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function QuotesPanel({ view, onChanged }: { view: SourcingView; onChanged: () => void }) {
  const submit = useSubmit();
  const live = view.quotes.filter((q) => q.status !== "withdrawn");
  const comparing = view.status === "quotes_received";
  if (live.length === 0) return null;

  async function shortlist(id: string, shortlisted: boolean) {
    const res = await submit.run(() => api(`/quotes/${id}/shortlist`, { method: "PUT", body: { shortlisted } }));
    if (res) onChanged();
  }
  const cheapest = Math.min(...live.filter((q) => q.status !== "rejected").map((q) => q.totalMinor));
  return (
    <Card>
      <h2>Compare quotes</h2>
      <p className="k-muted">
        {comparing ? "Shortlist the quotes to offer the family, then use “Offer these options to the family” above." : "Shortlisting is available while the request is at the stage of comparing quotes."}
      </p>
      <ErrorSummary submit={submit} />
      <TableWrap label="Quotes">
        <table className="k-table" aria-label="Quotes">
          <thead>
            <tr>
              <th scope="col">Vendor</th>
              <th scope="col">What is included</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="k-sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {live.map((q) => {
              const st = QUOTE_STATUS[q.status] ?? { label: q.status, tone: "neutral" as BadgeTone };
              return (
                <tr key={q.id}>
                  <td>
                    <strong>{q.vendorName ?? "Vendor"}</strong>
                    {q.totalMinor === cheapest && live.length > 1 && <div><Badge tone="info">Lowest price</Badge></div>}
                  </td>
                  <td>
                    <QuoteBreakdown quote={q} />
                  </td>
                  <td>
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </td>
                  <td>
                    {comparing && q.status === "submitted" && (
                      <Button size="sm" loading={submit.submitting} onClick={() => void shortlist(q.id, true)}>
                        Shortlist<span className="k-sr-only"> {q.vendorName}</span>
                      </Button>
                    )}
                    {comparing && q.status === "shortlisted" && (
                      <Button size="sm" variant="secondary" loading={submit.submitting} onClick={() => void shortlist(q.id, false)}>
                        Take off the list<span className="k-sr-only"> {q.vendorName}</span>
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}

function BookingPanel({ view, onChanged }: { view: SourcingView; onChanged: () => void }) {
  const submit = useSubmit();
  const b = view.booking;
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [venue, setVenue] = useState("");
  if (!b && view.cancelledBookings.length === 0) return null;
  const st = b ? BOOKING_STATUS[b.status] : null;

  async function schedule(e: FormEvent) {
    e.preventDefault();
    if (!b) return;
    const res = await submit.run(() => api(`/bookings/${b.id}/schedule`, { method: "POST", body: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), venueText: venue.trim() || null } }));
    if (res) onChanged();
  }
  return (
    <Card>
      <h2>Booking</h2>
      {b && st && (
        <div className="k-stack">
          <div>
            <strong>{b.vendorName ?? "Vendor"}</strong> <Badge tone={st.tone}>{st.label}</Badge>
            <div>Agreed price {rupees(b.agreedTotalMinor)}</div>
            <div className="k-muted">
              {b.scheduledStart ? `${when(b.scheduledStart)} to ${when(b.scheduledEnd)}${b.venueText ? ` · ${b.venueText}` : ""}` : "No date set yet"}
            </div>
            {b.status === "pending_vendor" && <div>{b.vendorConfirmedAt ? `The vendor confirmed on ${when(b.vendorConfirmedAt)}. Use “Confirm the booking” above.` : b.scheduledStart ? "Waiting for the vendor to confirm this date." : "Set the date and place, then the vendor can confirm."}</div>}
          </div>
          {(b.status === "confirmed" || b.status === "completed") && (
            <div className="k-stack">
              <PaymentSummary booking={b} showFee />
              <PaymentsEditor key={`${b.paidMinor}-${b.feePaidMinor ?? 0}-${b.platformFeeMinor ?? "none"}`} booking={b} onChanged={onChanged} />
            </div>
          )}
          {b.status === "pending_vendor" && (
            <form onSubmit={schedule} className="k-stack" noValidate aria-label="Set the date and place">
              <ErrorSummary submit={submit} />
              <p className="k-muted">Changing the date asks the vendor to confirm again.</p>
              <div className="k-grid">
                <TextField label="Starts" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} error={submit.error?.fields["start"]} />
                <TextField label="Ends" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} error={submit.error?.fields["end"]} />
                <TextField label="Where" value={venue} onChange={(e) => setVenue(e.target.value)} error={submit.error?.fields["venueText"]} />
              </div>
              <div>
                <Button type="submit" variant="secondary" loading={submit.submitting} disabled={start === "" || end === ""}>
                  Save date and place
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
      {view.cancelledBookings.length > 0 && (
        <div style={{ marginTop: "var(--k-space-4)" }}>
          <h3>Cancelled bookings</h3>
          <ul>
            {view.cancelledBookings.map((c) => (
              <li key={c.id}>
                {c.vendorName ?? "Vendor"}: {c.cancelReason ?? "Cancelled"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** Everything operations do between "Approved" and "Completed", in one place. `onParentChanged` reloads the request itself. */
// (the parent keys this component by the request's status, so a step taken elsewhere on the page reloads it)
export function SourcingWorkspace({ requestId, onParentChanged }: { requestId: string; onParentChanged: () => void }) {
  const loader = useCallback(() => api<SourcingView>(`/requests/${requestId}/sourcing`), [requestId]);
  const { state, reload } = useLoad(loader);
  const changed = () => {
    reload();
    onParentChanged();
  };
  if (state.status === "loading") return <Skeleton height="4rem" />;
  if (state.status === "error") return <Alert variant="danger">We could not load the sourcing details.</Alert>;
  const view = state.data;
  return (
    <div className="k-stack k-stack-lg">
      <MatchesPanel requestId={requestId} view={view} onChanged={changed} />
      <InquiriesPanel view={view} onChanged={changed} />
      <QuotesPanel view={view} onChanged={changed} />
      <BookingPanel view={view} onChanged={changed} />
    </div>
  );
}
