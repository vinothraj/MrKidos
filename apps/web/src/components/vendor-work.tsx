"use client";

import { Alert, Badge, Button, Card, CheckboxField, EmptyState, NextSteps, ReviewList, SelectField, Skeleton, TextAreaField, TextField, Wizard, type BadgeTone } from "@kidos/ui";
import { useCallback, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import { useLoad } from "@/lib/use-load";

const blank = (v: string): string | null => (v.trim() === "" ? null : v.trim());
const intOrNull = (v: string): number | null => (v.trim() === "" ? null : Number(v));

/* ---------------------------------------------------------------- documents */

interface Doc {
  id: string;
  requirementKey: string;
  title: string;
  reference: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  status: "submitted" | "verified" | "rejected";
  expired: boolean;
  reviewNote: string | null;
}
interface Requirement {
  key: string;
  label: string;
  description: string;
  required: boolean;
  state: "verified" | "expired" | "submitted" | "rejected" | "missing";
  documents: Doc[];
}
interface Vetting {
  requirements: Requirement[];
  readyForApproval: boolean;
}

const REQUIREMENT_STATE: Record<Requirement["state"], { label: string; tone: BadgeTone }> = {
  verified: { label: "Verified", tone: "success" },
  expired: { label: "Expired", tone: "danger" },
  submitted: { label: "Waiting for review", tone: "info" },
  rejected: { label: "Not accepted", tone: "danger" },
  missing: { label: "Not provided", tone: "warning" },
};

function DocumentRow({ vendorId, doc, canReview, onChanged }: { vendorId: string; doc: Doc; canReview: boolean; onChanged: () => void }) {
  const submit = useSubmit();
  const [note, setNote] = useState("");
  const base = `/vendors/${vendorId}/documents/${doc.id}`;

  async function review(decision: "verify" | "reject") {
    const res = await submit.run(() => api(`${base}/review`, { method: "POST", body: { decision, ...(note.trim() ? { note: note.trim() } : {}) } }));
    if (res) onChanged();
  }
  async function withdraw() {
    const ok = await submit.run(async () => {
      await api(base, { method: "DELETE" });
      return true;
    });
    if (ok) onChanged();
  }

  return (
    <li className="k-stack k-stack-sm">
      <div className="k-row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>{doc.title}</strong>{" "}
          <Badge tone={doc.status === "verified" ? "success" : doc.status === "rejected" ? "danger" : "info"}>
            {doc.status === "verified" ? "Verified" : doc.status === "rejected" ? "Not accepted" : "Waiting for review"}
          </Badge>{" "}
          {doc.expired && <Badge tone="danger">Expired</Badge>}
          <div className="k-muted">
            {doc.reference ? `Reference: ${doc.reference}` : "No reference given"}
            {doc.expiresOn ? ` · Expires ${doc.expiresOn}` : ""}
          </div>
          {doc.reviewNote && <div>Reviewer note: {doc.reviewNote}</div>}
        </div>
        {doc.status === "submitted" && !canReview && (
          <Button size="sm" variant="secondary" loading={submit.submitting} onClick={() => void withdraw()}>
            Withdraw<span className="k-sr-only"> {doc.title}</span>
          </Button>
        )}
      </div>
      <ErrorSummary submit={submit} />
      {canReview && doc.status === "submitted" && (
        <div className="k-stack k-stack-sm">
          <TextField label={`Note for ${doc.title}`} hint="Required when you do not accept a document." value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="k-row">
            <Button size="sm" loading={submit.submitting} onClick={() => void review("verify")}>
              Verify<span className="k-sr-only"> {doc.title}</span>
            </Button>
            <Button size="sm" variant="secondary" loading={submit.submitting} onClick={() => void review("reject")}>
              Do not accept<span className="k-sr-only"> {doc.title}</span>
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function DocumentForm({ vendorId, requirements, onDone }: { vendorId: string; requirements: Requirement[]; onDone: () => void }) {
  const submit = useSubmit();
  const [f, setF] = useState({ requirementKey: requirements[0]?.key ?? "", title: "", reference: "", issuedOn: "", expiresOn: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((c) => ({ ...c, [k]: e.target.value }));
  const err = submit.error?.fields ?? {};

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = { requirementKey: f.requirementKey, title: f.title.trim(), reference: blank(f.reference), issuedOn: blank(f.issuedOn), expiresOn: blank(f.expiresOn) };
    const res = await submit.run(() => api(`/vendors/${vendorId}/documents`, { method: "POST", body }));
    if (res) {
      setF((c) => ({ ...c, title: "", reference: "", issuedOn: "", expiresOn: "" }));
      onDone();
    }
  }

  return (
    <form onSubmit={onSubmit} className="k-stack" noValidate aria-label="Submit a document">
      <ErrorSummary submit={submit} />
      <p className="k-muted">
        Files are not uploaded yet. Give the document a title and a reference the reviewer can use (for example a secure link or the certificate number).
      </p>
      <div className="k-grid">
        <SelectField label="Document type" value={f.requirementKey} onChange={set("requirementKey")} error={err["requirementKey"]}>
          {requirements.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
              {r.required ? " (required)" : ""}
            </option>
          ))}
        </SelectField>
        <TextField label="Title" required value={f.title} onChange={set("title")} error={err["title"]} />
        <TextField label="Reference or link" value={f.reference} onChange={set("reference")} error={err["reference"]} />
        <TextField label="Issued on" type="date" value={f.issuedOn} onChange={set("issuedOn")} error={err["issuedOn"]} />
        <TextField label="Expires on" type="date" value={f.expiresOn} onChange={set("expiresOn")} error={err["expiresOn"]} />
      </div>
      <div>
        <Button type="submit" variant="secondary" loading={submit.submitting} disabled={f.title.trim() === ""}>
          Submit document
        </Button>
      </div>
    </form>
  );
}

export function DocumentsSection({ id, canReview, onChanged }: { id: string; canReview: boolean; onChanged: () => void }) {
  const loader = useCallback(() => api<Vetting>(`/vendors/${id}/vetting`), [id]);
  const { state, reload } = useLoad(loader);
  const changed = () => {
    reload();
    onChanged();
  };
  return (
    <Card>
      <h2>Documents and vetting</h2>
      <p className="k-muted">Families trust vendors who have been checked. Every required document must be verified and current before a vendor can be approved.</p>
      {state.status === "loading" && <Skeleton height="4rem" />}
      {state.status === "error" && <Alert variant="danger">We could not load the documents.</Alert>}
      {state.status === "ready" && (
        <div className="k-stack k-stack-lg">
          <Alert variant={state.data.readyForApproval ? "success" : "info"}>
            {state.data.readyForApproval ? "Every required document is verified." : "Some required documents are still missing, waiting for review, or expired."}
          </Alert>
          <ul className="k-stack k-stack-lg" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {state.data.requirements.map((r) => (
              <li key={r.key} className="k-stack k-stack-sm">
                <div className="k-row" style={{ justifyContent: "space-between" }}>
                  <div>
                    <h3 style={{ margin: 0 }}>{r.label}</h3>
                    <div className="k-muted">
                      {r.description} {r.required ? "Required." : "Optional."}
                    </div>
                  </div>
                  <Badge tone={REQUIREMENT_STATE[r.state].tone}>{REQUIREMENT_STATE[r.state].label}</Badge>
                </div>
                {r.documents.length > 0 && (
                  <ul className="k-stack k-stack-sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {r.documents.map((d) => (
                      <DocumentRow key={d.id} vendorId={id} doc={d} canReview={canReview} onChanged={changed} />
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          <div>
            <h3>Submit a document</h3>
            <DocumentForm vendorId={id} requirements={state.data.requirements} onDone={changed} />
          </div>
        </div>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- offerings */

export interface Offering {
  id: string;
  categoryId: string;
  category: string;
  name: string;
  description: string | null;
  offeringType: "service" | "workshop" | "experience";
  pricingModel: string;
  priceMinor: number | null;
  currency: string;
  durationMinutes: number | null;
  minParticipants: number | null;
  maxParticipants: number | null;
  ageMin: number | null;
  ageMax: number | null;
  equipment: string | null;
  venueRequirements: string | null;
  additionalCharges: string | null;
  terms: string | null;
  cancellationPolicy: string | null;
  status: "draft" | "published" | "archived";
}

export const PRICING_LABEL: Record<string, string> = {
  fixed: "Fixed price",
  hourly: "Per hour",
  per_participant: "Per child",
  per_event: "Per event",
  per_day: "Per day",
  package: "Package price",
  custom_quotation: "Custom quotation",
};

export function formatPrice(o: Pick<Offering, "priceMinor" | "pricingModel" | "currency">): string {
  if (o.priceMinor === null) return "Price on request";
  const amount = (o.priceMinor / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return `${o.currency === "INR" ? "₹" : `${o.currency} `}${amount} · ${PRICING_LABEL[o.pricingModel] ?? o.pricingModel}`;
}

/** What families need before an offering is shown. Mirrors the server's rule; the API remains the authority. */
function publishHints(o: Pick<Offering, "description" | "durationMinutes" | "cancellationPolicy">): string[] {
  const out: string[] = [];
  if (!o.description?.trim()) out.push("Add a description so families know what to expect.");
  if (!o.durationMinutes) out.push("Add how long it lasts.");
  if (!o.cancellationPolicy?.trim()) out.push("Add a cancellation policy.");
  return out;
}

const OFFERING_STATUS: Record<Offering["status"], { label: string; tone: BadgeTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  published: { label: "Published", tone: "success" },
  archived: { label: "Archived", tone: "warning" },
};

interface Category {
  id: string;
  parentId: string | null;
  name: string;
  isActive: boolean;
}

function OfferingForm({ vendorId, initial, categories, onDone, onCancel }: { vendorId: string; initial?: Offering; categories: Category[]; onDone: () => void; onCancel?: () => void }) {
  const submit = useSubmit();
  const leafCategories = categories.filter((c) => c.parentId !== null && c.isActive);
  const [f, setF] = useState({
    categoryId: initial?.categoryId ?? leafCategories[0]?.id ?? "",
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    offeringType: initial?.offeringType ?? "service",
    pricingModel: initial?.pricingModel ?? "per_participant",
    price: initial?.priceMinor != null ? String(initial.priceMinor / 100) : "",
    durationMinutes: initial?.durationMinutes?.toString() ?? "",
    minParticipants: initial?.minParticipants?.toString() ?? "",
    maxParticipants: initial?.maxParticipants?.toString() ?? "",
    ageMin: initial?.ageMin?.toString() ?? "",
    ageMax: initial?.ageMax?.toString() ?? "",
    equipment: initial?.equipment ?? "",
    venueRequirements: initial?.venueRequirements ?? "",
    additionalCharges: initial?.additionalCharges ?? "",
    terms: initial?.terms ?? "",
    cancellationPolicy: initial?.cancellationPolicy ?? "",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((c) => ({ ...c, [k]: e.target.value }));
  const err = submit.error?.fields ?? {};
  const quoted = f.pricingModel === "custom_quotation";

  async function save() {
    const body = {
      categoryId: f.categoryId,
      name: f.name.trim(),
      description: blank(f.description),
      offeringType: f.offeringType,
      pricingModel: f.pricingModel,
      priceMinor: quoted || f.price.trim() === "" ? null : Math.round(Number(f.price) * 100),
      durationMinutes: intOrNull(f.durationMinutes),
      minParticipants: intOrNull(f.minParticipants),
      maxParticipants: intOrNull(f.maxParticipants),
      ageMin: intOrNull(f.ageMin),
      ageMax: intOrNull(f.ageMax),
      equipment: blank(f.equipment),
      venueRequirements: blank(f.venueRequirements),
      additionalCharges: blank(f.additionalCharges),
      terms: blank(f.terms),
      cancellationPolicy: blank(f.cancellationPolicy),
    };
    const res = await submit.run(() =>
      initial ? api(`/vendors/${vendorId}/offerings/${initial.id}`, { method: "PATCH", body }) : api(`/vendors/${vendorId}/offerings`, { method: "POST", body: { ...body, status: "draft" } }),
    );
    if (res) onDone();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await save();
  }

  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const groupProblem = num(f.minParticipants) !== null && num(f.maxParticipants) !== null && (num(f.maxParticipants) ?? 0) < (num(f.minParticipants) ?? 0) ? "The maximum cannot be less than the minimum." : null;
  const ageProblem = num(f.ageMin) !== null && num(f.ageMax) !== null && (num(f.ageMax) ?? 0) < (num(f.ageMin) ?? 0) ? "The oldest age cannot be below the youngest." : null;
  const categoryName = leafCategories.find((c) => c.id === f.categoryId)?.name ?? "";

  // A new offering is added in short steps; editing one keeps the single form below (one change, one save).
  if (!initial) {
    return (
      <Wizard
        label="Add an offering"
        submitLabel="Add offering"
        submitting={submit.submitting}
        onSubmit={() => void save()}
        errorFields={Object.keys(err)}
        header={<ErrorSummary submit={submit} />}
        {...(onCancel
          ? {
              extraActions: (
                <Button variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              ),
            }
          : {})}
        steps={[
          {
            id: "offering-what",
            title: "What it is",
            intro: "The name and description families read in the catalog.",
            fields: ["name", "categoryId", "offeringType", "description"],
            validate: () => (f.name.trim() ? null : "Give the offering a name, for example: Weekend cricket camp."),
            content: (
              <>
                <TextField label="Name" required value={f.name} onChange={set("name")} error={err["name"]} />
                <div className="k-grid">
                  <SelectField label="Category" value={f.categoryId} onChange={set("categoryId")} error={err["categoryId"]} tip="Families filter the catalog by category, so pick the closest one.">
                    {leafCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </SelectField>
                  <SelectField label="Kind" value={f.offeringType} onChange={set("offeringType")} error={err["offeringType"]}>
                    <option value="service">Service</option>
                    <option value="workshop">Workshop</option>
                    <option value="experience">Experience</option>
                  </SelectField>
                </div>
                <TextAreaField label="Description" hint="What happens, what children learn or do, and who it suits. Needed before you can publish." rows={4} value={f.description} onChange={set("description")} error={err["description"]} />
              </>
            ),
          },
          {
            id: "offering-price",
            title: "Price and time",
            intro: "Families see the price before they ask; choose quotation when it depends on the event.",
            fields: ["pricingModel", "priceMinor", "durationMinutes"],
            validate: () => (f.price.trim() && !(Number(f.price) >= 0) ? "The price must be a number of rupees, or left empty." : null),
            content: (
              <div className="k-grid">
                <SelectField label="How you charge" value={f.pricingModel} onChange={set("pricingModel")} error={err["pricingModel"]}>
                  {Object.entries(PRICING_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </SelectField>
                {!quoted && <TextField label="Price (₹)" type="number" inputMode="decimal" min={0} step="0.01" value={f.price} onChange={set("price")} error={err["priceMinor"]} />}
                <TextField label="Duration (minutes)" type="number" inputMode="numeric" min={5} max={1440} value={f.durationMinutes} onChange={set("durationMinutes")} error={err["durationMinutes"]} hint="Needed before you can publish." />
              </div>
            ),
          },
          {
            id: "offering-who",
            title: "Who it suits",
            intro: "Group size and ages help families and the team match it to the right requests.",
            fields: ["minParticipants", "maxParticipants", "ageMin", "ageMax"],
            validate: () => groupProblem ?? ageProblem,
            content: (
              <div className="k-grid">
                <TextField label="Fewest children" type="number" inputMode="numeric" min={1} value={f.minParticipants} onChange={set("minParticipants")} error={err["minParticipants"]} />
                <TextField label="Most children" type="number" inputMode="numeric" min={1} value={f.maxParticipants} onChange={set("maxParticipants")} error={err["maxParticipants"]} />
                <TextField label="Youngest age" type="number" inputMode="numeric" min={0} value={f.ageMin} onChange={set("ageMin")} error={err["ageMin"]} />
                <TextField label="Oldest age" type="number" inputMode="numeric" min={0} value={f.ageMax} onChange={set("ageMax")} error={err["ageMax"]} />
              </div>
            ),
          },
          {
            id: "offering-practical",
            title: "Practical details",
            intro: "What the community and families need to know before booking.",
            fields: ["equipment", "venueRequirements", "additionalCharges", "terms", "cancellationPolicy"],
            content: (
              <>
                <TextAreaField label="Equipment you bring or need" rows={2} value={f.equipment} onChange={set("equipment")} error={err["equipment"]} />
                <TextAreaField label="Venue requirements" rows={2} value={f.venueRequirements} onChange={set("venueRequirements")} error={err["venueRequirements"]} />
                <TextAreaField label="Additional charges" rows={2} value={f.additionalCharges} onChange={set("additionalCharges")} error={err["additionalCharges"]} tip="Anything on top of the price, such as travel or materials, so nobody is surprised." />
                <TextAreaField label="Terms" rows={2} value={f.terms} onChange={set("terms")} error={err["terms"]} />
                <TextAreaField label="Cancellation policy" hint="Required before you can publish." rows={2} value={f.cancellationPolicy} onChange={set("cancellationPolicy")} error={err["cancellationPolicy"]} />
              </>
            ),
          },
          {
            id: "offering-review",
            title: "Check and add",
            intro: "It is saved as a draft: nobody sees it until you publish it.",
            content: (
              <>
                <ReviewList
                  items={[
                    { label: "Name", value: f.name.trim() },
                    { label: "Category", value: categoryName },
                    { label: "How you charge", value: PRICING_LABEL[f.pricingModel] ?? f.pricingModel },
                    { label: "Price", value: quoted ? "By quotation" : f.price.trim() ? `₹${f.price.trim()}` : "" },
                    { label: "Duration", value: f.durationMinutes.trim() ? `${f.durationMinutes.trim()} minutes` : "" },
                    { label: "Group size", value: f.minParticipants.trim() || f.maxParticipants.trim() ? `${f.minParticipants.trim() || "?"} to ${f.maxParticipants.trim() || "?"} children` : "" },
                    { label: "Ages", value: f.ageMin.trim() || f.ageMax.trim() ? `${f.ageMin.trim() || "?"} to ${f.ageMax.trim() || "?"}` : "" },
                    { label: "Cancellation policy", value: f.cancellationPolicy.trim() },
                  ]}
                />
                <NextSteps>
                  The offering is added as a draft. Publish it from your list when the description, duration and cancellation policy are filled in. Families
                  then see it in the catalog of every community that has approved your business.
                </NextSteps>
              </>
            ),
          },
        ]}
      />
    );
  }

  return (
    <form onSubmit={onSubmit} className="k-stack" noValidate aria-label={initial ? `Edit ${initial.name}` : "Add an offering"}>
      <ErrorSummary submit={submit} />
      <div className="k-grid">
        <TextField label="Name" required value={f.name} onChange={set("name")} error={err["name"]} />
        <SelectField label="Category" value={f.categoryId} onChange={set("categoryId")} error={err["categoryId"]}>
          {leafCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="Kind" value={f.offeringType} onChange={set("offeringType")} error={err["offeringType"]}>
          <option value="service">Service</option>
          <option value="workshop">Workshop</option>
          <option value="experience">Experience</option>
        </SelectField>
      </div>
      <TextAreaField label="Description" hint="What happens, what children learn or do, and who it suits." rows={3} value={f.description} onChange={set("description")} error={err["description"]} />
      <div className="k-grid">
        <SelectField label="How you charge" value={f.pricingModel} onChange={set("pricingModel")} error={err["pricingModel"]}>
          {Object.entries(PRICING_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </SelectField>
        {!quoted && <TextField label="Price (₹)" type="number" inputMode="decimal" min={0} step="0.01" value={f.price} onChange={set("price")} error={err["priceMinor"]} />}
        <TextField label="Duration (minutes)" type="number" inputMode="numeric" min={5} max={1440} value={f.durationMinutes} onChange={set("durationMinutes")} error={err["durationMinutes"]} />
        <TextField label="Fewest children" type="number" inputMode="numeric" min={1} value={f.minParticipants} onChange={set("minParticipants")} error={err["minParticipants"]} />
        <TextField label="Most children" type="number" inputMode="numeric" min={1} value={f.maxParticipants} onChange={set("maxParticipants")} error={err["maxParticipants"]} />
        <TextField label="Youngest age" type="number" inputMode="numeric" min={0} value={f.ageMin} onChange={set("ageMin")} error={err["ageMin"]} />
        <TextField label="Oldest age" type="number" inputMode="numeric" min={0} value={f.ageMax} onChange={set("ageMax")} error={err["ageMax"]} />
      </div>
      <TextAreaField label="Equipment you bring or need" rows={2} value={f.equipment} onChange={set("equipment")} error={err["equipment"]} />
      <TextAreaField label="Venue requirements" rows={2} value={f.venueRequirements} onChange={set("venueRequirements")} error={err["venueRequirements"]} />
      <TextAreaField label="Additional charges" rows={2} value={f.additionalCharges} onChange={set("additionalCharges")} error={err["additionalCharges"]} />
      <TextAreaField label="Terms" rows={2} value={f.terms} onChange={set("terms")} error={err["terms"]} />
      <TextAreaField label="Cancellation policy" hint="Required before you can publish." rows={2} value={f.cancellationPolicy} onChange={set("cancellationPolicy")} error={err["cancellationPolicy"]} />
      <div className="k-row">
        <Button type="submit" loading={submit.submitting}>
          {initial ? "Save offering" : "Add offering"}
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

function OfferingRow({ vendorId, offering, categories, onChanged }: { vendorId: string; offering: Offering; categories: Category[]; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const submit = useSubmit();
  const hints = publishHints(offering);
  const st = OFFERING_STATUS[offering.status];

  async function setStatus(status: Offering["status"]) {
    const res = await submit.run(() => api(`/vendors/${vendorId}/offerings/${offering.id}`, { method: "PATCH", body: { status } }));
    if (res) onChanged();
  }

  if (editing) {
    return (
      <OfferingForm
        vendorId={vendorId}
        initial={offering}
        categories={categories}
        onCancel={() => setEditing(false)}
        onDone={() => {
          setEditing(false);
          onChanged();
        }}
      />
    );
  }
  return (
    <div className="k-stack k-stack-sm">
      <div className="k-row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>{offering.name}</strong> <Badge tone={st.tone}>{st.label}</Badge> <Badge>{offering.category}</Badge>
          <div className="k-muted">
            {formatPrice(offering)}
            {offering.durationMinutes ? ` · ${offering.durationMinutes} min` : ""}
            {offering.ageMin !== null || offering.ageMax !== null ? ` · Ages ${offering.ageMin ?? 0}–${offering.ageMax ?? "any"}` : ""}
          </div>
        </div>
        <div className="k-row">
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            Edit<span className="k-sr-only"> {offering.name}</span>
          </Button>
          {offering.status !== "published" && (
            <Button size="sm" disabled={hints.length > 0} loading={submit.submitting} onClick={() => void setStatus("published")}>
              Publish<span className="k-sr-only"> {offering.name}</span>
            </Button>
          )}
          {offering.status === "published" && (
            <Button size="sm" variant="secondary" loading={submit.submitting} onClick={() => void setStatus("draft")}>
              Unpublish<span className="k-sr-only"> {offering.name}</span>
            </Button>
          )}
          {offering.status !== "archived" && (
            <Button size="sm" variant="ghost" loading={submit.submitting} onClick={() => void setStatus("archived")}>
              Archive<span className="k-sr-only"> {offering.name}</span>
            </Button>
          )}
        </div>
      </div>
      <ErrorSummary submit={submit} />
      {offering.status !== "published" && hints.length > 0 && (
        <Alert variant="info" title={`Before you can publish ${offering.name}`}>
          <ul>
            {hints.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </Alert>
      )}
    </div>
  );
}

export function OfferingsSection({ id }: { id: string }) {
  const loader = useCallback(() => api<{ data: Offering[] }>(`/vendors/${id}/offerings`), [id]);
  const { state, reload } = useLoad(loader);
  const catLoader = useCallback(() => api<{ data: Category[] }>("/categories"), []);
  const cats = useLoad(catLoader);
  const categories = cats.state.status === "ready" ? cats.state.data.data : [];
  return (
    <Card>
      <h2>Offerings</h2>
      <p className="k-muted">What families can book. Only published offerings are shown, and only in communities that have approved you.</p>
      {state.status === "loading" && <Skeleton height="3rem" />}
      {state.status === "error" && <Alert variant="danger">We could not load the offerings.</Alert>}
      {state.status === "ready" && state.data.data.length === 0 && <EmptyState title="No offerings yet">Add your first offering below.</EmptyState>}
      {state.status === "ready" && state.data.data.length > 0 && (
        <ul className="k-stack k-stack-lg" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {state.data.data.map((o) => (
            <li key={o.id}>
              <OfferingRow vendorId={id} offering={o} categories={categories} onChanged={reload} />
            </li>
          ))}
        </ul>
      )}
      {cats.state.status === "ready" && (
        <div style={{ marginTop: "var(--k-space-5)" }}>
          <h3>Add an offering</h3>
          <OfferingForm vendorId={id} categories={categories} onDone={reload} />
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------- availability */

interface Availability {
  weeklyHours: { weekday: number; startTime: string; endTime: string }[];
  unavailable: { id: string; startsAt: string; endsAt: string; reason: string | null }[];
}
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

interface Slot {
  enabled: boolean;
  start: string;
  end: string;
}

function WeeklyHours({ id, current, onSaved }: { id: string; current: Availability["weeklyHours"]; onSaved: () => void }) {
  const submit = useSubmit();
  const [saved, setSaved] = useState(false);
  // One slot per day is enough for a pilot; days with several slots are shown by their first slot and kept if left untouched.
  const [days, setDays] = useState<Slot[]>(() =>
    WEEKDAYS.map((_, d) => {
      const first = current.find((r) => r.weekday === d);
      return { enabled: Boolean(first), start: first?.startTime ?? "09:00", end: first?.endTime ?? "17:00" };
    }),
  );
  const multi = WEEKDAYS.some((_, d) => current.filter((r) => r.weekday === d).length > 1);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const rules = days.flatMap((d, weekday) => (d.enabled ? [{ weekday, startTime: d.start, endTime: d.end }] : []));
    const res = await submit.run(() => api(`/vendors/${id}/availability/weekly-hours`, { method: "PUT", body: { rules } }));
    if (res) {
      setSaved(true);
      onSaved();
    }
  }
  const update = (i: number, patch: Partial<Slot>) => setDays((cur) => cur.map((d, k) => (k === i ? { ...d, ...patch } : d)));

  return (
    <form onSubmit={save} className="k-stack" noValidate aria-label="Weekly hours">
      <ErrorSummary submit={submit} />
      {multi && <Alert variant="warning">Some days have more than one time slot. Saving here keeps one slot per day.</Alert>}
      {days.map((d, i) => (
        <div key={WEEKDAYS[i]} className="k-row">
          <div style={{ flex: "0 0 10rem" }}>
            <CheckboxField label={WEEKDAYS[i] ?? ""} checked={d.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} />
          </div>
          {d.enabled && (
            <>
              <TextField label={`${WEEKDAYS[i]} from`} type="time" value={d.start} onChange={(e) => update(i, { start: e.target.value })} />
              <TextField label={`${WEEKDAYS[i]} until`} type="time" value={d.end} onChange={(e) => update(i, { end: e.target.value })} />
            </>
          )}
        </div>
      ))}
      <div className="k-row">
        <Button type="submit" loading={submit.submitting}>
          Save weekly hours
        </Button>
        {saved && <span role="status">Saved</span>}
      </div>
    </form>
  );
}

function TimeOff({ id, blocks, onChanged }: { id: string; blocks: Availability["unavailable"]; onChanged: () => void }) {
  const submit = useSubmit();
  const removal = useSubmit();
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");

  async function add(e: FormEvent) {
    e.preventDefault();
    const body = { startsAt: new Date(from).toISOString(), endsAt: new Date(until).toISOString(), reason: blank(reason) };
    const res = await submit.run(() => api(`/vendors/${id}/availability/unavailable`, { method: "POST", body }));
    if (res) {
      setFrom("");
      setUntil("");
      setReason("");
      onChanged();
    }
  }
  async function remove(blockId: string) {
    const ok = await removal.run(async () => {
      await api(`/vendors/${id}/availability/unavailable/${blockId}`, { method: "DELETE" });
      return true;
    });
    if (ok) onChanged();
  }

  return (
    <div className="k-stack">
      <h3>Time off</h3>
      <ErrorSummary submit={removal} />
      {blocks.length === 0 ? (
        <p className="k-muted">No time off planned.</p>
      ) : (
        <ul className="k-stack k-stack-sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {blocks.map((b) => (
            <li key={b.id} className="k-row" style={{ justifyContent: "space-between" }}>
              <span>
                {new Date(b.startsAt).toLocaleString()} – {new Date(b.endsAt).toLocaleString()}
                {b.reason ? ` · ${b.reason}` : ""}
              </span>
              <Button size="sm" variant="secondary" onClick={() => void remove(b.id)}>
                Remove<span className="k-sr-only"> time off starting {new Date(b.startsAt).toLocaleDateString()}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="k-stack" noValidate aria-label="Add time off">
        <ErrorSummary submit={submit} />
        <div className="k-grid">
          <TextField label="Unavailable from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} error={submit.error?.fields["startsAt"]} />
          <TextField label="Unavailable until" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} error={submit.error?.fields["endsAt"]} />
          <TextField label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div>
          <Button type="submit" variant="secondary" loading={submit.submitting} disabled={from === "" || until === ""}>
            Add time off
          </Button>
        </div>
      </form>
    </div>
  );
}

export function AvailabilitySection({ id }: { id: string }) {
  const loader = useCallback(() => api<Availability>(`/vendors/${id}/availability`), [id]);
  const { state, reload } = useLoad(loader);
  return (
    <Card>
      <h2>Availability</h2>
      <p className="k-muted">The hours you normally work, and any time off. Families will see this when booking opens.</p>
      {state.status === "loading" && <Skeleton height="4rem" />}
      {state.status === "error" && <Alert variant="danger">We could not load availability.</Alert>}
      {state.status === "ready" && (
        <div className="k-stack k-stack-lg">
          <WeeklyHours id={id} current={state.data.weeklyHours} onSaved={reload} />
          <TimeOff id={id} blocks={state.data.unavailable} onChanged={reload} />
        </div>
      )}
    </Card>
  );
}
