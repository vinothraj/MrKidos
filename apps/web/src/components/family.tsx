"use client";

import { Alert, Badge, Button, Card, CheckboxField, EmptyState, FieldGroup, SelectField, Skeleton, TextField } from "@kidos/ui";
import { useCallback, useState, type FormEvent } from "react";
import { Artwork } from "@/components/artwork";
import { api } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import { useLoad } from "@/lib/use-load";

interface Child {
  id: string;
  nickname: string;
  birthYear: number;
  interests: string[];
  ageBand: string;
}
interface Family {
  children: Child[];
  consent: { version: string; grantedAt: string } | null;
  limit: number;
}
interface Interest {
  key: string;
  label: string;
}

const thisYear = new Date().getFullYear();
const YEARS = Array.from({ length: 18 }, (_, i) => thisYear - i);

/** Used for both adding and editing a child. Only a nickname, a birth year and interests are collected, by design. */
function ChildForm({
  interests,
  needsConsent,
  initial,
  onSaved,
  onCancel,
}: {
  interests: Interest[];
  needsConsent: boolean;
  initial?: Child;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const submit = useSubmit();
  const [nickname, setNickname] = useState(initial?.nickname ?? "");
  const [year, setYear] = useState(initial ? String(initial.birthYear) : "");
  const [chosen, setChosen] = useState<string[]>(initial?.interests ?? []);
  const [consent, setConsent] = useState(false);
  const labels = Object.fromEntries(interests.map((i) => [i.key, i.label]));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = { nickname, birthYear: Number(year), interests: chosen };
    const res = await submit.run(() =>
      initial
        ? api(`/me/family/children/${initial.id}`, { method: "PATCH", body })
        : api("/me/family/children", { method: "POST", body: needsConsent ? { ...body, consentAccepted: consent } : body }),
    );
    if (res) {
      if (!initial) {
        setNickname("");
        setYear("");
        setChosen([]);
        setConsent(false);
      }
      onSaved();
    }
  }

  const fields = submit.error?.fields ?? {};
  return (
    <form onSubmit={onSubmit} className="k-stack" noValidate aria-label={initial ? `Edit ${initial.nickname}` : "Add a child"}>
      <ErrorSummary submit={submit} />
      <TextField label="First name or nickname" name="nickname" required autoComplete="off" hint="Please do not enter a surname, phone number or email." value={nickname} onChange={(e) => setNickname(e.target.value)} error={fields["nickname"]} />
      <SelectField label="Year of birth" name="birthYear" required value={year} onChange={(e) => setYear(e.target.value)} error={fields["birthYear"]} hint="We only keep the year, and show services an age range instead of an exact age.">
        <option value="">Choose a year</option>
        {YEARS.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </SelectField>
      <FieldGroup legend="Interests (optional)" hint="Helps us suggest experiences your child will enjoy.">
        {interests.map((i) => (
          <CheckboxField
            key={i.key}
            label={labels[i.key] ?? i.key}
            checked={chosen.includes(i.key)}
            onChange={(e) => setChosen((cur) => (e.target.checked ? [...cur, i.key] : cur.filter((k) => k !== i.key)))}
          />
        ))}
      </FieldGroup>
      {needsConsent && !initial && (
        <Card style={{ background: "var(--k-surface-2)" }}>
          <h3>Before we store anything about your child</h3>
          <ul>
            <li>We keep only a nickname, a year of birth and interests. No photos, school or contact details.</li>
            <li>Only you can see this. Community administrators and vendors cannot.</li>
            <li>You can download or permanently erase it at any time from this page.</li>
          </ul>
          <CheckboxField
            label="I am this child's parent or legal guardian, and I agree to this."
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            error={fields["consentAccepted"]}
          />
        </Card>
      )}
      <div className="k-row">
        <Button type="submit" loading={submit.submitting}>
          {initial ? "Save changes" : "Add child"}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function ChildRow({ child, labels, interests, onChanged, needsConsent }: { child: Child; labels: Record<string, string>; interests: Interest[]; onChanged: () => void; needsConsent: boolean }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const del = useSubmit();

  async function remove() {
    const ok = await del.run(async () => {
      await api(`/me/family/children/${child.id}`, { method: "DELETE" });
      return true;
    });
    if (ok) onChanged();
  }

  if (editing) {
    return (
      <Card>
        <ChildForm
          interests={interests}
          needsConsent={needsConsent}
          initial={child}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      </Card>
    );
  }
  return (
    <Card>
      <div className="k-row" style={{ justifyContent: "space-between" }}>
        <div>
          <h3 style={{ margin: 0 }}>{child.nickname}</h3>
          <p className="k-muted" style={{ margin: 0 }}>
            Age range {child.ageBand}
          </p>
        </div>
        <div className="k-row">
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            Edit<span className="k-sr-only"> {child.nickname}</span>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Remove<span className="k-sr-only"> {child.nickname}</span>
          </Button>
        </div>
      </div>
      {child.interests.length > 0 && (
        <div className="k-row" style={{ marginTop: "var(--k-space-3)" }}>
          {child.interests.map((k) => (
            <Badge key={k}>{labels[k] ?? k}</Badge>
          ))}
        </div>
      )}
      {confirming && (
        <Alert variant="warning" title={`Remove ${child.nickname}?`} style={{ marginTop: "var(--k-space-3)" }}>
          This permanently deletes this profile. It cannot be undone.
          <ErrorSummary submit={del} />
          <div className="k-row" style={{ marginTop: "var(--k-space-3)" }}>
            <Button size="sm" variant="danger" loading={del.submitting} onClick={() => void remove()}>
              Yes, remove permanently
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </div>
        </Alert>
      )}
    </Card>
  );
}

function ErasePanel({ onErased }: { onErased: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const submit = useSubmit();

  async function erase() {
    const ok = await submit.run(async () => {
      await api("/me/family", { method: "DELETE" });
      return true;
    });
    if (ok) {
      setConfirming(false);
      onErased();
    }
  }

  return (
    <Card>
      <h2>Your data, your control</h2>
      <p className="k-muted">Download everything we hold about your family, or erase it all and withdraw your agreement.</p>
      <div className="k-row">
        <a className="k-btn k-btn-secondary" href="/api/v1/me/family/export" download="family-data.json">
          Download my family data
        </a>
        {!confirming && (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            Erase all family data
          </Button>
        )}
      </div>
      {confirming && (
        <Alert variant="danger" title="Erase everything?" style={{ marginTop: "var(--k-space-4)" }}>
          This permanently deletes every child profile and withdraws your agreement. It cannot be undone.
          <ErrorSummary submit={submit} />
          <div className="k-row" style={{ marginTop: "var(--k-space-3)" }}>
            <Button variant="danger" loading={submit.submitting} onClick={() => void erase()}>
              Yes, erase everything
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </Alert>
      )}
    </Card>
  );
}

export function FamilyPage() {
  const familyLoader = useCallback(() => api<Family>("/me/family"), []);
  const interestLoader = useCallback(() => api<{ data: Interest[] }>("/interests"), []);
  const family = useLoad(familyLoader);
  const interests = useLoad(interestLoader);

  const loading = family.state.status === "loading" || interests.state.status === "loading";
  const failed = family.state.status === "error" || interests.state.status === "error";
  const ready = family.state.status === "ready" && interests.state.status === "ready" ? { family: family.state.data, interests: interests.state.data.data } : null;
  const labels = ready ? Object.fromEntries(ready.interests.map((i) => [i.key, i.label])) : {};

  return (
    <div className="k-stack k-stack-lg">
      <div>
        <h1>My family</h1>
        <p className="k-muted">Tell us a little about your children so we can suggest experiences that suit them. You are in control of this information.</p>
      </div>

      {loading && <Skeleton height="6rem" />}
      {failed && (
        <Alert variant="danger" title="We could not load your family">
          If you have not confirmed your email address yet, please do that first. Otherwise try again in a moment.
        </Alert>
      )}

      {ready && (
        <>
          <section aria-labelledby="children-title" className="k-stack">
            <h2 id="children-title">Children</h2>
            {ready.family.children.length === 0 ? (
              <EmptyState title="No children added yet" art={<Artwork slot="mumAndChild" />}>Add a child below to get suggestions that fit their age and interests.</EmptyState>
            ) : (
              <ul className="k-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {ready.family.children.map((c) => (
                  <li key={c.id}>
                    <ChildRow child={c} labels={labels} interests={ready.interests} needsConsent={ready.family.consent === null} onChanged={family.reload} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {ready.family.children.length < ready.family.limit ? (
            <Card>
              <h2>Add a child</h2>
              <ChildForm interests={ready.interests} needsConsent={ready.family.consent === null} onSaved={family.reload} />
            </Card>
          ) : (
            <Alert variant="info">You have added the maximum of {ready.family.limit} children.</Alert>
          )}

          <ErasePanel onErased={family.reload} />
        </>
      )}
    </div>
  );
}
