"use client";

import { Alert, Badge, Button, Card, CheckboxField, EmptyState, SelectField, Skeleton, TextField } from "@kidos/ui";
import { useCallback, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import { useLoad } from "@/lib/use-load";

/* --------------------------------------------------------------- facilities */

interface Facility {
  id: string;
  name: string;
  kind: string;
  capacity: number | null;
  description: string | null;
  bookable: boolean;
}

const KINDS: Record<string, string> = {
  clubhouse: "Clubhouse",
  hall: "Hall",
  ground: "Ground or field",
  court: "Court",
  pool: "Swimming pool",
  garden: "Garden",
  amphitheatre: "Amphitheatre",
  other: "Other",
};

function FacilityForm({ communityId, initial, onDone, onCancel }: { communityId: string; initial?: Facility; onDone: () => void; onCancel?: () => void }) {
  const submit = useSubmit();
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState(initial?.kind ?? "clubhouse");
  const [capacity, setCapacity] = useState(initial?.capacity?.toString() ?? "");
  const [bookable, setBookable] = useState(initial?.bookable ?? true);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = { name: name.trim(), kind, capacity: capacity.trim() === "" ? null : Number(capacity), bookable };
    const res = await submit.run(() =>
      initial ? api(`/communities/${communityId}/facilities/${initial.id}`, { method: "PATCH", body }) : api(`/communities/${communityId}/facilities`, { method: "POST", body }),
    );
    if (res) {
      if (!initial) {
        setName("");
        setCapacity("");
      }
      onDone();
    }
  }
  const err = submit.error?.fields ?? {};
  return (
    <form onSubmit={onSubmit} className="k-stack" noValidate aria-label={initial ? `Edit ${initial.name}` : "Add a facility"}>
      <ErrorSummary submit={submit} />
      <div className="k-grid">
        <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} error={err["name"]} />
        <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} error={err["kind"]}>
          {Object.entries(KINDS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </SelectField>
        <TextField label="Capacity (people)" type="number" inputMode="numeric" min={0} value={capacity} onChange={(e) => setCapacity(e.target.value)} error={err["capacity"]} />
      </div>
      <CheckboxField label="Can be booked for events" checked={bookable} onChange={(e) => setBookable(e.target.checked)} />
      <div className="k-row">
        <Button type="submit" loading={submit.submitting}>
          {initial ? "Save facility" : "Add facility"}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

export function FacilitiesSection({ id, canManage }: { id: string; canManage: boolean }) {
  const loader = useCallback(() => api<{ data: Facility[] }>(`/communities/${id}/facilities`), [id]);
  const { state, reload } = useLoad(loader);
  const [editing, setEditing] = useState<string | null>(null);
  const removal = useSubmit();

  async function remove(facilityId: string) {
    const ok = await removal.run(async () => {
      await api(`/communities/${id}/facilities/${facilityId}`, { method: "DELETE" });
      return true;
    });
    if (ok) reload();
  }

  return (
    <Card>
      <h2>Facilities and venues</h2>
      <p className="k-muted">Places where events and activities can happen, such as the clubhouse or the play area.</p>
      <ErrorSummary submit={removal} />
      {state.status === "loading" && <Skeleton height="3rem" />}
      {state.status === "ready" && state.data.data.length === 0 && <EmptyState title="No facilities listed yet">Add the venues residents and providers can use.</EmptyState>}
      {state.status === "ready" && state.data.data.length > 0 && (
        <ul className="k-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {state.data.data.map((f) => (
            <li key={f.id}>
              {editing === f.id ? (
                <FacilityForm
                  communityId={id}
                  initial={f}
                  onCancel={() => setEditing(null)}
                  onDone={() => {
                    setEditing(null);
                    reload();
                  }}
                />
              ) : (
                <div className="k-row" style={{ justifyContent: "space-between" }}>
                  <div>
                    <strong>{f.name}</strong> <Badge>{KINDS[f.kind] ?? f.kind}</Badge> {!f.bookable && <Badge tone="warning">Not bookable</Badge>}
                    <div className="k-muted">{f.capacity !== null ? `Capacity ${f.capacity}` : "Capacity not set"}</div>
                  </div>
                  {canManage && (
                    <div className="k-row">
                      <Button size="sm" variant="secondary" onClick={() => setEditing(f.id)}>
                        Edit<span className="k-sr-only"> {f.name}</span>
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void remove(f.id)}>
                        Delete<span className="k-sr-only"> {f.name}</span>
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <div style={{ marginTop: "var(--k-space-5)" }}>
          <h3>Add a facility</h3>
          <FacilityForm communityId={id} onDone={reload} />
        </div>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------- policies */

interface Policy {
  key: string;
  label: string;
  description: string;
  valueType: "boolean" | "text" | "enum";
  category?: "general" | "security";
  allowed: string[] | null;
  value: unknown;
  isDefault: boolean;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

const ENUM_LABEL: Record<string, string> = {
  admin_approval: "Residents can ask to join, and an administrator approves them",
  invite_code_only: "Residents need an invite code",
  none: "No limit (the person creating a code decides)",
  "7": "7 days",
  "30": "30 days",
  "90": "90 days",
};

/** What a security change will do, said before it happens (the confirm step). */
function consequence(policy: Policy, value: unknown): string {
  if (policy.key === "require_two_step_all_members") {
    return value === true
      ? "Every member who has not set up two-step verification will be asked to do it before they can continue in this community. Tell your residents first."
      : "Residents will no longer need two-step verification here. Administrators and other roles that require it still do.";
  }
  if (policy.key === "invite_code_max_days") {
    return value === "none"
      ? "New invite codes can last as long as the person creating them chooses, or never expire."
      : `New invite codes will stop working after at most ${String(value)} days. Codes you already shared keep their dates.`;
  }
  return "This changes how the community works for every member.";
}

function PolicyRow({ communityId, policy, canManage, onSaved }: { communityId: string; policy: Policy; canManage: boolean; onSaved: () => void }) {
  const submit = useSubmit();
  const [value, setValue] = useState<unknown>(policy.value);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const dirty = JSON.stringify(value) !== JSON.stringify(policy.value);
  const sensitive = policy.category === "security";

  async function commit() {
    setSaved(false);
    const res = await submit.run(() => api(`/communities/${communityId}/policies/${policy.key}`, { method: "PUT", body: { value } }));
    setConfirming(false);
    if (res) {
      setSaved(true);
      onSaved();
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (sensitive && !confirming) {
      setConfirming(true); // security settings are confirmed before they take effect
      return;
    }
    void commit();
  }

  const change = (v: unknown) => {
    setValue(v);
    setConfirming(false);
  };

  return (
    <form onSubmit={save} className="k-stack k-stack-sm" noValidate aria-label={policy.label}>
      {policy.valueType === "boolean" && (
        <CheckboxField label={policy.label} hint={policy.description} checked={value === true} disabled={!canManage} onChange={(e) => change(e.target.checked)} />
      )}
      {policy.valueType === "enum" && (
        <SelectField label={policy.label} hint={policy.description} value={String(value)} disabled={!canManage} onChange={(e) => change(e.target.value)}>
          {(policy.allowed ?? []).map((a) => (
            <option key={a} value={a}>
              {ENUM_LABEL[a] ?? a}
            </option>
          ))}
        </SelectField>
      )}
      {policy.valueType === "text" && (
        <TextField label={policy.label} hint={policy.description} value={String(value ?? "")} disabled={!canManage} onChange={(e) => change(e.target.value)} />
      )}
      <ErrorSummary submit={submit} />
      {confirming && (
        <Alert variant="warning" title="Please confirm this change">
          <p>{consequence(policy, value)}</p>
          <div className="k-row">
            <Button type="submit" size="sm" loading={submit.submitting}>
              Yes, change it<span className="k-sr-only"> ({policy.label})</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => change(policy.value)}>
              Keep it as it was
            </Button>
          </div>
        </Alert>
      )}
      {canManage && !confirming && (
        <div className="k-row">
          <Button type="submit" size="sm" variant="secondary" disabled={!dirty} loading={submit.submitting}>
            Save<span className="k-sr-only"> {policy.label}</span>
          </Button>
          {saved && !dirty && <span role="status">Saved</span>}
          {policy.isDefault && !dirty && !saved && <span className="k-muted">Using the default</span>}
        </div>
      )}
      {!policy.isDefault && policy.updatedAt && (
        <span className="k-hint">
          Last changed{policy.updatedBy ? ` by ${policy.updatedBy}` : ""} on {new Date(policy.updatedAt).toLocaleDateString()}.
        </span>
      )}
    </form>
  );
}

export function PoliciesSection({ id, canManage, category = "general" }: { id: string; canManage: boolean; category?: "general" | "security" }) {
  const loader = useCallback(() => api<{ data: Policy[] }>(`/communities/${id}/policies`), [id]);
  const { state, reload } = useLoad(loader);
  const security = category === "security";
  return (
    <Card>
      <h2>{security ? "Community security" : "Community policies"}</h2>
      <p className="k-muted">
        {security
          ? "Protections for everyone in this community. Each change asks you to confirm and is recorded in the audit log."
          : "Rules that decide how this community works on the platform. Security settings are under Settings."}
      </p>
      {state.status === "loading" && <Skeleton height="4rem" />}
      {state.status === "error" && <Alert variant="danger">We could not load the policies.</Alert>}
      {state.status === "ready" && (
        <div className="k-stack k-stack-lg">
          {state.data.data
            .filter((p) => (p.category ?? "general") === category)
            .map((p) => (
              // Keyed by identity, not value: a value-based key would rebuild the row on save and erase its "Saved" confirmation.
              <PolicyRow key={p.key} communityId={id} policy={p} canManage={canManage} onSaved={reload} />
            ))}
        </div>
      )}
    </Card>
  );
}
