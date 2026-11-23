"use client";

import { Button, Card } from "@kidos/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Artwork } from "@/components/artwork";
import { api } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import type { PhotoSlot } from "@/lib/photos";

interface TourStep {
  as: string;
  email: string;
  open: string;
  title: string;
  what: string;
  look: string;
}
interface Journey {
  id: string;
  title: string;
  intro: string;
  art: PhotoSlot;
  steps: TourStep[];
}

const RESIDENT = { as: "Priya, a resident", email: "resident@dev.kidos.test" };
const OPS = { as: "Sam, platform super admin", email: "super-admin@dev.kidos.test" };
const VENDOR = { as: "Vikram, vendor owner", email: "vendor-owner@dev.kidos.test" };
const ADMIN = { as: "Chitra, community administrator", email: "community-admin@dev.kidos.test" };

const JOURNEYS: Journey[] = [
  {
    id: "family",
    title: "A family finds and books an activity",
    intro: "Follow one family from browsing to a confirmed booking. Five demo requests are already at different stages.",
    art: "family",
    steps: [
      { ...RESIDENT, open: "/app/catalog", title: "Browse what is available", what: "The catalog shows three approved offerings from Little Scientists (dev).", look: "Open an offering to see the price, ages, what is included and the cancellation terms. Save one with the heart." },
      { ...RESIDENT, open: "/app/requests", title: "Follow your requests", what: "Each request shows where it is, as a simple progress list.", look: "Five requests: a confirmed booking, quotes to choose from, waiting for a vendor, a question from the team, and one just sent." },
      { ...RESIDENT, open: "/app/requests", title: "Choose a quote", what: "Open 'Robotics classes for my daughter' and accept the offered option.", look: "The booking opens and the team arranges a date with the vendor." },
      { ...RESIDENT, open: "/app/family", title: "Add your children", what: "Only a nickname, a birth year and interests are kept, and only you see them.", look: "Try Download my family data and Erase all family data." },
    ],
  },
  {
    id: "team",
    title: "The operations team runs a request",
    intro: "A person reads each request, finds providers, compares quotes and confirms the booking.",
    art: "stepMatch",
    steps: [
      { ...OPS, open: "/app/requests", title: "Open the queue", what: "Choose Platform in the top selector first. The queue is sorted by who has waited longest.", look: "'Weekly chess club for beginners' has not been looked at yet. Take it and start the review." },
      { ...OPS, open: "/app/requests", title: "Find vendors and ask for quotes", what: "Open 'Stargazing evening for the building'. Matching has suggested Little Scientists.", look: "See the match reasons, send the inquiry, then offer the quotes to the family." },
    ],
  },
  {
    id: "vendor",
    title: "A provider answers and confirms",
    intro: "Vendors see only what they need to quote, never the family's details.",
    art: "stepBook",
    steps: [
      { ...VENDOR, open: "/app/inquiries", title: "Answer an inquiry", what: "Choose Little Scientists (dev) in the top selector. The stargazing inquiry is waiting for a quote.", look: "Send a quote with price lines, or decline with a reason." },
      { ...VENDOR, open: "/app/vendors", title: "Manage your business", what: "Your profile, offerings, availability, team and service areas.", look: "Edit an offering, set your weekly hours." },
    ],
  },
  {
    id: "community",
    title: "A community administrator looks after residents",
    intro: "Administrators decide who joins and which providers are welcome.",
    art: "community",
    steps: [
      { ...ADMIN, open: "/app/communities", title: "Your community", what: "Members, invite codes, facilities and policies for Sunrise Heights (dev).", look: "Create an invite code, then use it from the Join a community page as a new account." },
      { ...ADMIN, open: "/app/community-vendors", title: "Approve providers", what: "Little Scientists (dev) is approved. Residents see only approved providers.", look: "Try revoking and re-approving to see the catalog change for residents." },
    ],
  },
];

/**
 * Local development only: a guided tour of every flow. Each step signs in as the right person and opens the right page.
 * It lists nothing unless the dev API route exists, and the page that hosts it is not served by a production build.
 */
export function DemoTour() {
  const router = useRouter();
  const submit = useSubmit();
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    api("/dev/accounts").then(
      () => setReady(true),
      () => setReady(false),
    );
  }, []);

  if (ready === null) return <p className="k-muted">Loading the tour…</p>;
  if (!ready) return <p className="k-muted">The demo tour needs the development stack (corepack pnpm@9.15.0 run dev:stack).</p>;

  async function go(step: TourStep) {
    const res = await submit.run(() => api<{ ok: boolean }>("/dev/login", { method: "POST", body: { email: step.email } }));
    if (res) router.push(step.open);
  }

  return (
    <div className="k-stack k-stack-lg">
      <ErrorSummary submit={submit} />
      {JOURNEYS.map((j) => (
        <section key={j.id} aria-labelledby={`j-${j.id}`} className="k-band">
          <div className="k-feature">
            <Artwork slot={j.art} />
            <div>
              <h2 id={`j-${j.id}`}>{j.title}</h2>
              <p className="k-muted">{j.intro}</p>
            </div>
          </div>
          <ol className="k-stack k-demo-tour" style={{ padding: 0, marginTop: "var(--k-space-5)" }} aria-label={`Steps: ${j.title}`}>
            {j.steps.map((s, i) => (
              <li key={s.title}>
                <Card>
                  <span className="k-eyebrow">
                    Step {i + 1} · {s.as}
                  </span>
                  <h3>{s.title}</h3>
                  <p>{s.what}</p>
                  <p className="k-muted">What to look at: {s.look}</p>
                  <Button disabled={submit.submitting} onClick={() => void go(s)} aria-label={`Sign in and open: ${s.title}, as ${s.as}`}>
                    Sign in and open
                  </Button>
                </Card>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
