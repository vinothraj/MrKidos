"use client";

import { Alert, Badge, Button, Card, EmptyState, SelectField, Skeleton, TextAreaField, TextField, type BadgeTone } from "@kidos/ui";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import { useSession } from "@/lib/session";
import { useLoad } from "@/lib/use-load";
import { SAFETY_ATTENTION_HOURS, waited } from "@/lib/waiting";
import { PlatformModeGate } from "./communities-admin";

type Status = "open" | "reviewing" | "resolved" | "dismissed";
type Category = "child_safety" | "conduct" | "payment" | "other";

interface Mine {
  id: string;
  category: Category;
  subject: string;
  vendor: { id: string; name: string | null } | null;
  status: Status;
  resolution: string | null;
  createdAt: string;
}
interface TeamConcern extends Mine {
  details: string;
  reportedBy: { name: string | null; email: string | null };
  organization: string | null;
  decidedAt: string | null;
}

const CATEGORY: Record<Category, string> = {
  child_safety: "A child's safety",
  conduct: "How someone behaved",
  payment: "Money or pricing",
  other: "Something else",
};
/** Words first: a status is never shown by colour alone. */
const STATUS: Record<Status, { mine: string; team: string; tone: BadgeTone }> = {
  open: { mine: "Received", team: "Needs a decision", tone: "warning" },
  reviewing: { mine: "The team is looking at it", team: "Being looked at", tone: "info" },
  resolved: { mine: "Decided", team: "Resolved", tone: "success" },
  dismissed: { mine: "Decided", team: "Closed without action", tone: "neutral" },
};

/* --------------------------------------------------------------- a person's view */

function ReportForm({ vendor, onDone }: { vendor: { id: string; name: string } | null; onDone: () => void }) {
  const submit = useSubmit();
  const [category, setCategory] = useState("");
  const [subject, setSubject] = useState("");
  const [details, setDetails] = useState("");
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const res = await submit.run(() => api("/concerns", { method: "POST", body: { category, subject: subject.trim(), details: details.trim(), ...(vendor ? { vendorId: vendor.id } : {}) } }));
    if (res) {
      setSent(true);
      setCategory("");
      setSubject("");
      setDetails("");
      onDone();
    }
  }

  return (
    <form onSubmit={onSubmit} className="k-stack" noValidate aria-label="Report a concern">
      {sent && (
        <Alert variant="success" title="Thank you. We have your report.">
          The team has been told and will look at it. You can follow what happens below.
        </Alert>
      )}
      <ErrorSummary submit={submit} />
      {vendor && (
        <p style={{ margin: 0 }}>
          This report is about <strong>{vendor.name}</strong>.
        </p>
      )}
      <SelectField label="What is it about?" value={category} onChange={(e) => setCategory(e.target.value)} error={submit.error?.fields["category"]} required>
        <option value="">Choose one</option>
        {(Object.keys(CATEGORY) as Category[]).map((k) => (
          <option key={k} value={k}>
            {CATEGORY[k]}
          </option>
        ))}
      </SelectField>
      <TextField label="In a few words" hint="For example: coach was alone with a child" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={150} error={submit.error?.fields["subject"]} required />
      <TextAreaField label="What happened?" hint="When, where and who was there, as far as you know. Please do not write children's full names or phone numbers; the team will ask you if it needs them." rows={6} value={details} onChange={(e) => setDetails(e.target.value)} maxLength={3000} error={submit.error?.fields["details"]} required />
      <div>
        <Button type="submit" loading={submit.submitting} disabled={category === "" || subject.trim() === "" || details.trim() === ""}>
          Send report
        </Button>
      </div>
    </form>
  );
}

function MyReports({ reloadKey }: { reloadKey: number }) {
  const loader = useCallback(() => api<{ data: Mine[] }>(`/concerns/mine?r=${reloadKey}`), [reloadKey]);
  const { state } = useLoad(loader);
  if (state.status === "loading") return <Skeleton height="4rem" />;
  if (state.status === "error") return <Alert variant="danger">We could not load your reports. Please try again.</Alert>;
  if (state.data.data.length === 0) return <p className="k-muted">You have not sent any reports.</p>;
  return (
    <ul className="k-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {state.data.data.map((r) => (
        <li key={r.id} className="k-stack k-stack-sm">
          <p style={{ margin: 0 }}>
            <strong>{r.subject}</strong> <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].mine}</Badge>
          </p>
          <p className="k-muted" style={{ margin: 0 }}>
            {CATEGORY[r.category]}
            {r.vendor?.name ? ` · about ${r.vendor.name}` : ""} · sent {new Date(r.createdAt).toLocaleDateString()}
          </p>
          {r.resolution && <Alert variant="info" title="What the team decided">{r.resolution}</Alert>}
        </li>
      ))}
    </ul>
  );
}

function ReportPage() {
  const params = useSearchParams();
  const vendorId = params.get("vendor");
  const vendorName = params.get("name");
  const vendor = vendorId && /^[0-9a-f-]{36}$/i.test(vendorId) && vendorName ? { id: vendorId, name: vendorName.slice(0, 120) } : null;
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <div className="k-stack k-stack-lg">
      <div>
        <h1>Report a concern</h1>
        <p className="k-muted">Tell the team about anything that worries you: a child&apos;s safety, how someone behaved, or money.</p>
      </div>
      <Alert variant="warning" title="If a child is in danger right now">
        Call 112 (emergency) or 1098 (Childline) first. Then tell us here.
      </Alert>
      <Card>
        <ReportForm vendor={vendor} onDone={() => setReloadKey((k) => k + 1)} />
        <p className="k-muted">Your report goes to the platform team only. It is not shown to the vendor, to your community or to other families. The team can see who you are and may contact you.</p>
      </Card>
      <section aria-labelledby="my-reports">
        <h2 id="my-reports">Your reports</h2>
        <MyReports reloadKey={reloadKey} />
      </section>
    </div>
  );
}

/* ----------------------------------------------------------------- the team's view */

function TeamRow({ concern, onChanged }: { concern: TeamConcern; onChanged: (notice: string) => void }) {
  const submit = useSubmit();
  const [resolution, setResolution] = useState("");
  const decided = concern.status === "resolved" || concern.status === "dismissed";
  const wait = decided ? null : waited(concern.createdAt);
  async function move(status: "reviewing" | "resolved" | "dismissed") {
    const res = await submit.run(() => api(`/concerns/${concern.id}/status`, { method: "PUT", body: { status, ...(status === "reviewing" ? {} : { resolution: resolution.trim() }) } }));
    if (res) {
      setResolution("");
      onChanged(status === "reviewing" ? `Now being looked at: ${concern.subject}` : status === "resolved" ? `Marked resolved, and the reporter can now read the outcome: ${concern.subject}` : `Closed without action, and the reporter can now read why: ${concern.subject}`);
    }
  }
  return (
    <li className="k-stack k-stack-sm">
      <p style={{ margin: 0 }}>
        <Badge tone={concern.category === "child_safety" ? "danger" : "neutral"}>{CATEGORY[concern.category]}</Badge> <strong>{concern.subject}</strong>{" "}
        <Badge tone={STATUS[concern.status].tone}>{STATUS[concern.status].team}</Badge>
        {wait && concern.category === "child_safety" && wait.hours >= SAFETY_ATTENTION_HOURS && <Badge tone="danger">Waiting over a day</Badge>}
      </p>
      <p className="k-muted" style={{ margin: 0 }}>
        Reported by {concern.reportedBy.name ?? "a person"}
        {concern.reportedBy.email ? ` (${concern.reportedBy.email})` : ""}
        {concern.organization ? ` in ${concern.organization}` : ""} on {new Date(concern.createdAt).toLocaleDateString()}
        {wait ? ` · ${wait.text}` : ""}
        {concern.vendor ? (
          <>
            {" "}
            · about <Link href={`/app/vendors/${concern.vendor.id}`}>{concern.vendor.name ?? "a vendor"}</Link>
          </>
        ) : null}
      </p>
      <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{concern.details}</p>
      {decided ? (
        <Alert variant="info" title="What the reporter was told">
          {concern.resolution}
        </Alert>
      ) : (
        <>
          <ErrorSummary submit={submit} />
          {concern.status === "open" && (
            <div>
              <Button size="sm" variant="secondary" loading={submit.submitting} onClick={() => void move("reviewing")}>
                Start looking<span className="k-sr-only"> at {concern.subject}</span>
              </Button>
            </div>
          )}
          <TextAreaField label={`Outcome for the reporter of "${concern.subject}"`} hint="Required to decide. The reporter will read this. Keep internal findings in the vendor's internal notes, not here." rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} />
          <div className="k-row">
            <Button size="sm" loading={submit.submitting} disabled={resolution.trim() === ""} onClick={() => void move("resolved")}>
              Mark resolved<span className="k-sr-only">: {concern.subject}</span>
            </Button>
            <Button size="sm" variant="secondary" loading={submit.submitting} disabled={resolution.trim() === ""} onClick={() => void move("dismissed")}>
              Close without action<span className="k-sr-only">: {concern.subject}</span>
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

function TeamList({ view, onNotice }: { view: string; onNotice: (notice: string) => void }) {
  const loader = useCallback(() => api<{ data: TeamConcern[] }>(`/concerns?view=${view}`), [view]);
  const { state, reload } = useLoad(loader);
  if (state.status === "loading") return <Skeleton height="4rem" />;
  if (state.status === "error") return <Alert variant="danger">We could not load the reports.</Alert>;
  if (state.data.data.length === 0) return <EmptyState title="Nothing here">Reports waiting for a decision appear here.</EmptyState>;
  return (
    <ul className="k-stack k-stack-lg" style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {state.data.data.map((c) => (
        <TeamRow
          key={c.id}
          concern={c}
          onChanged={(notice) => {
            onNotice(notice);
            reload();
          }}
        />
      ))}
    </ul>
  );
}

function TeamPage() {
  const [view, setView] = useState("active");
  // A decided report leaves "needs a decision", so say what just happened instead of letting it silently vanish.
  const [notice, setNotice] = useState("");
  return (
    <div className="k-stack k-stack-lg">
      <div>
        <h1>Concerns</h1>
        <p className="k-muted">Reports from families, communities and vendors. Child-safety reports come first. If a child may be at risk, suspend the vendor first (a note is required), then investigate.</p>
      </div>
      <div style={{ maxWidth: "16rem" }}>
        <SelectField label="Show" value={view} onChange={(e) => setView(e.target.value)}>
          <option value="active">Needs a decision</option>
          <option value="resolved">Resolved</option>
          <option value="dismissed">Closed without action</option>
          <option value="all">Everything</option>
        </SelectField>
      </div>
      {notice && (
        <Alert variant="success" title="Done">
          {notice}
        </Alert>
      )}
      <Card>
        <TeamList key={view} view={view} onNotice={setNotice} />
      </Card>
    </div>
  );
}

export function ConcernsPage() {
  const { me, can, platformMode } = useSession();
  if (me.platformScope && can("concerns.manage")) return <TeamPage />;
  if (!me.platformScope && can("concerns.create")) return <ReportPage />;
  return (
    <div className="k-stack">
      <h1>Concerns</h1>
      {me.platformStaff && !platformMode ? (
        <PlatformModeGate>
          <span />
        </PlatformModeGate>
      ) : (
        <Alert variant="info" title="Choose where you are acting">
          Select your community or your business from the menu at the top to report a concern.
        </Alert>
      )}
    </div>
  );
}
