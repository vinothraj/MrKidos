import { ButtonLink, Card } from "@kidos/ui";
import type { Metadata } from "next";
import { FlowSteps, type FlowStep } from "@/components/flow-steps";
import { BRAND_NAME } from "@/lib/brand";

export const metadata: Metadata = { title: "How it works" };

const COMMUNITY_STEPS: FlowStep[] = [
  {
    art: "community",
    title: "Your community is set up",
    body: `Our team registers your community and names its administrators. You choose the rules that suit you, such as whether residents join with an invite code or ask to join.`,
    lines: [
      { who: "Us", text: "Register the community and make its administrators." },
      { who: "Admins", text: "Set the joining rules and create invite codes." },
    ],
  },
  {
    art: "family",
    title: "Residents join",
    body: "Residents join with a code you share, or ask to join and an administrator confirms they live there. You can suspend or remove a member at any time.",
    lines: [{ who: "Admins", text: "Approve, decline or remove members." }],
  },
  {
    art: "stepMatch",
    title: "You decide which providers are welcome",
    body: "Providers who serve your community appear to you for approval. Only approved providers are shown to your residents.",
    lines: [{ who: "Admins", text: "Approve or revoke providers for your community." }],
  },
];

const VENDOR_STEPS: FlowStep[] = [
  {
    art: "stepIdea",
    title: "Register and prove who you are",
    body: "Our team registers you. You upload your records: identity proof, a background check and the child-safety briefing. Our team checks them before you are shown.",
    lines: [{ who: "Us", text: "Verify every document. Nothing is shown until it is verified." }],
  },
  {
    art: "explore",
    title: "Describe what you offer",
    body: "Add your services with a clear price, how long they take, the ages they suit and your cancellation terms. Say which communities you serve and when you are free.",
    lines: [{ who: "You", text: "Publish offerings that families can find." }],
  },
  {
    art: "stepBook",
    title: "Answer requests and confirm bookings",
    body: "When a family wants something you offer, you get a clear summary with no family details. Send a quote, and confirm the date if the family chooses you.",
    lines: [
      { who: "You", text: "Send a quote or politely decline." },
      { who: "Us", text: "Set the date and place and keep a record." },
    ],
  },
];

export default function HowItWorksPage() {
  return (
    <div className="k-stack k-stack-lg">
      <div className="k-page-hero">
        <span className="k-eyebrow">How it works</span>
        <h1>Simple for families, clear for everyone</h1>
        <p className="k-hero-lead">
          {BRAND_NAME} connects families and communities with trusted providers, and keeps a person on your side at every step. Here is how it works for each of us.
        </p>
        <nav aria-label="On this page" className="k-row">
          <ButtonLink href="#families" variant="secondary" size="sm">
            Families
          </ButtonLink>
          <ButtonLink href="#communities" variant="secondary" size="sm">
            Communities
          </ButtonLink>
          <ButtonLink href="#vendors" variant="secondary" size="sm">
            Providers
          </ButtonLink>
        </nav>
      </div>

      <section id="families" className="k-section" aria-labelledby="families-title">
        <div className="k-section-head">
          <h2 id="families-title">For families</h2>
          <p>From an idea to a confirmed booking.</p>
        </div>
        <FlowSteps />
      </section>

      <section id="communities" className="k-band" aria-labelledby="communities-title">
        <div className="k-section-head">
          <h2 id="communities-title">For communities</h2>
          <p>Residents&apos; committees and managers stay in charge.</p>
        </div>
        <FlowSteps steps={COMMUNITY_STEPS} />
      </section>

      <section id="vendors" className="k-section" aria-labelledby="vendors-title">
        <div className="k-section-head">
          <h2 id="vendors-title">For providers</h2>
          <p>Reach families, send quotes and manage bookings without the back-and-forth.</p>
        </div>
        <FlowSteps steps={VENDOR_STEPS} />
      </section>

      <Card>
        <h2>Ready to begin?</h2>
        <p className="k-muted">Create an account in a minute. Providers and communities can get in touch and we will set you up.</p>
        <div className="k-row">
          <ButtonLink href="/register">Create your account</ButtonLink>
          <ButtonLink href="/contact" variant="secondary">
            Talk to us
          </ButtonLink>
        </div>
      </Card>
    </div>
  );
}
