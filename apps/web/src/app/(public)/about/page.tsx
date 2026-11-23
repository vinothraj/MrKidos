import { ButtonLink, Card } from "@kidos/ui";
import type { Metadata } from "next";
import { Artwork } from "@/components/artwork";
import { BRAND_NAME } from "@/lib/brand";

export const metadata: Metadata = { title: "About us" };

const VALUES = [
  { title: "Children first", body: "Every decision starts with one question: is this safe and good for the children involved?" },
  { title: "Trust you can check", body: "Providers are verified by people, not by a form. You can see what was checked." },
  { title: "Simple and clear", body: "Plain words, clear prices and one place to follow your request, so nobody is left guessing." },
  { title: "Respect for privacy", body: "We collect as little as we can, keep children's details private to their family, and let you erase them at any time." },
];

export default function AboutPage() {
  return (
    <div className="k-stack k-stack-lg">
      <section className="k-hero-grid k-page-hero" style={{ maxWidth: "none" }} aria-labelledby="about-title">
        <div>
          <span className="k-eyebrow">About us</span>
          <h1 id="about-title">Making it easy to find good things for children</h1>
          <p className="k-hero-lead">
            {BRAND_NAME} began with a simple problem: in a busy neighbourhood it is hard to find a magician, a coach or a science teacher you can trust, and harder still to book them well. We are building the place that fixes that.
          </p>
        </div>
        <Artwork slot="mumAndChild" priority />
      </section>

      <section className="k-section" aria-labelledby="mission-title">
        <div className="k-feature">
          <Artwork slot="community" />
          <div className="k-stack">
            <h2 id="mission-title">What we do</h2>
            <p className="k-muted">
              We connect families and residential communities with vetted local providers of entertainment, learning, sports and experiences. A real team reads each request, finds suitable providers, gathers clear quotes and helps you book, so that you do not have to.
            </p>
            <p className="k-muted">
              Communities decide which providers are welcome. Providers are checked before anyone sees them. Families stay in control of their own information.
            </p>
          </div>
        </div>
      </section>

      <section className="k-section" aria-labelledby="values-title">
        <div className="k-section-head">
          <h2 id="values-title">What we believe</h2>
        </div>
        <div className="k-cols-4">
          {VALUES.map((v) => (
            <Card key={v.title} style={{ height: "100%" }}>
              <h3>{v.title}</h3>
              <p className="k-muted">{v.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="k-band" aria-labelledby="stage-title">
        <div className="k-prose" style={{ marginInline: "auto" }}>
          <h2 id="stage-title">Where we are today</h2>
          <p>
            We are in an early pilot, opening with a small number of residential communities so that we can learn, listen and get things right before we grow. If you would like {BRAND_NAME} in your community, or you offer something families would love, we would like to hear from you.
          </p>
          <div className="k-row">
            <ButtonLink href="/contact">Contact us</ButtonLink>
            <ButtonLink href="/how-it-works" variant="secondary">
              See how it works
            </ButtonLink>
          </div>
        </div>
      </section>
    </div>
  );
}
