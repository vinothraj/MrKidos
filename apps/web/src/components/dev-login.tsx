"use client";

import { Button, Card } from "@kidos/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ErrorSummary, safeNext, useSubmit } from "@/lib/forms";

interface DevAccount {
  key: string;
  email: string;
  displayName: string;
  label: string;
  description: string;
  scope: "platform" | "community" | "vendor";
}
interface DevAccounts {
  password: string;
  accounts: DevAccount[];
}

const GROUPS: { scope: DevAccount["scope"]; title: string }[] = [
  { scope: "platform", title: "Platform team" },
  { scope: "community", title: "Community" },
  { scope: "vendor", title: "Vendor" },
];

/**
 * Local development only. Lists the seeded accounts (one per role) and signs in as one with a single click.
 * It renders nothing unless the API has the development route, which only `dev:stack` registers, and never in a production build.
 */
export function DevQuickLogin({ next }: { next: string | null }) {
  const router = useRouter();
  const submit = useSubmit();
  const [data, setData] = useState<DevAccounts | null>(null);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    api<DevAccounts>("/dev/accounts").then(setData, () => setData(null));
  }, []);

  if (!data) return null;

  async function signInAs(email: string) {
    const res = await submit.run(() => api<{ ok: boolean }>("/dev/login", { method: "POST", body: { email } }));
    if (res) router.replace(safeNext(next));
  }

  return (
    <Card className="k-dev-login">
      <h2>Development quick sign-in</h2>
      <p className="k-muted">
        Local development only. One click signs you in as that role. To use the normal form instead, the password for all of these accounts is{" "}
        <code>{data.password}</code>. <Link href="/demo">Take the guided demo tour</Link> to try every flow step by step.
      </p>
      <ErrorSummary submit={submit} />
      {GROUPS.map((g) => (
        <section key={g.scope} aria-label={g.title} className="k-stack">
          <h3>{g.title}</h3>
          <ul className="k-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {data.accounts
              .filter((a) => a.scope === g.scope)
              .map((a) => (
                <li key={a.key}>
                  <Button variant="secondary" block disabled={submit.submitting} onClick={() => void signInAs(a.email)} aria-label={`Sign in as ${a.label}`}>
                    {a.label}
                  </Button>
                  <p className="k-muted" style={{ margin: "var(--k-space-1) 0 0" }}>
                    {a.description} <span lang="en">{a.email}</span>
                  </p>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </Card>
  );
}
