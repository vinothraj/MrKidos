import { ButtonLink, Card } from "@kidos/ui";
import Link from "next/link";
import { Artwork } from "@/components/artwork";
import { FlowSteps, JOURNEY } from "@/components/flow-steps";
import { JourneyPlayer } from "@/components/journey-player";
import { BRAND_NAME, TAGLINE } from "@/lib/brand";

const AUDIENCES = [
  {
    title: "For families",
    body: "Find activities, shows and classes your children will love, from people your neighbours already trust.",
    href: "/how-it-works#families",
    link: "See how it works for families",
  },
  {
    title: "For communities",
    body: "Give your residents safe, well-organised experiences, and decide which providers are welcome in your community.",
    href: "/how-it-works#communities",
    link: "See how it works for communities",
  },
  {
    title: "For providers",
    body: "Reach families in the communities you serve, send clear quotes and manage your bookings in one place.",
    href: "/how-it-works#vendors",
    link: "See how it works for providers",
  },
];

const CATEGORIES = [
  { title: "Entertainment", body: "Magic and puppet shows, storytelling, music, dance and games for parties and festivals." },
  { title: "Learning and discovery", body: "Science, robotics, coding, astronomy, art and craft, chess and cooking workshops." },
  { title: "Sports and activities", body: "Badminton, cricket, football, swimming, yoga, martial arts and outdoor play." },
  { title: "Experiences", body: "VR, planetarium visits, exhibitions, carnivals and adventure days." },
];

const SAFETY = [
  { title: "Checked before they are shown", body: "Every provider proves who they are, passes a background check and completes a child-safety briefing." },
  { title: "Your community has a say", body: "Residents only see providers that their own community has approved." },
  { title: "Your children's details stay yours", body: "We keep only a nickname, a year of birth and interests. Only you can see them." },
  { title: "A way to speak up", body: "If something worries you, report it privately. It goes to our team only, never to the provider." },
];

const FAQ = [
  { q: "Is it for me if I just want a one-off birthday show?", a: "Yes. Many families start with a single celebration. Tell us the date, the number of children and your budget, and we do the rest." },
  { q: "Who are the providers?", a: "Local magicians, teachers, coaches and performers. Each one is checked by our team and approved by your community before you can see them." },
  { q: "Do I pay through the app?", a: "For now you agree the payment directly with the provider. Our team keeps a record of what was agreed and paid so everything is clear for everyone." },
  { q: "What do you know about my children?", a: "Only what you choose to tell us: a nickname, a year of birth and interests. Providers and community administrators cannot see it, and you can download or erase it at any time." },
  { q: "My community is not on the list yet. What now?", a: `Create an account and you will be ready. ${BRAND_NAME} is opening with a small number of residential communities first.` },
];

export default function HomePage() {
  return (
    <>
      <section className="k-hero k-hero-grid" aria-labelledby="hero-title">
        <div>
          <span className="k-eyebrow">Experiences for families and communities</span>
          <h1 id="hero-title">{TAGLINE}</h1>
          <p className="k-hero-lead">
            Discover extraordinary experiences, trusted services, exciting activities and opportunities for your family and community.
          </p>
          <div className="k-row">
            <ButtonLink href="/register">Create your account</ButtonLink>
            <ButtonLink href="/how-it-works" variant="secondary">
              See how it works
            </ButtonLink>
          </div>
          <ul className="k-chips" aria-label="Why families choose us">
            <li className="k-chip">Providers are checked first</li>
            <li className="k-chip">Only you see your children&apos;s details</li>
            <li className="k-chip">Quotes and bookings in one place</li>
          </ul>
        </div>
        <Artwork slot="family" priority />
      </section>

      <section className="k-section" aria-labelledby="who-title">
        <div className="k-section-head">
          <h2 id="who-title">One place for everyone in the community</h2>
          <p>Whether you are a parent, a residents&apos; committee or a provider, {BRAND_NAME} keeps things simple and safe.</p>
        </div>
        <div className="k-cols-3">
          {AUDIENCES.map((a) => (
            <Card key={a.title} interactive style={{ height: "100%" }}>
              <h3>{a.title}</h3>
              <p className="k-muted">{a.body}</p>
              <p>
                <Link href={a.href}>{a.link}</Link>
              </p>
            </Card>
          ))}
        </div>
      </section>

      <section className="k-section" aria-labelledby="how-title">
        <div className="k-section-head">
          <span className="k-eyebrow">How it works</span>
          <h2 id="how-title">From idea to booked, in five easy steps</h2>
          <p>You always know what happens next, who is doing it and what we need from you.</p>
        </div>
        <JourneyPlayer stops={JOURNEY.map((s, i) => ({ short: s.short ?? `Step ${i + 1}`, title: s.title, lines: s.lines }))} />
        <FlowSteps />
        <p style={{ textAlign: "center", marginTop: "var(--k-space-6)" }}>
          <ButtonLink href="/register">Start your first request</ButtonLink>
        </p>
      </section>

      <section className="k-section" aria-labelledby="find-title">
        <div className="k-section-head">
          <h2 id="find-title">What you can find</h2>
          <p>Things children enjoy, from people who do them well.</p>
        </div>
        <div className="k-cols-4">
          {CATEGORIES.map((c) => (
            <Card key={c.title} style={{ height: "100%" }}>
              <h3>{c.title}</h3>
              <p className="k-muted">{c.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="k-band" aria-labelledby="safe-title">
        <div className="k-feature">
          <Artwork slot="kids" />
          <div className="k-stack">
            <span className="k-eyebrow">Safe by design</span>
            <h2 id="safe-title">Built around the safety of children</h2>
            <ul className="k-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {SAFETY.map((s) => (
                <li key={s.title}>
                  <strong>{s.title}.</strong> <span className="k-muted">{s.body}</span>
                </li>
              ))}
            </ul>
            <p>
              <Link href="/safety">Read about safety and reporting a concern</Link>
            </p>
          </div>
        </div>
      </section>

      <section className="k-section" aria-labelledby="community-title">
        <div className="k-feature">
          <div className="k-stack">
            <h2 id="community-title">Made for neighbourhoods</h2>
            <p className="k-muted">
              We are opening with a small number of residential communities. Create an account now and you will be ready when your community goes live. Want to bring {BRAND_NAME} to your community?{" "}
              <Link href="/contact">Get in touch</Link>.
            </p>
          </div>
          <Artwork slot="community" />
        </div>
      </section>

      <section className="k-section" aria-labelledby="faq-title">
        <div className="k-section-head">
          <h2 id="faq-title">Questions families ask</h2>
        </div>
        <div className="k-faq k-prose" style={{ marginInline: "auto" }}>
          {FAQ.map((f) => (
            <details key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="k-cta" aria-labelledby="cta-title">
        <h2 id="cta-title">Ready to find something wonderful for your family?</h2>
        <p>It takes a minute to create an account. You can add your children whenever you are ready.</p>
        <div className="k-row" style={{ justifyContent: "center" }}>
          <ButtonLink href="/register" variant="secondary">
            Get started
          </ButtonLink>
        </div>
      </section>
    </>
  );
}
