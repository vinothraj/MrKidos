"use client";

import { Alert, Badge, Button, Card, EmptyState, PasswordField, Skeleton, TableWrap, TextField, type BadgeTone } from "@kidos/ui";
import QRCode from "qrcode";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import { useSession } from "@/lib/session";
import { useLoad } from "@/lib/use-load";

/* ------------------------------------------------------------------- MFA */

type Stage =
  | { kind: "idle" }
  | { kind: "enrolling"; secret: string; qr: string }
  | { kind: "codes"; codes: string[] };

function MfaPanel() {
  const { me, refresh } = useSession();
  const start = useSubmit();
  const confirm = useSubmit();
  const disable = useSubmit();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [disableForm, setDisableForm] = useState({ password: "", code: "" });
  const [copied, setCopied] = useState(false);

  async function onStart() {
    const res = await start.run(async () => {
      const r = await api<{ secret: string; otpauthUri: string }>("/auth/mfa/enroll/start", { method: "POST" });
      const qr = await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 192 });
      return { secret: r.secret, qr };
    });
    if (res) setStage({ kind: "enrolling", ...res });
  }

  async function onConfirm(e: FormEvent) {
    e.preventDefault();
    const res = await confirm.run(() =>
      api<{ recoveryCodes: string[] }>("/auth/mfa/enroll/confirm", { method: "POST", body: { code: code.replace(/\s+/gu, "") } }),
    );
    if (res) {
      setStage({ kind: "codes", codes: res.recoveryCodes });
      setCode("");
      await refresh();
    }
  }

  async function onDisable(e: FormEvent) {
    e.preventDefault();
    const ok = await disable.run(async () => {
      await api("/auth/mfa/disable", { method: "POST", body: { password: disableForm.password, code: disableForm.code.replace(/\s+/gu, "") } });
      return true;
    });
    if (ok) {
      setDisableForm({ password: "", code: "" });
      await refresh();
    }
  }

  async function copyCodes(codes: string[]) {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card>
      <div className="k-row" style={{ justifyContent: "space-between", marginBottom: "var(--k-space-2)" }}>
        <h2 style={{ margin: 0 }}>Two-step verification</h2>
        {me.mfaEnabled ? <Badge tone="success">On</Badge> : <Badge tone="warning">Off</Badge>}
      </div>
      <p className="k-muted">Adds a code from an authenticator app to your password, so a stolen password alone is not enough.</p>

      {stage.kind === "codes" && (
        <div className="k-stack">
          <Alert variant="success" title="Two-step verification is on">
            Save these recovery codes somewhere safe. Each works once if you lose your phone. They will not be shown again.
          </Alert>
          <ul className="k-mono" style={{ columns: "2 12rem", listStyle: "none", padding: 0, margin: 0 }} aria-label="Recovery codes">
            {stage.codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="k-row">
            <Button variant="secondary" onClick={() => void copyCodes(stage.codes)}>
              {copied ? "Copied" : "Copy codes"}
            </Button>
            <Button onClick={() => setStage({ kind: "idle" })}>I have saved them</Button>
          </div>
        </div>
      )}

      {stage.kind === "enrolling" && (
        <form onSubmit={onConfirm} className="k-stack" noValidate>
          <ol>
            <li>Open an authenticator app (such as Google Authenticator, Microsoft Authenticator or 1Password).</li>
            <li>Scan this code, or type the setup key by hand.</li>
            <li>Enter the 6-digit code the app shows.</li>
          </ol>
          <img src={stage.qr} width={192} height={192} alt="QR code for adding this account to your authenticator app" />
          <p>
            Setup key: <span className="k-mono">{stage.secret}</span>
          </p>
          <ErrorSummary submit={confirm} />
          <TextField
            label="6-digit code"
            name="code"
            autoComplete="one-time-code"
            inputMode="numeric"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            error={confirm.error?.fields["code"]}
          />
          <div className="k-row">
            <Button type="submit" loading={confirm.submitting}>
              Turn on
            </Button>
            <Button variant="ghost" onClick={() => setStage({ kind: "idle" })}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {stage.kind === "idle" && !me.mfaEnabled && (
        <div className="k-stack">
          <ErrorSummary submit={start} />
          <div>
            <Button onClick={() => void onStart()} loading={start.submitting}>
              Set up two-step verification
            </Button>
          </div>
        </div>
      )}

      {stage.kind === "idle" && me.mfaEnabled && (
        <form onSubmit={onDisable} className="k-stack" noValidate>
          <h3>Turn off</h3>
          <ErrorSummary submit={disable} />
          <PasswordField
            label="Password"
            name="password"
            autoComplete="current-password"
            required
            value={disableForm.password}
            onChange={(e) => setDisableForm((f) => ({ ...f, password: e.target.value }))}
            error={disable.error?.fields["password"]}
          />
          <TextField
            label="Current 6-digit code"
            name="code"
            autoComplete="one-time-code"
            inputMode="numeric"
            required
            value={disableForm.code}
            onChange={(e) => setDisableForm((f) => ({ ...f, code: e.target.value }))}
            error={disable.error?.fields["code"]}
          />
          <div>
            <Button type="submit" variant="danger" loading={disable.submitting}>
              Turn off two-step verification
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------- password */

function PasswordPanel() {
  const submit = useSubmit();
  const [form, setForm] = useState({ currentPassword: "", newPassword: "" });
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setDone(false);
    const ok = await submit.run(async () => {
      await api("/auth/password/change", { method: "POST", body: form });
      return true;
    });
    if (ok) {
      setDone(true);
      setForm({ currentPassword: "", newPassword: "" });
    }
  }

  return (
    <Card>
      <h2>Change password</h2>
      <form onSubmit={onSubmit} className="k-stack" noValidate>
        {done && (
          <Alert variant="success" title="Password changed">
            You stay signed in here. Other devices were signed out.
          </Alert>
        )}
        <ErrorSummary submit={submit} />
        <PasswordField
          label="Current password"
          name="currentPassword"
          autoComplete="current-password"
          required
          value={form.currentPassword}
          onChange={(e) => setForm((f) => ({ ...f, currentPassword: e.target.value }))}
          error={submit.error?.fields["currentPassword"]}
        />
        <PasswordField
          label="New password"
          name="newPassword"
          autoComplete="new-password"
          required
          showStrength
          hint="At least 12 characters."
          value={form.newPassword}
          onChange={(e) => setForm((f) => ({ ...f, newPassword: e.target.value }))}
          error={submit.error?.fields["newPassword"]}
        />
        <div>
          <Button type="submit" loading={submit.submitting}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* -------------------------------------------------------------- sessions */

interface SessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  current: boolean;
}

async function fetchSessions(): Promise<SessionRow[] | null> {
  try {
    return (await api<{ data: SessionRow[] }>("/me/sessions")).data;
  } catch {
    return null;
  }
}

function SessionsPanel() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [signedOut, setSignedOut] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    void fetchSessions().then((r) => {
      if (!active) return;
      if (r) setRows(r);
      else setFailed(true);
    });
    return () => {
      active = false;
    };
  }, []);

  async function revoke(id: string) {
    setRevoking(id);
    try {
      await api(`/me/sessions/${id}`, { method: "DELETE" });
      const r = await fetchSessions();
      if (r) setRows(r);
      else setFailed(true);
    } finally {
      setRevoking(null);
    }
  }

  async function revokeOthers() {
    setRevoking("others");
    try {
      const res = await api<{ signedOut: number }>("/me/sessions/revoke-others", { method: "POST" });
      setSignedOut(res.signedOut);
      setConfirmAll(false);
      const r = await fetchSessions();
      if (r) setRows(r);
      else setFailed(true);
    } finally {
      setRevoking(null);
    }
  }

  const others = rows?.filter((s) => !s.current).length ?? 0;
  return (
    <Card>
      <h2>Where you are signed in</h2>
      <p className="k-muted">If you see a device you do not recognise, sign it out and change your password.</p>
      {signedOut !== null && (
        <Alert variant="success">{signedOut === 1 ? "1 other device was signed out." : `${signedOut} other devices were signed out.`} This device is still signed in.</Alert>
      )}
      {others > 0 &&
        (confirmAll ? (
          <Alert variant="warning" title="Sign out all other devices?">
            <p>Every other phone, tablet and computer will need your password (and two-step code) again. This device stays signed in.</p>
            <div className="k-row">
              <Button size="sm" loading={revoking === "others"} onClick={() => void revokeOthers()}>
                Yes, sign them out
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmAll(false)}>
                Keep them signed in
              </Button>
            </div>
          </Alert>
        ) : (
          <div className="k-row">
            <Button size="sm" variant="secondary" onClick={() => setConfirmAll(true)}>
              Sign out all other devices
            </Button>
          </div>
        ))}
      {failed && <Alert variant="danger">We could not load your sessions. Refresh the page to try again.</Alert>}
      {!failed && rows === null && <Skeleton height="3rem" />}
      {rows && rows.length === 0 && <EmptyState title="No active sessions" />}
      {rows && rows.length > 0 && (
        <ul className="k-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {rows.map((s) => (
            <li key={s.id} className="k-row" style={{ justifyContent: "space-between" }}>
              <div>
                <strong>{s.userAgent ? s.userAgent.slice(0, 60) : "Unknown device"}</strong>{" "}
                {s.current && <Badge tone="success">This device</Badge>}
                <div className="k-muted">Last active {new Date(s.lastSeenAt).toLocaleString()}</div>
              </div>
              {!s.current && (
                <Button size="sm" variant="secondary" loading={revoking === s.id} onClick={() => void revoke(s.id)}>
                  Sign out
                  <span className="k-sr-only"> this device</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------- recent sign-ins */

interface SignIn {
  signedInAt: string;
  lastSeenAt: string;
  device: string | null;
  state: "this_device" | "active" | "signed_out" | "expired";
}
const SIGN_IN_STATE: Record<SignIn["state"], { tone: BadgeTone; label: string }> = {
  this_device: { tone: "success", label: "This device" },
  active: { tone: "info", label: "Still signed in" },
  signed_out: { tone: "neutral", label: "Signed out" },
  expired: { tone: "neutral", label: "Ended" },
};

function RecentSignIns() {
  const loader = useCallback(() => api<{ data: SignIn[] }>("/me/sign-ins"), []);
  const { state } = useLoad(loader);
  return (
    <Card>
      <h2>Recent sign-ins</h2>
      <p className="k-muted">Every time your account was signed in during the last 30 days. Only you can see this.</p>
      {state.status === "loading" && <Skeleton height="3rem" />}
      {state.status === "error" && <Alert variant="danger">We could not load your sign-ins. Refresh the page to try again.</Alert>}
      {state.status === "ready" && state.data.data.length === 0 && <p className="k-muted">No sign-ins in the last 30 days.</p>}
      {state.status === "ready" && state.data.data.length > 0 && (
        <TableWrap label="Recent sign-ins">
          <table className="k-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Device</th>
                <th scope="col">Now</th>
              </tr>
            </thead>
            <tbody>
              {state.data.data.map((s) => (
                <tr key={s.signedInAt}>
                  <td>{new Date(s.signedInAt).toLocaleString()}</td>
                  <td>{s.device ?? "Unknown device"}</td>
                  <td>
                    <Badge tone={SIGN_IN_STATE[s.state].tone}>{SIGN_IN_STATE[s.state].label}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

export function SecurityPage() {
  return (
    <div className="k-stack k-stack-lg">
      <div>
        <h1>Security</h1>
        <p className="k-muted">Keep your account safe: two-step verification, your password, and where you are signed in.</p>
      </div>
      <MfaPanel />
      <PasswordPanel />
      <SessionsPanel />
      <RecentSignIns />
    </div>
  );
}
