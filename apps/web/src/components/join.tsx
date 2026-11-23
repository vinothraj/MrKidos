"use client";

import { Alert, Badge, Button, Card, EmptyState, Skeleton, TextAreaField, TextField } from "@kidos/ui";
import { useCallback, useState, type FormEvent } from "react";
import { Artwork } from "@/components/artwork";
import { api, ApiError } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import { useSession } from "@/lib/session";
import { useLoad } from "@/lib/use-load";

interface Listed {
  id: string;
  name: string;
  city: string | null;
  locality: string | null;
}
interface PendingRequest {
  communityId: string;
  communityName: string;
  unitLabel: string | null;
  requestedAt: string;
}

/* ----------------------------------------------------------- join with a code */

function JoinWithCode({ onJoined }: { onJoined: () => void }) {
  const { refresh } = useSession();
  const submit = useSubmit();
  const [code, setCode] = useState("");
  const [unit, setUnit] = useState("");
  const [joined, setJoined] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setJoined(null);
    const res = await submit.run(() =>
      api<{ community: { id: string; name: string } }>("/communities/join", { method: "POST", body: { code, ...(unit.trim() ? { unitLabel: unit.trim() } : {}) } }),
    );
    if (res) {
      setJoined(res.community.name);
      setCode("");
      setUnit("");
      await refresh(); // the new community now appears in the header and the home page
      onJoined();
    }
  }

  return (
    <Card>
      <h2>I have an invite code</h2>
      <p className="k-muted">Your community administrator or committee can give you a code. It joins you straight away.</p>
      <form onSubmit={onSubmit} className="k-stack" noValidate>
        {joined && (
          <Alert variant="success" title={`Welcome to ${joined}`}>
            You are now a member.
          </Alert>
        )}
        <ErrorSummary submit={submit} />
        <TextField
          label="Invite code"
          name="code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
          hint="Letters and numbers, for example ABCDE-23456. Capitals and the dash do not matter."
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={submit.error?.fields["code"]}
        />
        <TextField label="Your home or unit (optional)" name="unit" autoComplete="off" hint="For example B-204. Only your community administrators see this." value={unit} onChange={(e) => setUnit(e.target.value)} error={submit.error?.fields["unitLabel"]} />
        <div>
          <Button type="submit" loading={submit.submitting}>
            Join community
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* ----------------------------------------------------------- find and request */

function RequestForm({ community, onDone, onCancel }: { community: Listed; onDone: () => void; onCancel: () => void }) {
  const submit = useSubmit();
  const [unit, setUnit] = useState("");
  const [note, setNote] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const res = await submit.run(() =>
      api(`/communities/${community.id}/join-requests`, { method: "POST", body: { unitLabel: unit, ...(note.trim() ? { note: note.trim() } : {}) } }),
    );
    // run() resolves to undefined only when it captured an error.
    if (res) onDone();
  }

  return (
    <form onSubmit={onSubmit} className="k-stack" noValidate aria-label={`Request to join ${community.name}`}>
      <ErrorSummary submit={submit} />
      <TextField label="Your home or unit" name="unit" required autoComplete="off" hint="For example B-204. Administrators use it to confirm you live here." value={unit} onChange={(e) => setUnit(e.target.value)} error={submit.error?.fields["unitLabel"]} />
      <TextAreaField label="A note for the administrator (optional)" name="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} error={submit.error?.fields["note"]} />
      <div className="k-row">
        <Button type="submit" loading={submit.submitting}>
          Send request
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function FindCommunity({ onRequested }: { onRequested: () => void }) {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const loader = useCallback(() => api<{ data: Listed[] }>(`/directory/communities?q=${encodeURIComponent(term)}`), [term]);
  const { state } = useLoad(loader);

  return (
    <Card>
      <h2>Find your community</h2>
      <p className="k-muted">Search for your community and ask to join. A community administrator will confirm you live there.</p>
      <form
        className="k-row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(q.trim());
          setOpen(null);
        }}
      >
        <div style={{ flex: "1 1 14rem" }}>
          <TextField label="Community name or area" name="q" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button type="submit" variant="secondary" style={{ alignSelf: "flex-end" }}>
          Search
        </Button>
      </form>

      <div style={{ marginTop: "var(--k-space-4)" }} aria-live="polite">
        {state.status === "loading" && <Skeleton height="3rem" />}
        {state.status === "error" && <Alert variant="danger">We could not load the list of communities. Please try again.</Alert>}
        {state.status === "ready" && state.data.data.length === 0 && (
          <EmptyState title="No communities found" art={<Artwork slot="community" />}>{term ? "Try a different name or area." : "No communities are open yet. We will let you know when yours is ready."}</EmptyState>
        )}
        {state.status === "ready" && state.data.data.length > 0 && (
          <ul className="k-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {state.data.data.map((c) => (
              <li key={c.id}>
                <Card>
                  <div className="k-row" style={{ justifyContent: "space-between" }}>
                    <div>
                      <h3 style={{ margin: 0 }}>{c.name}</h3>
                      <p className="k-muted" style={{ margin: 0 }}>
                        {[c.locality, c.city].filter(Boolean).join(", ") || "Location not set"}
                      </p>
                    </div>
                    {open !== c.id && (
                      <Button variant="secondary" onClick={() => setOpen(c.id)}>
                        Ask to join<span className="k-sr-only"> {c.name}</span>
                      </Button>
                    )}
                  </div>
                  {open === c.id && (
                    <div style={{ marginTop: "var(--k-space-4)" }}>
                      <RequestForm
                        community={c}
                        onCancel={() => setOpen(null)}
                        onDone={() => {
                          setOpen(null);
                          onRequested();
                        }}
                      />
                    </div>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- my requests */

function MyRequests({ version }: { version: number }) {
  const loader = useCallback(() => api<{ data: PendingRequest[] }>("/me/join-requests").then((r) => ({ ...r, version })), [version]);
  const { state, reload } = useLoad(loader);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function withdraw(id: string) {
    setBusy(id);
    setFailed(false);
    try {
      await api(`/me/join-requests/${id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) setFailed(true);
      reload();
    } finally {
      setBusy(null);
    }
  }

  if (state.status !== "ready" || state.data.data.length === 0) return null;
  return (
    <Card>
      <h2>Your requests</h2>
      {failed && <Alert variant="danger">We could not withdraw that request. Please try again.</Alert>}
      <ul className="k-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {state.data.data.map((r) => (
          <li key={r.communityId} className="k-row" style={{ justifyContent: "space-between" }}>
            <div>
              <strong>{r.communityName}</strong> <Badge tone="warning">Waiting for approval</Badge>
              <div className="k-muted">
                {r.unitLabel ? `${r.unitLabel} · ` : ""}Asked {new Date(r.requestedAt).toLocaleDateString()}
              </div>
            </div>
            <Button size="sm" variant="secondary" loading={busy === r.communityId} onClick={() => void withdraw(r.communityId)}>
              Withdraw<span className="k-sr-only"> request to join {r.communityName}</span>
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function JoinPage() {
  const [version, setVersion] = useState(0);
  const { me } = useSession();
  return (
    <div className="k-stack k-stack-lg">
      <div>
        <h1>Join a community</h1>
        <p className="k-muted">Joining your residential community unlocks experiences and services for your family.</p>
      </div>
      {!me.user.emailVerified && (
        <Alert variant="warning" title="Confirm your email address first">
          We need to know you are a real person before you join a community. Use the confirmation link we emailed you, or resend it from the home page.
        </Alert>
      )}
      <JoinWithCode onJoined={() => setVersion((v) => v + 1)} />
      <FindCommunity onRequested={() => setVersion((v) => v + 1)} />
      <MyRequests version={version} />
    </div>
  );
}
