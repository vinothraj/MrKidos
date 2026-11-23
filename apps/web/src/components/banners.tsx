"use client";

import { Alert, Badge, Button, ButtonLink, Card, NextSteps, SelectField, Skeleton, TextAreaField, TextField, Wizard, type BadgeTone } from "@kidos/ui";
import { useCallback, useState } from "react";
import { Artwork } from "@/components/artwork";
import { api } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import type { PhotoSlot } from "@/lib/photos";
import { useLoad } from "@/lib/use-load";

export interface Banner {
  id: string;
  title: string;
  message: string;
  picture: "none" | PhotoSlot;
  linkPath: string | null;
  linkLabel: string | null;
  startsOn: string | null;
  endsOn: string | null;
  active: boolean;
}

/** The pictures an administrator can choose from: approved photo slots only (each falls back to a drawing). */
export const BANNER_PICTURES: { id: Banner["picture"]; name: string }[] = [
  { id: "bannerCandles", name: "Birthday candles" },
  { id: "bannerBirthday", name: "Birthday cake" },
  { id: "bannerPicnic", name: "Family picnic" },
  { id: "bannerPark", name: "Day in the park" },
  { id: "celebrate", name: "Celebration" },
  { id: "family", name: "Family together" },
  { id: "community", name: "Neighbourhood" },
  { id: "kids", name: "Children playing" },
  { id: "explore", name: "Discovery" },
  { id: "none", name: "No picture" },
];

/** Pages a banner may point to. Only places inside the app; the API refuses anything else. */
const LINK_TARGETS: { path: string; label: string }[] = [
  { path: "/app/catalog", label: "Find services" },
  { path: "/app/requests/new", label: "Make a request" },
  { path: "/app/family", label: "My family" },
  { path: "/app/join", label: "Join a community" },
];

/** One banner, as members see it: a picture behind a solid card, so the words always have full contrast. */
export function BannerView({ banner, headingLevel = 2 }: { banner: Pick<Banner, "title" | "message" | "picture" | "linkPath" | "linkLabel">; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className="k-banner" data-picture={banner.picture === "none" ? "none" : "yes"}>
      {banner.picture !== "none" && (
        <div className="k-banner-media" aria-hidden="true">
          <Artwork slot={banner.picture} />
        </div>
      )}
      <div className="k-banner-body">
        <p className="k-eyebrow">From your community</p>
        <H>{banner.title}</H>
        {banner.message && <p>{banner.message}</p>}
        {banner.linkPath && banner.linkLabel && (
          <ButtonLink href={banner.linkPath} size="sm">
            {banner.linkLabel}
          </ButtonLink>
        )}
      </div>
    </article>
  );
}

/** Residents' Home: what their community is announcing right now (nothing at all when there is no news). */
export function CommunityBanners() {
  const loader = useCallback(() => api<{ data: Banner[] }>("/me/banners"), []);
  const { state } = useLoad(loader);
  if (state.status !== "ready" || state.data.data.length === 0) return null;
  return (
    <section aria-label="News from your community" className="k-stack">
      {state.data.data.map((b) => (
        <BannerView key={b.id} banner={b} />
      ))}
    </section>
  );
}

function statusOf(b: Banner): { tone: BadgeTone; label: string } {
  const today = new Date().toISOString().slice(0, 10);
  if (!b.active) return { tone: "neutral", label: "Switched off" };
  if (b.startsOn && b.startsOn > today) return { tone: "info", label: `Starts ${b.startsOn}` };
  if (b.endsOn && b.endsOn < today) return { tone: "warning", label: "Ended" };
  return { tone: "success", label: "Showing now" };
}

const EMPTY = { title: "", message: "", picture: "bannerCandles" as Banner["picture"], link: "", linkLabel: "", startsOn: "", endsOn: "" };

function NewBanner({ communityId, onDone, onCancel }: { communityId: string; onDone: () => void; onCancel: () => void }) {
  const submit = useSubmit();
  const [f, setF] = useState(EMPTY);
  const err = submit.error?.fields ?? {};
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setF((c) => ({ ...c, [k]: e.target.value }));
  const target = LINK_TARGETS.find((x) => x.path === f.link);

  async function publish() {
    const body = {
      title: f.title.trim(),
      message: f.message.trim(),
      picture: f.picture,
      linkPath: f.link || null,
      linkLabel: f.link ? f.linkLabel.trim() || target?.label || null : null,
      startsOn: f.startsOn || null,
      endsOn: f.endsOn || null,
    };
    const created = await submit.run(() => api(`/communities/${communityId}/banners`, { method: "POST", body }));
    if (created) onDone();
  }

  return (
    <Wizard
      label="New banner"
      submitLabel="Publish banner"
      submitting={submit.submitting}
      onSubmit={() => void publish()}
      errorFields={Object.keys(err)}
      header={<ErrorSummary submit={submit} />}
      extraActions={
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      }
      steps={[
        {
          id: "words",
          title: "What to say",
          intro: "Keep it short: one headline and a sentence or two.",
          fields: ["title", "message"],
          validate: () => (f.title.trim() ? null : "Write a headline, for example: Diwali celebration this Saturday."),
          content: (
            <>
              <TextField label="Headline" required maxLength={80} value={f.title} onChange={set("title")} error={err["title"]} hint="Up to 80 characters." />
              <TextAreaField
                label="Message"
                rows={3}
                maxLength={280}
                value={f.message}
                onChange={set("message")}
                error={err["message"]}
                tip="Everyone in this community sees it on their Home screen. Do not include phone numbers, addresses or children's names."
              />
            </>
          ),
        },
        {
          id: "picture",
          title: "Choose a picture",
          intro: "Pictures come from the approved set, so everyone pictured has been checked.",
          fields: ["picture"],
          content: (
            <fieldset className="k-fieldset">
              <legend className="k-label">Picture</legend>
              <div className="k-picture-grid">
                {BANNER_PICTURES.map((p) => (
                  <label key={p.id} className="k-picture-option">
                    <input type="radio" name="banner-picture" value={p.id} checked={f.picture === p.id} onChange={() => setF((c) => ({ ...c, picture: p.id }))} />
                    <span className="k-picture-thumb" aria-hidden="true">
                      {p.id !== "none" && <Artwork slot={p.id} />}
                    </span>
                    <span>{p.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ),
        },
        {
          id: "when",
          title: "When and where it leads",
          intro: "Leave the dates empty to show it from now until you switch it off.",
          fields: ["startsOn", "endsOn", "linkPath", "linkLabel"],
          validate: () => (f.startsOn && f.endsOn && f.endsOn < f.startsOn ? "The last day must be on or after the first day." : null),
          content: (
            <>
              <div className="k-grid">
                <TextField label="First day" type="date" value={f.startsOn} onChange={set("startsOn")} error={err["startsOn"]} />
                <TextField label="Last day" type="date" value={f.endsOn} onChange={set("endsOn")} error={err["endsOn"]} tip="After this day the banner disappears by itself." />
              </div>
              <SelectField label="Button" value={f.link} onChange={set("link")} error={err["linkPath"]} hint="Optional: a button that opens a page in the app.">
                <option value="">No button</option>
                {LINK_TARGETS.map((x) => (
                  <option key={x.path} value={x.path}>
                    {x.label}
                  </option>
                ))}
              </SelectField>
              {f.link && <TextField label="Words on the button" maxLength={40} value={f.linkLabel} placeholder={target?.label} onChange={set("linkLabel")} error={err["linkLabel"]} />}
            </>
          ),
        },
        {
          id: "preview",
          title: "Preview and publish",
          intro: "This is exactly what members will see.",
          content: (
            <>
              <BannerView
                headingLevel={3}
                banner={{
                  title: f.title.trim(),
                  message: f.message.trim(),
                  picture: f.picture,
                  linkPath: f.link || null,
                  linkLabel: f.link ? f.linkLabel.trim() || target?.label || null : null,
                }}
              />
              <NextSteps>
                {f.startsOn ? `It appears on ${f.startsOn}` : "It appears straight away"} on every member&apos;s Home screen
                {f.endsOn ? ` and disappears after ${f.endsOn}.` : ", until you switch it off."} You can switch it off or delete it here at any time.
              </NextSteps>
            </>
          ),
        },
      ]}
    />
  );
}

function BannerRow({ communityId, banner, onChanged }: { communityId: string; banner: Banner; onChanged: () => void }) {
  const submit = useSubmit();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = statusOf(banner);
  return (
    <li className="k-card k-stack k-stack-sm">
      <div className="k-row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>{banner.title}</h3>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      {banner.message && <p className="k-muted">{banner.message}</p>}
      <ErrorSummary submit={submit} />
      {confirmDelete ? (
        <Alert variant="warning" title="Delete this banner?">
          <p>It disappears for everyone and cannot be brought back. To hide it for now, switch it off instead.</p>
          <div className="k-row">
            <Button
              size="sm"
              variant="danger"
              loading={submit.submitting}
              onClick={() => void submit.run(() => api(`/communities/${communityId}/banners/${banner.id}`, { method: "DELETE" })).then(onChanged)}
            >
              Yes, delete<span className="k-sr-only"> {banner.title}</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
          </div>
        </Alert>
      ) : (
        <div className="k-row">
          <Button
            size="sm"
            variant="secondary"
            loading={submit.submitting}
            onClick={() => void submit.run(() => api(`/communities/${communityId}/banners/${banner.id}`, { method: "PATCH", body: { active: !banner.active } })).then(onChanged)}
          >
            {banner.active ? "Switch off" : "Switch on"}
            <span className="k-sr-only"> {banner.title}</span>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
            Delete<span className="k-sr-only"> {banner.title}</span>
          </Button>
        </div>
      )}
    </li>
  );
}

/** Settings: an administrator's banners, newest first, and a step-by-step way to add one. */
export function BannerManager({ communityId }: { communityId: string }) {
  const loader = useCallback(() => api<{ data: Banner[] }>(`/communities/${communityId}/banners`), [communityId]);
  const { state, reload } = useLoad(loader);
  const [adding, setAdding] = useState(false);
  const [published, setPublished] = useState(false);
  return (
    <Card>
      <div className="k-stack">
        <div>
          <h2>Community banners</h2>
          <p className="k-muted">Announcements with a picture, shown at the top of every member&apos;s Home screen. Each change is recorded in the audit log.</p>
        </div>
        {published && !adding && <Alert variant="success">Published. Members see it the next time they open Home.</Alert>}
        {adding ? (
          <NewBanner
            communityId={communityId}
            onCancel={() => setAdding(false)}
            onDone={() => {
              setAdding(false);
              setPublished(true);
              reload();
            }}
          />
        ) : (
          <div className="k-row">
            <Button
              onClick={() => {
                setPublished(false);
                setAdding(true);
              }}
            >
              New banner
            </Button>
          </div>
        )}
        {state.status === "loading" && <Skeleton height="4rem" />}
        {state.status === "error" && <Alert variant="danger">We could not load the banners. Reload the page to try again.</Alert>}
        {state.status === "ready" && state.data.data.length === 0 && !adding && (
          <p className="k-muted">No banners yet. Use New banner to announce an event, a holiday or a new activity.</p>
        )}
        {state.status === "ready" && state.data.data.length > 0 && (
          <ul className="k-stack" style={{ listStyle: "none", padding: 0, margin: 0 }} aria-label="Your banners">
            {state.data.data.map((b) => (
              <BannerRow key={b.id} communityId={communityId} banner={b} onChanged={reload} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
