"use client";

import { Alert, Badge, Button, ButtonLink, Card, CheckboxField, EmptyState, FieldGroup, NextSteps, ReviewList, SelectField, Skeleton, TableWrap, TextAreaField, TextField, Wizard, type BadgeTone } from "@kidos/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Artwork } from "@/components/artwork";
import { api, ApiError } from "@/lib/api";
import { ErrorSummary, useDraft, useSubmit } from "@/lib/forms";
import type { PhotoSlot } from "@/lib/photos";
import { useSession } from "@/lib/session";
import { useLoad } from "@/lib/use-load";
import { PlatformModeGate } from "./communities-admin";
import { ReviewForm, ReviewView, type Review } from "./reviews";
import { BOOKING_STATUS, PaymentSummary, QuoteBreakdown, rupees, SourcingWorkspace, type Booking, type Quote } from "./sourcing";

/* ------------------------------------------------------------------ shared */

const STATUS_TONE: Record<string, BadgeTone> = {
  submitted: "info",
  under_review: "info",
  information_required: "warning",
  approved: "success",
  rejected: "danger",
  cancelled: "neutral",
  closed: "neutral",
  completed: "success",
};

function StatusBadge({ status, label }: { status: string; label: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{label}</Badge>;
}

function SlaBadge({ state }: { state: string | null | undefined }) {
  if (state === "overdue") return <Badge tone="danger">Overdue</Badge>;
  if (state === "due_soon") return <Badge tone="warning">Due soon</Badge>;
  if (state === "on_track") return <Badge tone="success">On track</Badge>;
  return <span aria-label="No target">—</span>;
}

interface ListItem {
  id: string;
  number: number;
  title: string;
  status: string;
  statusLabel: string;
  waitingOn: string;
  terminal: boolean;
  type: string;
  category: string | null;
  community: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
  mine: boolean;
  requester?: { name: string | null };
  slaDueAt?: string | null;
  slaState?: string | null;
  assignedTo?: { id: string; name: string | null } | null;
}
interface ListPage {
  data: ListItem[];
  page: { hasMore: boolean; nextCursor: string | null };
}
interface Summary {
  open: number;
  overdue: number;
  dueSoon: number;
  unassigned: number;
  mine: number;
  waitingOnResident: number;
  byStatus: { status: string; label: string; count: number }[];
}

const when = (iso: string) => new Date(iso).toLocaleString();

/* -------------------------------------------------------------------- list */

const OPS_VIEWS: Record<string, { label: string; query: string }> = {
  open: { label: "Open requests", query: "open=true" },
  overdue: { label: "Overdue", query: "sla=overdue" },
  due_soon: { label: "Due within 4 hours", query: "sla=due_soon" },
  unassigned: { label: "Unassigned", query: "assigned=unassigned" },
  mine: { label: "Assigned to me", query: "assigned=me" },
  finished: { label: "Finished", query: "open=false" },
  all: { label: "Everything", query: "" },
};
const FAMILY_VIEWS: Record<string, { label: string; query: string }> = {
  open: OPS_VIEWS["open"] as { label: string; query: string },
  finished: OPS_VIEWS["finished"] as { label: string; query: string },
  all: OPS_VIEWS["all"] as { label: string; query: string },
};

async function fetchPage(query: string, q: string, cursor: string | null): Promise<ListPage | "error"> {
  const qs = new URLSearchParams(query);
  qs.set("limit", "25");
  if (q) qs.set("q", q);
  if (cursor) qs.set("cursor", cursor);
  try {
    return await api<ListPage>(`/requests?${qs.toString()}`);
  } catch {
    return "error";
  }
}

function RequestTable({ query, q, audience }: { query: string; q: string; audience: "ops" | "community" | "family" }) {
  const [rows, setRows] = useState<ListItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchPage(query, q, null).then((r) => {
      if (!active) return;
      if (r === "error") setFailed(true);
      else {
        setRows(r.data);
        setCursor(r.page.nextCursor);
      }
    });
    return () => {
      active = false;
    };
  }, [query, q]);

  async function loadMore() {
    setMore(true);
    const r = await fetchPage(query, q, cursor);
    if (r === "error") setFailed(true);
    else {
      setRows((cur) => [...(cur ?? []), ...r.data]);
      setCursor(r.page.nextCursor);
    }
    setMore(false);
  }

  if (failed) return <Alert variant="danger">We could not load the requests. Please try again.</Alert>;
  if (rows === null) return <Skeleton height="4rem" />;
  if (rows.length === 0) {
    return (
      <EmptyState title={audience === "family" ? "No requests here yet" : "Nothing in this view"} art={audience === "family" ? <Artwork slot="kids" /> : undefined}>
        {audience === "family" ? "When you need an activity, a party or a class, make a request and we will find trusted options." : "Try a different view or search."}
      </EmptyState>
    );
  }
  return (
    <>
      <TableWrap label="Requests">
        <table className="k-table" aria-label="Requests">
          <thead>
            <tr>
              <th scope="col">No.</th>
              <th scope="col">Request</th>
              <th scope="col">Status</th>
              {audience !== "family" && <th scope="col">Community</th>}
              {audience !== "family" && <th scope="col">Asked by</th>}
              {audience === "ops" && <th scope="col">Target</th>}
              {audience === "ops" && <th scope="col">Owner</th>}
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.number}</td>
                <td>
                  <Link href={`/app/requests/${r.id}`}>{r.title}</Link>
                  <div className="k-muted">{r.type}</div>
                </td>
                <td>
                  <StatusBadge status={r.status} label={r.statusLabel} />
                  {audience === "family" && r.waitingOn === "resident" && <div className="k-muted">Waiting for you</div>}
                </td>
                {audience !== "family" && <td>{r.community.name}</td>}
                {audience !== "family" && <td>{r.requester?.name ?? "—"}</td>}
                {audience === "ops" && (
                  <td>
                    <SlaBadge state={r.slaState} />
                  </td>
                )}
                {audience === "ops" && <td>{r.assignedTo ? (r.assignedTo.name ?? "Assigned") : <span className="k-muted">Unassigned</span>}</td>}
                <td>{when(r.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {cursor && (
        <div style={{ marginTop: "var(--k-space-4)" }}>
          <Button variant="secondary" loading={more} onClick={() => void loadMore()}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}

function SummaryTiles({ onPick }: { onPick: (view: string) => void }) {
  const loader = useCallback(() => api<Summary>("/requests/summary"), []);
  const { state } = useLoad(loader);
  if (state.status !== "ready") return state.status === "loading" ? <Skeleton height="3rem" /> : null;
  const s = state.data;
  const tiles: { view: string; label: string; n: number; tone: BadgeTone }[] = [
    { view: "open", label: "Open", n: s.open, tone: "info" },
    { view: "overdue", label: "Overdue", n: s.overdue, tone: s.overdue > 0 ? "danger" : "neutral" },
    { view: "due_soon", label: "Due within 4 hours", n: s.dueSoon, tone: s.dueSoon > 0 ? "warning" : "neutral" },
    { view: "unassigned", label: "Unassigned", n: s.unassigned, tone: s.unassigned > 0 ? "warning" : "neutral" },
    { view: "mine", label: "Assigned to me", n: s.mine, tone: "neutral" },
  ];
  return (
    <section aria-label="Queue summary">
      <ul className="k-grid" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {tiles.map((t) => (
          <li key={t.view}>
            <Card>
              <div className="k-muted">{t.label}</div>
              <div style={{ fontSize: "var(--k-text-xl, 1.5rem)", fontWeight: 700 }}>{t.n}</div>
              <div style={{ marginTop: "var(--k-space-2)" }}>
                <Button size="sm" variant="secondary" onClick={() => onPick(t.view)}>
                  Show<span className="k-sr-only"> {t.label}</span>
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      <p className="k-muted" style={{ marginTop: "var(--k-space-3)" }}>
        {s.waitingOnResident} {s.waitingOnResident === 1 ? "request is" : "requests are"} waiting for a family to reply; that wait is not counted against the team.
      </p>
    </section>
  );
}

export function RequestsList() {
  const { me, can, platformMode } = useSession();
  const ops = me.platformScope && can("requests.read_all");
  const community = !me.platformScope && can("requests.read_community");
  const audience: "ops" | "community" | "family" = ops ? "ops" : community ? "community" : "family";
  const views = audience === "ops" ? OPS_VIEWS : FAMILY_VIEWS;
  // Families have few requests and should see all of them (a declined one must not seem to vanish); the team starts from what is open.
  const [view, setView] = useState(audience === "family" ? "all" : "open");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const heading = audience === "ops" ? "Request queue" : audience === "community" ? "Community requests" : "My requests";

  const body = (
    <div className="k-stack k-stack-lg">
      {audience === "ops" && <SummaryTiles onPick={setView} />}
      <form
        className="k-row"
        role="search"
        aria-label="Filter requests"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(qInput.trim());
        }}
      >
        <div style={{ flex: "0 1 16rem" }}>
          <SelectField label="Show" value={view} onChange={(e) => setView(e.target.value)}>
            {Object.entries(views).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </SelectField>
        </div>
        {audience !== "family" && (
          <div style={{ flex: "1 1 14rem" }}>
            <TextField label="Search by title or number" value={qInput} onChange={(e) => setQInput(e.target.value)} />
          </div>
        )}
        {audience !== "family" && (
          <Button type="submit" variant="secondary" style={{ alignSelf: "flex-end" }}>
            Search
          </Button>
        )}
      </form>
      <RequestTable key={`${view}|${q}|${audience}`} query={views[view]?.query ?? ""} q={q} audience={audience} />
    </div>
  );

  return (
    <div className="k-stack k-stack-lg">
      <div className="k-row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>{heading}</h1>
          <p className="k-muted">
            {audience === "ops" && "Everything families have asked for, oldest targets first in each view."}
            {audience === "community" && "What families in your community have asked for. You can read these; the platform team works them."}
            {audience === "family" && "What you have asked for, and where each request stands."}
          </p>
        </div>
        {audience === "family" && can("requests.create_own") && <ButtonLink href="/app/requests/new">Make a request</ButtonLink>}
      </div>
      {audience === "ops" && !platformMode ? <PlatformModeGate>{body}</PlatformModeGate> : body}
    </div>
  );
}

/* ----------------------------------------------------------------- new one */

interface Field {
  key: string;
  label: string;
  type: "text" | "long_text" | "number" | "date" | "select" | "multi_select" | "boolean";
  required?: boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  hint?: string;
}
interface RequestType {
  id: string;
  key: string;
  name: string;
  description: string;
  fields: Field[];
}
interface Category {
  id: string;
  parentId: string | null;
  name: string;
  isActive: boolean;
}

const blank = (v: string): string | null => (v.trim() === "" ? null : v.trim());
const int = (v: string): number | null => (v.trim() === "" ? null : Number(v));

function AnswerField({ field, value, error, onChange }: { field: Field; value: unknown; error: string | undefined; onChange: (v: unknown) => void }) {
  const label = field.required ? field.label : `${field.label} (optional)`;
  // (an explicit `hint: undefined` is not allowed by the design system's prop types, so the hint is spread only when present)
  const hint = field.hint ? { hint: field.hint } : {};
  switch (field.type) {
    case "long_text":
      return <TextAreaField label={label} {...hint} rows={3} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} error={error} />;
    case "number":
      return <TextField label={label} {...hint} type="number" inputMode="numeric" min={field.min} max={field.max} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} error={error} />;
    case "date":
      return <TextField label={label} {...hint} type="date" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} error={error} />;
    case "select":
      return (
        <SelectField label={label} {...hint} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} error={error}>
          <option value="">Choose…</option>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
      );
    case "boolean":
      return (
        <SelectField label={label} {...hint} value={value === true ? "yes" : value === false ? "no" : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "yes")} error={error}>
          <option value="">Not sure</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </SelectField>
      );
    case "multi_select": {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      return (
        <FieldGroup legend={label} {...hint}>
          {field.options?.map((o) => (
            <CheckboxField key={o.value} label={o.label} checked={chosen.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...chosen, o.value] : chosen.filter((x) => x !== o.value))} />
          ))}
        </FieldGroup>
      );
    }
    default:
      return <TextField label={label} {...hint} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} error={error} />;
  }
}

/** A picture and step names per kind of request, so each category's steps feel like its own. Unknown kinds get none. */
const TYPE_LOOK: Record<string, { picture: PhotoSlot; about: string; when: string }> = {
  activity: { picture: "explore", about: "About the activity", when: "Who it is for, and when" },
  celebration: { picture: "bannerCandles", about: "About the celebration", when: "Guests, date and place" },
  workshop: { picture: "kids", about: "About the workshop", when: "Who will take part, and when" },
};

function answerShown(field: Field, v: unknown): string {
  if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) return "";
  if (field.type === "boolean") return v === true ? "Yes" : "No";
  if (field.type === "select") return field.options?.find((o) => o.value === v)?.label ?? String(v);
  if (field.type === "multi_select" && Array.isArray(v)) return v.map((x) => field.options?.find((o) => o.value === x)?.label ?? String(x)).join(", ");
  return String(v);
}

function NewRequestForm({ types, categories }: { types: RequestType[]; categories: Category[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const offeringId = params.get("offering");
  const offeringName = params.get("name");
  const submit = useSubmit();
  const [d, setD, clearDraft, restored] = useDraft(`request-new:${offeringId ?? "any"}`, {
    typeId: types[0]?.id ?? "",
    title: offeringName ? `Booking: ${offeringName}` : "",
    description: "",
    categoryId: "",
    preferredDate: "",
    flexibleDates: false,
    participantCount: "",
    ageMin: "",
    ageMax: "",
    budget: "",
    venueText: "",
    answers: {} as Record<string, unknown>,
  });
  const type = types.find((t) => t.id === d.typeId) ?? types[0];
  const look = type ? TYPE_LOOK[type.key] : undefined;
  const set = (k: "title" | "description" | "categoryId" | "preferredDate" | "participantCount" | "ageMin" | "ageMax" | "budget" | "venueText") => (e: { target: { value: string } }) =>
    setD((c) => ({ ...c, [k]: e.target.value }));
  const err = submit.error?.fields ?? {};
  const leaf = categories.filter((c) => c.parentId !== null && c.isActive);

  async function send() {
    if (!type) return;
    // only answers to THIS type's questions are sent, in their proper types
    const cleaned: Record<string, unknown> = {};
    for (const field of type.fields) {
      const v = d.answers[field.key];
      if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
      cleaned[field.key] = field.type === "number" ? Number(v) : v;
    }
    const body = {
      requestTypeId: type.id,
      title: d.title.trim(),
      description: blank(d.description),
      categoryId: d.categoryId || null,
      ...(offeringId ? { offeringId } : {}),
      preferredDate: blank(d.preferredDate),
      flexibleDates: d.flexibleDates,
      participantCount: int(d.participantCount),
      ageMin: int(d.ageMin),
      ageMax: int(d.ageMax),
      budgetMaxMinor: d.budget.trim() === "" ? null : Math.round(Number(d.budget) * 100),
      venueText: blank(d.venueText),
      answers: cleaned,
    };
    const created = await submit.run(() => api<{ id: string }>("/requests", { method: "POST", body }));
    if (created) {
      clearDraft();
      router.push(`/app/requests/${created.id}`);
    }
  }

  const answerFields = (type?.fields ?? []).map((f) => `answers.${f.key}`);
  const missingAnswer = (type?.fields ?? []).find((f) => {
    const v = d.answers[f.key];
    return f.required && (v === undefined || v === "" || (Array.isArray(v) && v.length === 0));
  });
  const category = leaf.find((c) => c.id === d.categoryId);

  return (
    <Wizard
      label="Make a request"
      submitLabel="Send request"
      submitting={submit.submitting}
      onSubmit={() => void send()}
      errorFields={Object.keys(err)}
      header={
        <>
          <ErrorSummary submit={submit} />
          {restored && <Alert variant="info">We kept what you typed earlier in this tab.</Alert>}
          {offeringId && (
            <Alert variant="info" title="This request is about an offering from the catalog">
              {offeringName ?? "The offering you chose"}. The team will check availability and price with the vendor for you.
            </Alert>
          )}
        </>
      }
      extraActions={
        <ButtonLink href="/app/requests" variant="ghost">
          Cancel
        </ButtonLink>
      }
      steps={[
        {
          id: "what",
          title: "What you need",
          intro: "Choose the kind of help, then give it a title the team will recognise.",
          fields: ["requestTypeId", "title", "description"],
          validate: () => (d.title.trim() ? null : "Give your request a short title, for example: Magic show for a 7th birthday."),
          content: (
            <>
              <fieldset className="k-fieldset">
                <legend className="k-label">What do you need?</legend>
                <div className="k-picture-grid">
                  {types.map((t) => {
                    const l = TYPE_LOOK[t.key];
                    return (
                      <label key={t.id} className="k-picture-option">
                        <input type="radio" name="request-type" value={t.id} checked={type?.id === t.id} onChange={() => setD((c) => ({ ...c, typeId: t.id, answers: {} }))} />
                        {l && (
                          <span className="k-picture-thumb" aria-hidden="true">
                            <Artwork slot={l.picture} />
                          </span>
                        )}
                        <span>{t.name}</span>
                        <span className="k-hint" style={{ fontWeight: 400 }}>
                          {t.description}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <TextField label="Give it a short title" required value={d.title} onChange={set("title")} error={err["title"]} />
              <TextAreaField
                label="Tell us more"
                tip="The operations team reads this. Vendors only see a summary without your name. Please leave out phone numbers and full names of children: the team contacts you through the app."
                hint="What would make it a success?"
                rows={4}
                value={d.description}
                onChange={set("description")}
                error={err["description"]}
              />
            </>
          ),
        },
        {
          id: "about",
          title: look?.about ?? "A few more details",
          intro: type?.fields.length ? "Questions for this kind of request. Required ones say so." : "Nothing more to ask for this kind of request.",
          fields: answerFields,
          validate: () => (missingAnswer ? `Answer "${missingAnswer.label}". It is required for this kind of request.` : null),
          content: (
            <>
              {type?.fields.map((field) => (
                <AnswerField
                  key={`${type.id}:${field.key}`}
                  field={field}
                  value={d.answers[field.key]}
                  error={err[`answers.${field.key}`]}
                  onChange={(v) => setD((c) => ({ ...c, answers: { ...c.answers, [field.key]: v } }))}
                />
              ))}
            </>
          ),
        },
        {
          id: "when",
          title: look?.when ?? "Who, when and where",
          intro: "All optional, but the more you tell us, the better the options.",
          fields: ["participantCount", "ageMin", "ageMax", "preferredDate", "flexibleDates", "budgetMaxMinor", "venueText", "categoryId"],
          validate: () => {
            if (d.ageMin.trim() && d.ageMax.trim() && Number(d.ageMax) < Number(d.ageMin)) return "The oldest age cannot be below the youngest.";
            if (d.budget.trim() && !(Number(d.budget) >= 0)) return "The budget must be a number of rupees, or left empty.";
            return null;
          },
          content: (
            <>
              <div className="k-grid">
                <TextField label="Number of children (optional)" type="number" inputMode="numeric" min={1} value={d.participantCount} onChange={set("participantCount")} error={err["participantCount"]} />
                <TextField label="Youngest age (optional)" type="number" inputMode="numeric" min={0} value={d.ageMin} onChange={set("ageMin")} error={err["ageMin"]} />
                <TextField label="Oldest age (optional)" type="number" inputMode="numeric" min={0} value={d.ageMax} onChange={set("ageMax")} error={err["ageMax"]} />
                <TextField label="Preferred date (optional)" type="date" value={d.preferredDate} onChange={set("preferredDate")} error={err["preferredDate"]} />
              </div>
              <CheckboxField label="The date is flexible" checked={d.flexibleDates} onChange={(e) => setD((c) => ({ ...c, flexibleDates: e.target.checked }))} />
              <div className="k-grid">
                <TextField
                  label="Budget in rupees (optional)"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  value={d.budget}
                  onChange={set("budget")}
                  error={err["budgetMaxMinor"]}
                  hint="The most you would like to spend."
                />
                <TextField label="Where (optional)" value={d.venueText} onChange={set("venueText")} error={err["venueText"]} hint="For example: the clubhouse, or at home." />
                <SelectField label="Category (optional)" value={d.categoryId} onChange={set("categoryId")} error={err["categoryId"]}>
                  <option value="">Not sure yet</option>
                  {leaf.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </SelectField>
              </div>
            </>
          ),
        },
        {
          id: "review",
          title: "Check and send",
          intro: "Nothing is sent until you press Send request.",
          content: (
            <>
              <ReviewList
                items={[
                  { label: "Kind of request", value: type?.name ?? "" },
                  { label: "Title", value: d.title.trim() },
                  { label: "More about it", value: d.description.trim() },
                  ...(type?.fields ?? []).map((f) => ({ label: f.label.replace(/ \(optional\)$/u, ""), value: answerShown(f, d.answers[f.key]) })),
                  { label: "Children", value: d.participantCount.trim() },
                  { label: "Ages", value: d.ageMin.trim() || d.ageMax.trim() ? `${d.ageMin.trim() || "?"} to ${d.ageMax.trim() || "?"}` : "" },
                  { label: "Date", value: d.preferredDate ? `${d.preferredDate}${d.flexibleDates ? " (flexible)" : ""}` : d.flexibleDates ? "Flexible" : "" },
                  { label: "Budget", value: d.budget.trim() ? `₹${d.budget.trim()}` : "" },
                  { label: "Where", value: d.venueText.trim() },
                  { label: "Category", value: category?.name ?? "" },
                ]}
              />
              <NextSteps>
                The team reviews your request, usually within a day, and may ask you a question here. Once it is approved they ask trusted vendors and put
                the best options in front of you to compare. Nothing is booked until you choose.
              </NextSteps>
            </>
          ),
        },
      ]}
    />
  );
}

export function RequestNew() {
  const { me, can } = useSession();
  const typesLoader = useCallback(() => api<{ data: RequestType[] }>("/request-types"), []);
  const catsLoader = useCallback(() => api<{ data: Category[] }>("/categories"), []);
  const types = useLoad(typesLoader);
  const cats = useLoad(catsLoader);
  const community = me.platformScope ? undefined : me.tenants.find((t) => t.id === me.activeTenantId && t.type === "community");

  if (!community || !can("requests.create_own")) {
    return (
      <div className="k-stack">
        <h1>Make a request</h1>
        <Alert variant="info" title="Choose your community first">
          Requests are made from inside a community. Join one, then select it from the menu at the top.
        </Alert>
      </div>
    );
  }
  return (
    <div className="k-stack k-stack-lg">
      <div>
        <h1>Make a request</h1>
        <p className="k-muted">For {community.name}. Four short steps. The team comes back to you, usually within a day.</p>
      </div>
      {(types.state.status === "loading" || cats.state.status === "loading") && <Skeleton height="6rem" />}
      {(types.state.status === "error" || cats.state.status === "error") && <Alert variant="danger">We could not load the request form. Please try again.</Alert>}
      {types.state.status === "ready" && cats.state.status === "ready" && <NewRequestForm types={types.state.data.data} categories={cats.state.data.data} />}
    </div>
  );
}

/* ------------------------------------------------------------------ detail */

interface Detail extends ListItem {
  description: string | null;
  preferredDate: string | null;
  flexibleDates: boolean;
  participantCount: number | null;
  ageMin: number | null;
  ageMax: number | null;
  budgetMaxMinor: number | null;
  venueText: string | null;
  offering: { id: string; name: string; vendor: string | null } | null;
  answers: { key: string; label: string; value: string }[];
  history: { from: string | null; to: string; toStatus: string; note: string | null; byRequester: boolean; by?: string | null; at: string }[];
  comments: { id: string; visibility: string; body: string; byRequester: boolean; by?: string | null; at: string }[];
  transitions: { to: string; toLabel: string; label: string; noteRequired: boolean }[];
  options: Quote[];
  booking: Booking | null;
  review: Review | null;
  can: { comment: boolean; commentInternal: boolean; assign: boolean };
}

function Facts({ r }: { r: Detail }) {
  const rows: [string, string][] = [];
  if (r.preferredDate) rows.push(["Preferred date", `${r.preferredDate}${r.flexibleDates ? " (flexible)" : ""}`]);
  else if (r.flexibleDates) rows.push(["Date", "Flexible"]);
  if (r.participantCount !== null) rows.push(["Children", String(r.participantCount)]);
  if (r.ageMin !== null || r.ageMax !== null) rows.push(["Ages", `${r.ageMin ?? 0} to ${r.ageMax ?? "any"}`]);
  if (r.budgetMaxMinor !== null) rows.push(["Budget up to", `₹${(r.budgetMaxMinor / 100).toLocaleString()}`]);
  if (r.venueText) rows.push(["Where", r.venueText]);
  if (r.category) rows.push(["Category", r.category]);
  if (r.offering) rows.push(["About the offering", `${r.offering.name}${r.offering.vendor ? ` by ${r.offering.vendor}` : ""}`]);
  for (const a of r.answers) rows.push([a.label, a.value]);
  if (rows.length === 0) return null;
  return (
    <dl className="k-stack k-stack-sm" style={{ margin: 0 }}>
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt className="k-muted">{k}</dt>
          <dd style={{ margin: 0 }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Actions({ r, onChanged }: { r: Detail; onChanged: () => void }) {
  const { me } = useSession();
  const submit = useSubmit();
  const [note, setNote] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const staff = r.assignedTo !== undefined; // present only for the operations team
  const needsNote = r.transitions.some((t) => t.noteRequired);

  async function go(to: string) {
    const res = await submit.run(() => api(`/requests/${r.id}/transitions`, { method: "POST", body: { to, ...(note.trim() ? { note: note.trim() } : {}) } }));
    if (res) {
      setNote("");
      setConfirmCancel(false);
      onChanged();
    }
  }
  async function assign(userId: string | null) {
    const res = await submit.run(() => api(`/requests/${r.id}/assignee`, { method: "PUT", body: { userId } }));
    if (res) onChanged();
  }

  if (r.transitions.length === 0 && !r.can.assign) return null;
  return (
    <Card>
      <h2>{staff ? "Work this request" : "What you can do"}</h2>
      <div className="k-stack">
        <ErrorSummary submit={submit} />
        {r.can.assign && (
          <div className="k-row">
            <span>Owner: {r.assignedTo ? (r.assignedTo.name ?? "Assigned") : "nobody yet"}</span>
            {r.assignedTo?.id !== me.user.id && (
              <Button size="sm" variant="secondary" loading={submit.submitting} onClick={() => void assign(me.user.id)}>
                Take it
              </Button>
            )}
            {r.assignedTo && (
              <Button size="sm" variant="ghost" loading={submit.submitting} onClick={() => void assign(null)}>
                Unassign
              </Button>
            )}
          </div>
        )}
        {needsNote && staff && (
          <TextAreaField label="Note for this step" hint="The family and their community's administrators can read this. Use an internal note for anything private." rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        )}
        <div className="k-row">
          {r.transitions.map((t) =>
            t.to === "cancelled" && !staff ? (
              confirmCancel ? (
                <span key={t.to} className="k-row">
                  <span>Cancel this request?</span>
                  <Button size="sm" loading={submit.submitting} onClick={() => void go("cancelled")}>
                    Yes, cancel it
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(false)}>
                    Keep it
                  </Button>
                </span>
              ) : (
                <Button key={t.to} variant="secondary" onClick={() => setConfirmCancel(true)}>
                  {t.label}
                </Button>
              )
            ) : (t.to === "under_review" || t.to === "booking_pending") && !staff ? null : (
              <Button key={t.to} variant={["rejected", "closed", "cancelled"].includes(t.to) ? "secondary" : "primary"} loading={submit.submitting} onClick={() => void go(t.to)}>
                {t.label}
              </Button>
            ),
          )}
        </div>
      </div>
    </Card>
  );
}

/** The options operations offered the family. Choosing one opens the booking. */
function Options({ r, onChanged }: { r: Detail; onChanged: () => void }) {
  const submit = useSubmit();
  const [confirming, setConfirming] = useState<string | null>(null);
  async function choose(quoteId: string) {
    const res = await submit.run(() => api(`/requests/${r.id}/quotes/${quoteId}/accept`, { method: "POST" }));
    if (res) {
      setConfirming(null);
      onChanged();
    }
  }
  if (r.status !== "shortlisted" || r.options.length === 0) return null;
  return (
    <Card>
      <h2>Your options</h2>
      <p className="k-muted">The team asked vendors and chose these for you. Pick the one you like; you can still cancel before it is confirmed.</p>
      <ErrorSummary submit={submit} />
      <ul className="k-stack k-stack-lg" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {r.options.map((o) => (
          <li key={o.id} className="k-stack k-stack-sm">
            <h3 style={{ margin: 0 }}>{o.vendorName ?? "A vendor"}</h3>
            <QuoteBreakdown quote={o} />
            {confirming === o.id ? (
              <div className="k-row">
                <span>Choose {o.vendorName ?? "this vendor"} for {rupees(o.totalMinor)}?</span>
                <Button size="sm" loading={submit.submitting} onClick={() => void choose(o.id)}>
                  Yes, choose this option
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                  Not yet
                </Button>
              </div>
            ) : (
              <div>
                <Button onClick={() => setConfirming(o.id)}>
                  Choose this option<span className="k-sr-only"> from {o.vendorName ?? "this vendor"}</span>
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function FamilyBooking({ booking, review, onChanged }: { booking: Booking; review: Review | null; onChanged: () => void }) {
  const st = BOOKING_STATUS[booking.status];
  return (
    <Card>
      <h2>Your booking</h2>
      <p>
        <strong>{booking.vendorName ?? "Your vendor"}</strong> <Badge tone={st.tone}>{st.label}</Badge>
      </p>
      <p>Agreed price {rupees(booking.agreedTotalMinor)}. You pay the vendor directly.</p>
      <p className="k-muted">
        {booking.scheduledStart
          ? `${new Date(booking.scheduledStart).toLocaleString()} to ${booking.scheduledEnd ? new Date(booking.scheduledEnd).toLocaleString() : ""}${booking.venueText ? ` · ${booking.venueText}` : ""}`
          : "The team is agreeing a date and place with the vendor. You will see them here."}
      </p>
      <PaymentSummary booking={booking} showFee={false} />
      {booking.status === "completed" && (
        <div className="k-stack" style={{ marginTop: "var(--k-space-4)" }}>
          <h3>Your review</h3>
          {review ? <ReviewView review={review} /> : <ReviewForm bookingId={booking.id} onDone={onChanged} />}
        </div>
      )}
    </Card>
  );
}

function Messages({ r, onChanged }: { r: Detail; onChanged: () => void }) {
  const submit = useSubmit();
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  // a family answering the team's question: the reply also sends the request back to the team's queue
  const replying = r.assignedTo === undefined && r.status === "information_required" && r.can.comment;

  async function send(e: FormEvent) {
    e.preventDefault();
    const res = await submit.run(() =>
      api(`/requests/${r.id}/comments`, { method: "POST", body: { body: body.trim(), visibility: internal ? "internal" : "resident", ...(replying ? { returnToReview: true } : {}) } }),
    );
    if (res) {
      setBody("");
      setInternal(false);
      onChanged();
    }
  }

  return (
    <Card>
      <h2>Messages</h2>
      {r.comments.length === 0 ? (
        <p className="k-muted">No messages yet.</p>
      ) : (
        <ul className="k-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {r.comments.map((m) => (
            <li key={m.id}>
              <strong>{m.byRequester ? (r.requester?.name ?? "The family") : (m.by ?? "The team")}</strong>{" "}
              {m.visibility === "internal" && <Badge tone="warning">Internal note: the family cannot see this</Badge>}{" "}
              <span className="k-muted">{when(m.at)}</span>
              <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
            </li>
          ))}
        </ul>
      )}
      {(r.can.comment || r.can.commentInternal) && (
        <form onSubmit={send} className="k-stack" noValidate aria-label="Write a message" style={{ marginTop: "var(--k-space-4)" }}>
          <ErrorSummary submit={submit} />
          <TextAreaField label={replying ? "Your reply" : "Write a message"} rows={3} value={body} onChange={(e) => setBody(e.target.value)} error={submit.error?.fields["body"]} />
          {r.can.commentInternal && <CheckboxField label="Internal note (only the team can see it)" checked={internal} onChange={(e) => setInternal(e.target.checked)} />}
          <div>
            <Button type="submit" loading={submit.submitting} disabled={body.trim() === ""}>
              {replying ? "Send reply" : internal ? "Add internal note" : "Send message"}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

export function RequestDetail({ id }: { id: string }) {
  const loader = useCallback(() => api<Detail>(`/requests/${id}`), [id]);
  const { state, reload } = useLoad(loader);

  if (state.status === "loading") return <Skeleton height="8rem" />;
  if (state.status === "error") {
    const notFound = state.error instanceof ApiError && state.error.status === 404;
    return (
      <Alert variant="danger" title={notFound ? "Request not found" : "We could not load this request"}>
        {notFound ? "It may not exist, or you may not have access to it." : "Please try again in a moment."}
      </Alert>
    );
  }
  const r = state.data;
  const staff = r.assignedTo !== undefined;
  const lastNote = r.history.length > 0 ? r.history[r.history.length - 1] : undefined;

  return (
    <div className="k-stack k-stack-lg">
      <div>
        <p>
          <Link href="/app/requests">Back to requests</Link>
        </p>
        <div className="k-row">
          <h1 style={{ margin: 0 }}>{r.title}</h1>
          <StatusBadge status={r.status} label={r.statusLabel} />
        </div>
        <p className="k-muted">
          Request {r.number} · {r.type} · {r.community.name}
          {r.requester ? ` · asked by ${r.requester.name ?? "a resident"}` : ""}
        </p>
        {staff && (
          <p>
            Target: <SlaBadge state={r.slaState} />
            {r.slaDueAt ? <span className="k-muted"> due {when(r.slaDueAt)}</span> : null}
          </p>
        )}
      </div>

      {!staff && r.status === "information_required" && lastNote?.note && (
        <Alert variant="warning" title="The team has a question for you">
          {lastNote.note}
        </Alert>
      )}
      {!staff && r.status === "shortlisted" && r.options.length > 0 && (
        <Alert variant="success" title="Your options are ready">
          Look through them below and choose the one you like.
        </Alert>
      )}
      {!staff && r.waitingOn === "operations" && !r.terminal && (
        <Alert variant="info" title="We are on it">
          A member of the team will look at this and come back to you here. You do not need to do anything.
        </Alert>
      )}
      {!staff && r.status === "rejected" && lastNote?.note && (
        <Alert variant="danger" title="We could not take this request on">
          {lastNote.note}
        </Alert>
      )}

      <Actions r={r} onChanged={reload} />

      {staff && ["sourcing", "vendor_inquiry", "quotes_received", "shortlisted", "booking_pending", "confirmed", "completed"].includes(r.status) && (
        <SourcingWorkspace key={r.status} requestId={r.id} onParentChanged={reload} />
      )}
      {!staff && <Options r={r} onChanged={reload} />}
      {!staff && r.booking && <FamilyBooking booking={r.booking} review={r.review} onChanged={reload} />}

      <Card>
        <h2>Details</h2>
        {r.description && <p style={{ whiteSpace: "pre-wrap" }}>{r.description}</p>}
        <Facts r={r} />
      </Card>

      <Messages r={r} onChanged={reload} />

      <Card>
        <h2>History</h2>
        <ol style={{ paddingLeft: "var(--k-space-5)", margin: 0 }}>
          {r.history.map((h, i) => (
            <li key={`${h.at}-${i}`}>
              <strong>{h.from ? `${h.from} → ${h.to}` : h.to}</strong> <span className="k-muted">{when(h.at)}{h.by ? ` · ${h.by}` : h.byRequester ? " · the family" : staff ? "" : " · the team"}</span>
              {h.note && <div>{h.note}</div>}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
