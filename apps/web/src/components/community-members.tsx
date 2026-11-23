"use client";

import { Alert, Badge, Button, Card, EmptyState, SelectField, Skeleton, TableWrap, TextField, type BadgeTone } from "@kidos/ui";
import { useCallback, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import { useLoad } from "@/lib/use-load";

/* -------------------------------------------------------------- invite codes */

interface InviteCode {
  id: string;
  label: string;
  hint: string;
  maxUses: number;
  uses: number;
  state: "active" | "expired" | "used_up" | "revoked";
  expiresAt: string | null;
}

const CODE_STATE: Record<InviteCode["state"], { label: string; tone: BadgeTone }> = {
  active: { label: "Active", tone: "success" },
  expired: { label: "Expired", tone: "warning" },
  used_up: { label: "All places used", tone: "warning" },
  revoked: { label: "Revoked", tone: "danger" },
};

export function InviteCodesSection({ id, active }: { id: string; active: boolean }) {
  const loader = useCallback(() => api<{ data: InviteCode[] }>(`/communities/${id}/invite-codes`), [id]);
  const { state, reload } = useLoad(loader);
  const create = useSubmit();
  const revoke = useSubmit();
  const [label, setLabel] = useState("");
  const [maxUses, setMaxUses] = useState("50");
  const [days, setDays] = useState("");
  const [fresh, setFresh] = useState<{ code: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFresh(null);
    setCopied(false);
    const res = await create.run(() =>
      api<{ code: string; label: string }>(`/communities/${id}/invite-codes`, {
        method: "POST",
        body: { label: label.trim(), maxUses: Number(maxUses), ...(days.trim() ? { expiresInDays: Number(days) } : {}) },
      }),
    );
    if (res) {
      setFresh({ code: res.code, label: res.label });
      setLabel("");
      reload();
    }
  }

  async function onRevoke(codeId: string) {
    const ok = await revoke.run(async () => {
      await api(`/communities/${id}/invite-codes/${codeId}`, { method: "DELETE" });
      return true;
    });
    if (ok) reload();
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card>
      <h2>Invite codes</h2>
      <p className="k-muted">Share a code with residents (a noticeboard, a WhatsApp group). Anyone who enters it joins straight away, so give each block or group its own code and limit the places.</p>
      {!active && <Alert variant="info">Invite codes can be created once the community is active.</Alert>}

      {fresh && (
        <Alert variant="success" title={`Code for “${fresh.label}” created`}>
          <p>Copy it now. For security it is shown only once.</p>
          <p>
            <span className="k-code" data-testid="new-invite-code">
              {fresh.code}
            </span>
          </p>
          <Button size="sm" variant="secondary" onClick={() => void copy(fresh.code)}>
            {copied ? "Copied" : "Copy code"}
          </Button>
        </Alert>
      )}

      {active && (
        <form onSubmit={onCreate} className="k-stack" noValidate aria-label="Create an invite code">
          <ErrorSummary submit={create} />
          <div className="k-grid">
            <TextField label="Label" required hint="Who is this code for? For example Block A." value={label} onChange={(e) => setLabel(e.target.value)} error={create.error?.fields["label"]} />
            <TextField label="Places" type="number" inputMode="numeric" min={1} max={10000} required value={maxUses} onChange={(e) => setMaxUses(e.target.value)} error={create.error?.fields["maxUses"]} />
            <TextField label="Expires after (days, optional)" type="number" inputMode="numeric" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} error={create.error?.fields["expiresInDays"]} />
          </div>
          <div>
            <Button type="submit" loading={create.submitting}>
              Create invite code
            </Button>
          </div>
        </form>
      )}

      <div style={{ marginTop: "var(--k-space-5)" }}>
        <ErrorSummary submit={revoke} />
        {state.status === "loading" && <Skeleton height="3rem" />}
        {state.status === "ready" && state.data.data.length === 0 && <EmptyState title="No invite codes yet" />}
        {state.status === "ready" && state.data.data.length > 0 && (
          <TableWrap label="Invite codes">
            <table className="k-table" aria-label="Invite codes">
              <thead>
                <tr>
                  <th scope="col">Label</th>
                  <th scope="col">Code</th>
                  <th scope="col">Used</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="k-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.data.data.map((c) => (
                  <tr key={c.id}>
                    <td>{c.label}</td>
                    <td className="k-mono">{c.hint}</td>
                    <td>
                      {c.uses} of {c.maxUses}
                    </td>
                    <td>
                      <Badge tone={CODE_STATE[c.state].tone}>{CODE_STATE[c.state].label}</Badge>
                    </td>
                    <td>
                      {c.state === "active" && (
                        <Button size="sm" variant="secondary" onClick={() => void onRevoke(c.id)}>
                          Revoke<span className="k-sr-only"> code {c.label}</span>
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ members */

interface Member {
  userId: string;
  displayName: string;
  email: string;
  status: "pending" | "active" | "suspended" | "removed";
  joinMethod: string | null;
  unitLabel: string | null;
  requestNote: string | null;
  roles: string[];
  requestedAt: string;
}

const MEMBER_STATUS: Record<Member["status"], { label: string; tone: BadgeTone }> = {
  pending: { label: "Waiting for approval", tone: "warning" },
  active: { label: "Member", tone: "success" },
  suspended: { label: "Suspended", tone: "danger" },
  removed: { label: "Removed", tone: "neutral" },
};

const ACTIONS: Record<Member["status"], { action: string; label: string; variant: "primary" | "secondary" | "ghost" }[]> = {
  pending: [
    { action: "approve", label: "Approve", variant: "primary" },
    { action: "reject", label: "Decline", variant: "secondary" },
  ],
  active: [
    { action: "suspend", label: "Suspend", variant: "secondary" },
    { action: "remove", label: "Remove", variant: "ghost" },
  ],
  suspended: [
    { action: "reinstate", label: "Reinstate", variant: "primary" },
    { action: "remove", label: "Remove", variant: "ghost" },
  ],
  removed: [],
};

export function MembersSection({ id }: { id: string }) {
  const [status, setStatus] = useState("pending");
  const loader = useCallback(() => api<{ data: Member[]; page: { nextCursor: string | null } }>(`/communities/${id}/members?limit=50${status ? `&status=${status}` : ""}`), [id, status]);
  const { state, reload } = useLoad(loader);
  const act = useSubmit();
  const [busy, setBusy] = useState<string | null>(null);

  async function run(userId: string, action: string) {
    setBusy(`${userId}:${action}`);
    const ok = await act.run(async () => {
      await api(`/communities/${id}/members/${userId}`, { method: "PATCH", body: { action } });
      return true;
    });
    setBusy(null);
    if (ok) reload();
  }

  return (
    <Card>
      <h2>Members</h2>
      <p className="k-muted">Residents who have joined, and people waiting for you to confirm they live here.</p>
      <SelectField label="Show" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="pending">Waiting for approval</option>
        <option value="active">Members</option>
        <option value="suspended">Suspended</option>
        <option value="removed">Removed or declined</option>
        <option value="">Everyone</option>
      </SelectField>
      <div style={{ marginTop: "var(--k-space-4)" }} aria-live="polite">
        <ErrorSummary submit={act} />
        {state.status === "loading" && <Skeleton height="3rem" />}
        {state.status === "error" && <Alert variant="danger">We could not load the members.</Alert>}
        {state.status === "ready" && state.data.data.length === 0 && <EmptyState title="Nobody here">{status === "pending" ? "There are no requests waiting." : "No members match this filter."}</EmptyState>}
        {state.status === "ready" && state.data.data.length > 0 && (
          <TableWrap label="Members">
            <table className="k-table" aria-label="Members">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Home</th>
                  <th scope="col">Status</th>
                  <th scope="col">Joined by</th>
                  <th scope="col">
                    <span className="k-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.data.data.map((m) => (
                  <tr key={m.userId}>
                    <td>
                      <strong>{m.displayName}</strong>
                      <div className="k-muted">{m.email}</div>
                      {m.requestNote && <div>“{m.requestNote}”</div>}
                    </td>
                    <td>{m.unitLabel ?? "—"}</td>
                    <td>
                      <Badge tone={MEMBER_STATUS[m.status].tone}>{MEMBER_STATUS[m.status].label}</Badge>
                      {m.roles.includes("community_admin") && (
                        <>
                          {" "}
                          <Badge tone="info">Administrator</Badge>
                        </>
                      )}
                    </td>
                    <td>{m.joinMethod === "invite_code" ? "Invite code" : m.joinMethod === "admin_approval" ? "Request" : m.joinMethod === "admin_added" ? "Added by admin" : "—"}</td>
                    <td>
                      <div className="k-row">
                        {ACTIONS[m.status].map((a) => (
                          <Button key={a.action} size="sm" variant={a.variant} loading={busy === `${m.userId}:${a.action}`} onClick={() => void run(m.userId, a.action)}>
                            {a.label}
                            <span className="k-sr-only"> {m.displayName}</span>
                          </Button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </div>
    </Card>
  );
}
