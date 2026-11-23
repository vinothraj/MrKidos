import { Artwork } from "@/components/artwork";
import type { PhotoSlot } from "@/lib/photos";

export interface FlowStep {
  /** One or two words, for the animated overview. */
  short?: string;
  title: string;
  body: string;
  art: PhotoSlot;
  /** What each person does at this step, in plain words. */
  lines: { who: string; text: string }[];
}

/** The journey from an idea to a booked activity, told one step at a time with a picture for each. */
export const JOURNEY: FlowStep[] = [
  {
    art: "stepIdea",
    short: "Ask",
    title: "Tell us what you would like",
    body: "Start with a simple form. Pick what you are looking for, such as a birthday show, a science workshop or a weekly class, and add the date, how many children and your budget.",
    lines: [
      { who: "You", text: "Describe the activity in a few sentences. It takes about two minutes." },
      { who: "Us", text: "Nothing is shared with providers yet." },
    ],
  },
  {
    art: "stepMatch",
    short: "Match",
    title: "Our team checks and finds trusted providers",
    body: "A real person reads your request. If something is unclear we ask you, then we look for providers who serve your community and match your needs.",
    lines: [
      { who: "Us", text: "We pick providers that were checked and approved by your community." },
      { who: "You", text: "Answer a question if we send one. You are told at every step." },
    ],
  },
  {
    art: "explore",
    short: "Compare",
    title: "Compare clear quotes in one place",
    body: "Providers send a quote with the price broken down. We choose the best options for you, so you are not chasing messages across different apps.",
    lines: [
      { who: "Providers", text: "See only what they need to quote, never your family details." },
      { who: "You", text: "Review the shortlisted options side by side." },
    ],
  },
  {
    art: "stepBook",
    short: "Book",
    title: "Choose one and we confirm the booking",
    body: "Pick the option you like. We agree the date and place with the provider, and the provider confirms. You see the booking as soon as it is confirmed.",
    lines: [
      { who: "You", text: "Choose one quote. That is your decision alone." },
      { who: "Us", text: "We set the date and place and confirm it with the provider." },
    ],
  },
  {
    art: "celebrate",
    short: "Enjoy",
    title: "Enjoy it, then share how it went",
    body: "Have a great time. Afterwards, tell us how it went so the next family in your community can choose well. Our team checks every review before it appears.",
    lines: [
      { who: "You", text: "Leave a short review. Your name is never shown publicly." },
      { who: "Providers", text: "Can reply to your review." },
    ],
  },
];

export function FlowSteps({ steps = JOURNEY }: { steps?: FlowStep[] }) {
  return (
    <ol className="k-steps" aria-label="The steps, in order">
      {steps.map((step, i) => (
        <li key={step.title} className="k-step">
          <div className="k-step-media">
            <Artwork slot={step.art} />
          </div>
          <div>
            <span className="k-step-num" aria-hidden="true">
              {i + 1}
            </span>
            <span className="k-eyebrow" style={{ display: "block" }}>
              Step {i + 1} of {steps.length}
            </span>
            <h3>{step.title}</h3>
            <p className="k-muted">{step.body}</p>
            <ul className="k-step-lines">
              {step.lines.map((l) => (
                <li key={l.who + l.text}>
                  <span className="k-step-who">{l.who}</span>
                  <span>{l.text}</span>
                </li>
              ))}
            </ul>
          </div>
        </li>
      ))}
    </ol>
  );
}
