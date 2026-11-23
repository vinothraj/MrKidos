"use client";

import { Alert, Badge, Button, Card, EmptyState, SelectField, Skeleton, TextAreaField, TextField, type BadgeTone } from "@kidos/ui";
import { useCallback, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import { useSession } from "@/lib/session";
import { useLoad } from "@/lib/use-load";
import { PlatformModeGate } from "./communities-admin";

export interface Review {
  id: string;
  bookingId: string;
  vendorId: string;
  vendorName: string | null;
  rating: number;
  body: string | null;
  status: "pending" | "published" | "rejected";
  moderationNote: string | null;
  reply: string | null;
  repliedAt: string | null;
  createdAt: string;
  community?: string | null;
  author?: string | null;
}

/** "4 out of 5" in words, with stars as decoration only (meaning never rests on the symbols). */
export function Rating({ value }: { value: number }) {
  return (
    <span>
      <span aria-hidden="true">{"★".repeat(value)}{"☆".repeat(5 - value)}</span> <strong>{value} out of 5</strong>
    </span>
  );
}

const STATUS: Record<Review["status"], { label: string; tone: BadgeTone }> = {
  pending: { label: "Waiting to be checked", tone: "warning" },
  published: { label: "Published", tone: "success" },
  rejected: { label: "Not published", tone: "danger" },
};

/** The author's own review, with where it stands. */
export function ReviewView({ review }: { review: Review }) {
  const st = STATUS[review.status];
  return (
    <div className="k-stack k-stack-sm">
      <p style={{ margin: 0 }}>
        <Rating value={review.rating} /> <Badge tone={st.tone}>{st.label}</Badge>
      </p>
      {review.body && <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{review.body}</p>}
      {review.status === "pending" && <p className="k-muted" style={{ margin: 0 }}>The team checks every review before anyone else can read it.</p>}
      {review.status === "rejected" && review.moderationNote && <Alert variant="info" title="Why this was not published">{review.moderationNote}</Alert>}
      {review.reply && (
        <p style={{ margin: 0 }}>
          <strong>Reply from {review.vendorName ?? "the vendor"}:</strong> {review.reply}
        </p>
      )}
    </div>
  );
}

/** A family reviews a completed booking. */
export function ReviewForm({ bookingId, onDone }: { bookingId: string; onDone: () => void }) {
  const submit = useSubmit();
  const [rating, setRating] = useState("");
  const [body, setBody] = useState("");
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const res = await submit.run(() => api(`/bookings/${bookingId}/review`, { method: "POST", body: { rating: Number(rating), body: body.trim() || null } }));
    if (res) onDone();
  }
  return (
    <form onSubmit={onSubmit} className="k-stack" noValidate aria-label="Leave a review">
      <ErrorSummary submit={submit} />
      <SelectField label="How was it?" value={rating} onChange={(e) => setRating(e.target.value)} error={submit.error?.fields["rating"]}>
        <option value="">Choose a rating</option>
        <option value="5">5 out of 5: excellent</option>
        <option value="4">4 out of 5: good</option>
        <option value="3">3 out of 5: fine</option>
        <option value="2">2 out of 5: poor</option>
        <option value="1">1 out of 5: very poor</option>
      </SelectField>
      <TextAreaField label="Tell other families (optional)" hint="Please do not include children's names or phone numbers. The team reads every review before it is published." rows={3} value={body} onChange={(e) => setBody(e.target.value)} error={submit.error?.fields["body"]} />
      <div>
        <Button type="submit" loading={submit.submitting} disabled={rating === ""}>
          Send my review
        </Button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------- the page */

function ModerationRow({ review, onChanged }: { review: Review; onChanged: () => void }) {
  const submit = useSubmit();
  const [note, setNote] = useState("");
  async function decide(decision: "publish" | "reject") {
    const res = await submit.run(() => api(`/reviews/${review.id}/moderation`, { method: "PUT", body: { decision, ...(note.trim() ? { note: note.trim() } : {}) } }));
    if (res) {
      setNote("");
      onChanged();
    }
  }
  return (
    <li className="k-stack k-stack-sm">
      <div>
        <strong>{review.vendorName ?? "Vendor"}</strong> <span className="k-muted">· {review.community} · by {review.author ?? "a family"}</span>
      </div>
      <p style={{ margin: 0 }}>
        <Rating value={review.rating} />
      </p>
      {review.body ? <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{review.body}</p> : <p className="k-muted" style={{ margin: 0 }}>No written comment.</p>}
      <ErrorSummary submit={submit} />
      {review.status === "pending" && (
        <>
          <TextField label={`Note for ${review.vendorName ?? "this review"}`} hint="Required when you do not publish. The author will read it." value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="k-row">
            <Button size="sm" loading={submit.submitting} onClick={() => void decide("publish")}>
              Publish<span className="k-sr-only"> the review of {review.vendorName}</span>
            </Button>
            <Button size="sm" variant="secondary" loading={submit.submitting} onClick={() => void decide("reject")}>
              Do not publish<span className="k-sr-only"> the review of {review.vendorName}</span>
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

function ReplyRow({ review, onChanged }: { review: Review; onChanged: () => void }) {
  const submit = useSubmit();
  const [reply, setReply] = useState("");
  async function send(e: FormEvent) {
    e.preventDefault();
    const res = await submit.run(() => api(`/reviews/${review.id}/reply`, { method: "POST", body: { reply: reply.trim() } }));
    if (res) onChanged();
  }
  return (
    <li className="k-stack k-stack-sm">
      <p style={{ margin: 0 }}>
        <Rating value={review.rating} /> <span className="k-muted">{new Date(review.createdAt).toLocaleDateString()}</span>
      </p>
      {review.body && <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{review.body}</p>}
      {review.reply ? (
        <p style={{ margin: 0 }}>
          <strong>Your reply:</strong> {review.reply}
        </p>
      ) : (
        <form onSubmit={send} className="k-stack" noValidate aria-label={`Reply to the ${review.rating} out of 5 review`}>
          <ErrorSummary submit={submit} />
          <TextAreaField label="Your reply" hint="Public. You can reply once." rows={2} value={reply} onChange={(e) => setReply(e.target.value)} error={submit.error?.fields["reply"]} />
          <div>
            <Button type="submit" size="sm" loading={submit.submitting} disabled={reply.trim() === ""}>
              Send reply
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

function ReviewList({ status, mode }: { status: string; mode: "ops" | "vendor" }) {
  const loader = useCallback(() => api<{ data: Review[] }>(`/reviews${mode === "ops" ? `?status=${status}` : ""}`), [status, mode]);
  const { state, reload } = useLoad(loader);
  if (state.status === "loading") return <Skeleton height="4rem" />;
  if (state.status === "error") return <Alert variant="danger">We could not load the reviews.</Alert>;
  if (state.data.data.length === 0) {
    return <EmptyState title={mode === "ops" ? "Nothing here" : "No reviews yet"}>{mode === "ops" ? "Reviews waiting to be checked appear here." : "When a family reviews a booking and the team publishes it, it appears here."}</EmptyState>;
  }
  return (
    <ul className="k-stack k-stack-lg" style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {state.data.data.map((r) => (mode === "ops" ? <ModerationRow key={r.id} review={r} onChanged={reload} /> : <ReplyRow key={r.id} review={r} onChanged={reload} />))}
    </ul>
  );
}

export function ReviewsPage() {
  const { me, can, platformMode } = useSession();
  const [status, setStatus] = useState("pending");
  const ops = me.platformScope && can("reviews.moderate");
  const vendor = !me.platformScope && can("reviews.reply") && me.tenants.some((t) => t.id === me.activeTenantId && t.type === "vendor");

  if (!ops && !vendor) {
    return (
      <div className="k-stack">
        <h1>Reviews</h1>
        {me.platformStaff && !platformMode ? (
          <PlatformModeGate>
            <span />
          </PlatformModeGate>
        ) : (
          <Alert variant="info" title="Reviews are for the team and for vendors">
            Select the vendor you work for from the menu at the top, or switch to platform mode if you are on the team.
          </Alert>
        )}
      </div>
    );
  }
  return (
    <div className="k-stack k-stack-lg">
      <div>
        <h1>Reviews</h1>
        <p className="k-muted">{ops ? "Every review is checked before anyone else can read it. Take down anything that names a child or shares contact details." : "What families said about your work. You can reply once to each."}</p>
      </div>
      {ops && (
        <div style={{ maxWidth: "16rem" }}>
          <SelectField label="Show" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="pending">Waiting to be checked</option>
            <option value="published">Published</option>
            <option value="rejected">Not published</option>
          </SelectField>
        </div>
      )}
      <Card>
        <ReviewList key={status} status={status} mode={ops ? "ops" : "vendor"} />
      </Card>
    </div>
  );
}
