"use client";

import { Alert, Badge, Button, Card, EmptyState, SelectField, Skeleton, TextAreaField, TextField, type BadgeTone } from "@kidos/ui";
import { useCallback, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import { useSession } from "@/lib/session";
import { useLoad } from "@/lib/use-load";
import { FacilitiesSection, PoliciesSection } from "./community-config";
import { InviteCodesSection, MembersSection } from "./community-members";

export interface Community {
  id: string;
  name: string;
  status: "draft" | "verification" | "active" | "suspended";
  communityType: string | null;
  description: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  locality: string | null;
  unitCount: number | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  population: number | null;
  internalNotes: string | null;
  transitions: { to: Community["status"]; noteRequired: boolean; blockers: string[] }[];
}

export const STATUS_LABEL: Record<Community["status"], { label: string; tone: BadgeTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  verification: { label: "In verification", tone: "info" },
  active: { label: "Active", tone: "success" },
  suspended: { label: "Suspended", tone: "danger" },
};

const TYPE_LABEL: Record<string, string> = {
  gated_community: "Gated community",
  apartment_complex: "Apartment complex",
  township: "Township",
  other: "Other",
};

const blank = (v: string): string | null => (v.trim() === "" ? null : v.trim());
const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

/* ------------------------------------------------------------------ profile */

export function ProfileForm({ community, onSaved }: { community: Community; onSaved: () => void }) {
  const { me } = useSession();
  const submit = useSubmit();
  const [saved, setSaved] = useState(false);
  const [f, setF] = useState({
    name: community.name,
    communityType: community.communityType ?? "gated_community",
    description: community.description ?? "",
    country: community.country ?? "",
    state: community.state ?? "",
    city: community.city ?? "",
    locality: community.locality ?? "",
    unitCount: community.unitCount?.toString() ?? "",
    address: community.address ?? "",
    latitude: community.latitude?.toString() ?? "",
    longitude: community.longitude?.toString() ?? "",
    contactName: community.contactName ?? "",
    contactEmail: community.contactEmail ?? "",
    contactPhone: community.contactPhone ?? "",
    population: community.population?.toString() ?? "",
    internalNotes: community.internalNotes ?? "",
  });
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF((cur) => ({ ...cur, [key]: e.target.value }));
  const err = submit.error?.fields ?? {};

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const body = {
      name: f.name.trim(),
      communityType: f.communityType,
      description: blank(f.description),
      country: blank(f.country),
      state: blank(f.state),
      city: blank(f.city),
      locality: blank(f.locality),
      unitCount: num(f.unitCount),
      address: blank(f.address),
      latitude: num(f.latitude),
      longitude: num(f.longitude),
      contactName: blank(f.contactName),
      contactEmail: blank(f.contactEmail),
      contactPhone: blank(f.contactPhone),
      population: num(f.population),
      // Internal notes belong to the platform team: the API refuses them from anyone else, so they are not even sent.
      ...(me.platformScope ? { internalNotes: blank(f.internalNotes) } : {}),
    };
    const res = await submit.run(() => api(`/communities/${community.id}`, { method: "PATCH", body }));
    if (res) {
      setSaved(true);
      onSaved();
    }
  }

  return (
    <form onSubmit={onSubmit} className="k-stack" noValidate aria-label="Community details">
      {saved && <Alert variant="success">Details saved.</Alert>}
      <ErrorSummary submit={submit} />
      <TextField label="Community name" required value={f.name} onChange={set("name")} error={err["name"]} />
      <SelectField label="Type" value={f.communityType} onChange={set("communityType")} error={err["communityType"]}>
        {Object.entries(TYPE_LABEL).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </SelectField>
      <TextAreaField label="About the community" hint="Shown to residents when they search for their community." rows={3} value={f.description} onChange={set("description")} error={err["description"]} />
      <div className="k-grid">
        <TextField label="Country" value={f.country} onChange={set("country")} error={err["country"]} />
        <TextField label="State" value={f.state} onChange={set("state")} error={err["state"]} />
        <TextField label="City" value={f.city} onChange={set("city")} error={err["city"]} />
        <TextField label="Locality or area" value={f.locality} onChange={set("locality")} error={err["locality"]} />
        <TextField label="Number of homes (units)" type="number" inputMode="numeric" min={1} value={f.unitCount} onChange={set("unitCount")} error={err["unitCount"]} />
        <TextField label="Approximate residents" type="number" inputMode="numeric" min={0} value={f.population} onChange={set("population")} error={err["population"]} />
      </div>
      <h3>Private details</h3>
      <p className="k-muted">Only this community&rsquo;s administrators and the platform team can see these.</p>
      <TextField label="Street address" value={f.address} onChange={set("address")} error={err["address"]} />
      <div className="k-grid">
        <TextField label="Latitude" type="number" step="any" value={f.latitude} onChange={set("latitude")} error={err["latitude"]} />
        <TextField label="Longitude" type="number" step="any" value={f.longitude} onChange={set("longitude")} error={err["longitude"]} />
        <TextField label="Contact person" value={f.contactName} onChange={set("contactName")} error={err["contactName"]} />
        <TextField label="Contact email" type="email" value={f.contactEmail} onChange={set("contactEmail")} error={err["contactEmail"]} />
        <TextField label="Contact phone" type="tel" value={f.contactPhone} onChange={set("contactPhone")} error={err["contactPhone"]} />
      </div>
      {me.platformScope && (
        <TextAreaField
          label="Platform team notes"
          hint="Visible to the platform team only. The community's administrators cannot see these."
          rows={3}
          value={f.internalNotes}
          onChange={set("internalNotes")}
          error={err["internalNotes"]}
        />
      )}
      <div>
        <Button type="submit" loading={submit.submitting}>
          Save details
        </Button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------- status workflow */

const ACTION_LABEL = (from: Community["status"], to: Community["status"]): string => {
  if (to === "verification") return "Submit for verification";
  if (to === "draft") return "Send back for changes";
  if (to === "suspended") return "Suspend community";
  return from === "suspended" ? "Reinstate community" : "Approve and activate";
};

function StatusPanel({ community, onChanged }: { community: Community; onChanged: () => void }) {
  const submit = useSubmit();
  const [note, setNote] = useState("");
  const historyLoader = useCallback(() => api<{ data: { id: string; from: string | null; to: string; note: string | null; changedBy: string | null; at: string }[] }>(`/communities/${community.id}/history`), [community.id]);
  const history = useLoad(historyLoader);
  const status = STATUS_LABEL[community.status];

  async function go(to: Community["status"]) {
    const res = await submit.run(() => api(`/communities/${community.id}/transitions`, { method: "POST", body: { to, ...(note.trim() ? { note: note.trim() } : {}) } }));
    if (res) {
      setNote("");
      onChanged();
      history.reload();
    }
  }

  const needsNote = community.transitions.some((t) => t.noteRequired);
  return (
    <Card>
      <div className="k-row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Status</h2>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <p className="k-muted">
        {community.status === "draft" && "Complete the details, then submit the community for verification."}
        {community.status === "verification" && "Assign a community administrator, then an approver can activate the community."}
        {community.status === "active" && "Residents can find this community and join."}
        {community.status === "suspended" && "Residents cannot find or join this community while it is suspended."}
      </p>
      {community.transitions.length === 0 ? (
        <p className="k-muted">You do not have a step available for this community.</p>
      ) : (
        <div className="k-stack">
          <ErrorSummary submit={submit} />
          {community.transitions.map((t) =>
            t.blockers.length > 0 ? (
              <Alert key={t.to} variant="info" title={`Before you can ${ACTION_LABEL(community.status, t.to).toLowerCase()}`}>
                <ul>
                  {t.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </Alert>
            ) : null,
          )}
          {needsNote && <TextAreaField label="Note" hint="Recorded in the history. Required for this step." rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
          <div className="k-row">
            {community.transitions.map((t) => (
              <Button key={t.to} variant={t.to === "suspended" || t.to === "draft" ? "secondary" : "primary"} disabled={t.blockers.length > 0} loading={submit.submitting} onClick={() => void go(t.to)}>
                {ACTION_LABEL(community.status, t.to)}
              </Button>
            ))}
          </div>
        </div>
      )}
      {history.state.status === "ready" && history.state.data.data.length > 0 && (
        <>
          <h3 style={{ marginTop: "var(--k-space-5)" }}>History</h3>
          <ol style={{ paddingLeft: "var(--k-space-5)", margin: 0 }}>
            {history.state.data.data.map((h) => (
              <li key={h.id}>
                <strong>{h.from ? `${STATUS_LABEL[h.from as Community["status"]]?.label ?? h.from} → ` : ""}{STATUS_LABEL[h.to as Community["status"]]?.label ?? h.to}</strong>{" "}
                <span className="k-muted">
                  {new Date(h.at).toLocaleString()}
                  {h.changedBy ? ` · ${h.changedBy}` : ""}
                </span>
                {h.note && <div>{h.note}</div>}
              </li>
            ))}
          </ol>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ administrators */

interface Admin {
  userId: string;
  displayName: string;
  email: string;
}

/** `onChanged` refreshes the parent community, whose readiness checklist depends on how many administrators exist. */
function AdminsSection({ id, canAssign, onChanged }: { id: string; canAssign: boolean; onChanged: () => void }) {
  const loader = useCallback(() => api<{ data: Admin[] }>(`/communities/${id}/admins`), [id]);
  const { state, reload } = useLoad(loader);
  const submit = useSubmit();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const removal = useSubmit();

  async function add(e: FormEvent) {
    e.preventDefault();
    const res = await submit.run(() => api(`/communities/${id}/admins`, { method: "POST", body: { email } }));
    if (res) {
      setEmail("");
      reload();
      onChanged();
    }
  }
  async function remove(userId: string) {
    setBusy(userId);
    await removal.run(async () => {
      await api(`/communities/${id}/admins/${userId}`, { method: "DELETE" });
      reload();
      onChanged();
      return true;
    });
    setBusy(null);
  }

  return (
    <Card>
      <h2>Community administrators</h2>
      <p className="k-muted">Administrators approve residents, create invite codes and set the community&rsquo;s rules. Each must have an account and will need two-step verification.</p>
      <ErrorSummary submit={removal} />
      {state.status === "loading" && <Skeleton height="2.5rem" />}
      {state.status === "ready" && state.data.data.length === 0 && <EmptyState title="No administrators yet">Assign at least one before the community can be activated.</EmptyState>}
      {state.status === "ready" && state.data.data.length > 0 && (
        <ul className="k-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {state.data.data.map((a) => (
            <li key={a.userId} className="k-row" style={{ justifyContent: "space-between" }}>
              <div>
                <strong>{a.displayName}</strong>
                <div className="k-muted">{a.email}</div>
              </div>
              {canAssign && (
                <Button size="sm" variant="secondary" loading={busy === a.userId} onClick={() => void remove(a.userId)}>
                  Remove<span className="k-sr-only"> {a.displayName} as administrator</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canAssign && (
        <form onSubmit={add} className="k-stack" noValidate style={{ marginTop: "var(--k-space-4)" }}>
          <ErrorSummary submit={submit} />
          <TextField label="Add an administrator by email" type="email" name="adminEmail" autoComplete="off" hint="They need to have registered first." value={email} onChange={(e) => setEmail(e.target.value)} error={submit.error?.fields["email"]} />
          <div>
            <Button type="submit" variant="secondary" loading={submit.submitting}>
              Add administrator
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

/* --------------------------------------------------------------------- page */

const SECTIONS = [
  { id: "status", label: "Status" },
  { id: "details", label: "Details" },
  { id: "administrators", label: "Administrators" },
  { id: "facilities", label: "Facilities" },
  { id: "policies", label: "Policies" },
  { id: "invites", label: "Invite codes" },
  { id: "members", label: "Members" },
];

export function CommunityDetail({ id }: { id: string }) {
  const { can, me } = useSession();
  const loader = useCallback(() => api<Community>(`/communities/${id}`), [id]);
  const { state, reload } = useLoad(loader);

  if (state.status === "loading") return <Skeleton height="8rem" />;
  if (state.status === "error") {
    const notFound = state.error instanceof ApiError && state.error.status === 404;
    return (
      <Alert variant="danger" title={notFound ? "Community not found" : "We could not load this community"}>
        {notFound ? "It may not exist, or you may not have access to it." : "Please try again in a moment."}
      </Alert>
    );
  }
  const c = state.data;
  const status = STATUS_LABEL[c.status];
  // Section visibility mirrors the permissions the API enforces (the API remains the only enforcement point).
  const show = {
    members: can("memberships.approve"),
    facilities: true,
    policies: true,
    edit: can("communities.update"),
    assign: can("communities.assign_admin") && me.platformScope,
  };

  return (
    <div className="k-stack k-stack-lg">
      <div>
        <div className="k-row">
          <h1 style={{ margin: 0 }}>{c.name}</h1>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        <p className="k-muted">{[c.locality, c.city, c.state].filter(Boolean).join(", ") || "Location not set yet"}</p>
      </div>
      <nav aria-label="On this page">
        <ul className="k-section-nav">
          {SECTIONS.filter((s) => (s.id === "invites" || s.id === "members" ? show.members : true)).map((s) => (
            <li key={s.id}>
              <a className="k-btn k-btn-secondary k-btn-sm" href={`#${s.id}`}>
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <section id="status" aria-label="Status">
        <StatusPanel community={c} onChanged={reload} />
      </section>
      <section id="details" aria-labelledby="details-title">
        <Card>
          <h2 id="details-title">Details</h2>
          {show.edit ? <ProfileForm community={c} onSaved={reload} /> : <p className="k-muted">You can view but not change these details.</p>}
        </Card>
      </section>
      <section id="administrators" aria-label="Administrators">
        <AdminsSection id={id} canAssign={show.assign} onChanged={reload} />
      </section>
      <section id="facilities" aria-label="Facilities">
        <FacilitiesSection id={id} canManage={can("facilities.manage")} />
      </section>
      <section id="policies" aria-label="Policies">
        <PoliciesSection id={id} canManage={can("policies.manage")} />
      </section>
      {show.members && (
        <>
          <section id="invites" aria-label="Invite codes">
            <InviteCodesSection id={id} active={c.status === "active"} />
          </section>
          <section id="members" aria-label="Members">
            <MembersSection id={id} />
          </section>
        </>
      )}
    </div>
  );
}
