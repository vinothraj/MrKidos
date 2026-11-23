"use client";

import { Alert, Button, Card, PasswordField, Spinner, TextField } from "@kidos/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Artwork } from "@/components/artwork";
import { DevQuickLogin } from "@/components/dev-login";
import { api } from "@/lib/api";
import { ErrorSummary, safeNext, useSubmit } from "@/lib/forms";
import type { PhotoSlot } from "@/lib/photos";

/**
 * Sign-in and registration pages. With a picture: a classic two-column page on wide screens (a full-height photo
 * beside the form) and the form alone on phones. The picture is decorative; the promises under the form are real text.
 */
function AuthCard({ title, intro, art, children }: { title: string; intro?: ReactNode; art?: PhotoSlot; children: ReactNode }) {
  if (!art) {
    return (
      <div className="k-auth-wrap">
        <Card>
          <h1>{title}</h1>
          {intro && <p className="k-muted">{intro}</p>}
          {children}
        </Card>
      </div>
    );
  }
  return (
    <div className="k-auth-split">
      <div className="k-auth-visual" aria-hidden="true">
        <Artwork slot={art} priority />
      </div>
      <div className="k-auth-panel">
        <Card>
          <h1>{title}</h1>
          {intro && <p className="k-muted">{intro}</p>}
          {children}
        </Card>
        <ul className="k-trust" aria-label="Our promises">
          <li>Every provider is checked before families see them</li>
          <li>Only you see your children&apos;s details</li>
          <li>Two-step verification keeps your account yours</li>
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ sign in */

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const submit = useSubmit();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const res = await submit.run(() => api<{ mfaRequired: boolean }>("/auth/login", { method: "POST", body: { email, password } }));
    if (!res) return;
    router.replace(res.mfaRequired ? "/login/mfa" : safeNext(params.get("next")));
  }

  return (
    <AuthCard title="Sign in" intro="Welcome back." art="mumAndChild">
      <form onSubmit={onSubmit} className="k-stack" noValidate>
        <ErrorSummary submit={submit} />
        <TextField label="Email" type="email" name="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={submit.error?.fields["email"]} />
        <PasswordField label="Password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} error={submit.error?.fields["password"]} />
        <Button type="submit" block loading={submit.submitting}>
          Sign in
        </Button>
      </form>
      <p style={{ marginTop: "var(--k-space-4)" }}>
        <Link href="/forgot-password">Forgot your password?</Link>
      </p>
      <p className="k-muted">
        New here? <Link href="/register">Create an account</Link>
      </p>
      <DevQuickLogin next={params.get("next")} />
    </AuthCard>
  );
}

/* ----------------------------------------------------------------- register */

export function RegisterForm() {
  const router = useRouter();
  const submit = useSubmit();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // The API answers 201 with the created user; run() resolves to undefined only when it captured an error.
    const created = await submit.run(() => api<{ user: { id: string } }>("/auth/register", { method: "POST", body: { email, password, displayName } }));
    if (created) router.replace("/app");
  }

  return (
    <AuthCard title="Create your account" intro="It takes a minute. We will email you a link to confirm your address." art="kids">
      <form onSubmit={onSubmit} className="k-stack" noValidate>
        <ErrorSummary submit={submit} />
        <TextField label="Your name" name="displayName" autoComplete="name" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} error={submit.error?.fields["displayName"]} />
        <TextField label="Email" type="email" name="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={submit.error?.fields["email"]} />
        <PasswordField
          label="Password"
          name="password"
          autoComplete="new-password"
          required
          showStrength
          hint="At least 12 characters. A passphrase of a few words works well."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={submit.error?.fields["password"]}
        />
        <Button type="submit" block loading={submit.submitting}>
          Create account
        </Button>
      </form>
      <p className="k-muted" style={{ marginTop: "var(--k-space-4)" }}>
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </AuthCard>
  );
}

/* ------------------------------------------------------------ MFA at sign-in */

export function MfaVerifyForm() {
  const router = useRouter();
  const submit = useSubmit();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, [useRecovery]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = useRecovery ? { recoveryCode: value } : { code: value.replace(/\s+/gu, "") };
    const res = await submit.run(() => api<{ ok: boolean }>("/auth/mfa/verify", { method: "POST", body }));
    if (res) router.replace("/app");
  }

  async function cancel() {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
    }
  }

  return (
    <AuthCard
      title="Two-step verification"
      intro={useRecovery ? "Enter one of the recovery codes you saved. Each code works once." : "Enter the 6-digit code from your authenticator app."}
    >
      <form onSubmit={onSubmit} className="k-stack" noValidate>
        <ErrorSummary submit={submit} />
        <TextField
          ref={input}
          label={useRecovery ? "Recovery code" : "Authentication code"}
          name={useRecovery ? "recoveryCode" : "code"}
          autoComplete="one-time-code"
          inputMode={useRecovery ? "text" : "numeric"}
          required
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={submit.error?.fields["code"] ?? submit.error?.fields["recoveryCode"]}
        />
        <Button type="submit" block loading={submit.submitting}>
          Verify
        </Button>
      </form>
      <div className="k-stack k-stack-sm" style={{ marginTop: "var(--k-space-4)" }}>
        <Button
          variant="ghost"
          onClick={() => {
            setUseRecovery((v) => !v);
            setValue("");
            submit.clear();
          }}
        >
          {useRecovery ? "Use my authenticator app instead" : "Use a recovery code instead"}
        </Button>
        <Button variant="ghost" onClick={() => void cancel()}>
          Cancel and sign out
        </Button>
      </div>
    </AuthCard>
  );
}

/* ----------------------------------------------------------- password reset */

export function ForgotPasswordForm() {
  const submit = useSubmit();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const res = await submit.run(() => api<{ ok: boolean }>("/auth/password/forgot", { method: "POST", body: { email } }));
    if (res) setSent(true);
  }

  if (sent) {
    return (
      <AuthCard title="Check your email">
        <Alert variant="success">
          If an account exists for <strong>{email}</strong>, we have sent a link to reset the password. It is valid for one hour.
        </Alert>
        <p style={{ marginTop: "var(--k-space-4)" }}>
          <Link href="/login">Back to sign in</Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Reset your password" intro="Enter your email and we will send you a link to choose a new password.">
      <form onSubmit={onSubmit} className="k-stack" noValidate>
        <ErrorSummary submit={submit} />
        <TextField label="Email" type="email" name="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={submit.error?.fields["email"]} />
        <Button type="submit" block loading={submit.submitting}>
          Send reset link
        </Button>
      </form>
      <p style={{ marginTop: "var(--k-space-4)" }}>
        <Link href="/login">Back to sign in</Link>
      </p>
    </AuthCard>
  );
}

export function ResetPasswordForm() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const submit = useSubmit();
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await submit.run(async () => {
      await api("/auth/password/reset", { method: "POST", body: { token, password } });
      setDone(true);
    });
  }

  if (!token) {
    return (
      <AuthCard title="Reset link needed">
        <Alert variant="warning">This page needs the link from your email. Open the link again, or request a new one.</Alert>
        <p style={{ marginTop: "var(--k-space-4)" }}>
          <Link href="/forgot-password">Request a new link</Link>
        </p>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard title="Password updated">
        <Alert variant="success">Your password has been changed and you have been signed out everywhere.</Alert>
        <p style={{ marginTop: "var(--k-space-4)" }}>
          <Link href="/login">Sign in with your new password</Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password">
      <form onSubmit={onSubmit} className="k-stack" noValidate>
        <ErrorSummary submit={submit} />
        {submit.error && submit.error.summary.includes("invalid or has expired") && (
          <p>
            <Link href="/forgot-password">Request a new link</Link>
          </p>
        )}
        <PasswordField
          label="New password"
          name="password"
          autoComplete="new-password"
          required
          showStrength
          hint="At least 12 characters."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={submit.error?.fields["password"]}
        />
        <Button type="submit" block loading={submit.submitting}>
          Change password
        </Button>
      </form>
    </AuthCard>
  );
}

/* ---------------------------------------------------------- email verification */

type VerifyState = "working" | "done" | "failed" | "missing";

export function VerifyEmail() {
  const params = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState<VerifyState>(token ? "working" : "missing");
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return; // React strict mode runs effects twice; a token must be used once
    started.current = true;
    api("/auth/email/verify", { method: "POST", body: { token } })
      .then(() => setState("done"))
      .catch(() => setState("failed"));
  }, [token]);

  return (
    <AuthCard title="Confirm your email">
      <div aria-live="polite">
        {state === "working" && (
          <p>
            <Spinner label="Confirming your email" /> Confirming your email…
          </p>
        )}
        {state === "done" && (
          <>
            <Artwork slot="celebrate" className="k-step-art" />
            <Alert variant="success">Thank you. Your email address is confirmed.</Alert>
          </>
        )}
        {state === "failed" && (
          <Alert variant="danger" title="This link did not work">
            It may have expired or already been used. Sign in and choose &ldquo;Resend confirmation&rdquo; to get a new one.
          </Alert>
        )}
        {state === "missing" && <Alert variant="warning">This page needs the link from your confirmation email.</Alert>}
      </div>
      <p style={{ marginTop: "var(--k-space-4)" }}>
        <Link href="/app">Continue to your account</Link>
      </p>
    </AuthCard>
  );
}
