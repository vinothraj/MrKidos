"use client";

import { Alert, Badge, Button, Card, CheckboxField, EmptyState, FieldGroup, SelectField, Skeleton, TextAreaField, TextField } from "@kidos/ui";
import { useCallback, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import { useSession } from "@/lib/session";
import { useLoad } from "@/lib/use-load";
import { STATUS_LABEL } from "./community-detail";
import { AvailabilitySection, DocumentsSection, OfferingsSection } from "./vendor-work";

export type VendorStatus = "draft" | "verification" | "active" | "suspended";

export interface Vendor {
  id: string;
  name: string;
  status: VendorStatus;
  businessType: string | null;
  tagline: string | null;
  description: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  locality: string | null;
  yearsExperience: number | null;
  website: string | null;
  legalName: string | null;
  registrationNumber: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  internalNotes: string | null;
  transitions: { to: VendorStatus; noteRequired: boolean; blockers: string[] }[];
  categoryIds: string[];
  /** Only for active vendors: whether the required documents are still current. */
  vetting: { state: "current" | "expiring" | "lapsed"; validUntil: string | null } | null;
}

export interface Category {
  id: string;
  parentId: string | null;
  key: string;
  name: string;
  isActive: boolean;
}

const blank = (v: string): string | null => (v.trim() === "" ? null : v.trim());
const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

/* ------------------------------------------------------------------ profile */

function ProfileForm({ vendor, onSaved }: { vendor: Vendor; onSaved: () => void }) {
  const { me } = useSession();
  const submit = useSubmit();
  const [saved, setSaved] = useState(false);
  const [f, setF] = useState({
    name: vendor.name,
    businessType: vendor.businessType ?? "individual",
    tagline: vendor.tagline ?? "",
    description: vendor.description ?? "",
    country: vendor.country ?? "",
    state: vendor.state ?? "",
    city: vendor.city ?? "",
    locality: vendor.locality ?? "",
    yearsExperience: vendor.yearsExperience?.toString() ?? "",
    website: vendor.website ?? "",
    legalName: vendor.legalName ?? "",
    registrationNumber: vendor.registrationNumber ?? "",
    contactName: vendor.contactName ?? "",
    contactEmail: vendor.contactEmail ?? "",
    contactPhone: vendor.contactPhone ?? "",
    address: vendor.address ?? "",
    internalNotes: vendor.internalNotes ?? "",
  });
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF((cur) => ({ ...cur, [key]: e.target.value }));
  const err = submit.error?.fields ?? {};

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const body = {
      name: f.name.trim(),
      businessType: f.businessType,
      tagline: blank(f.tagline),
      description: blank(f.description),
      country: blank(f.country),
      state: blank(f.state),
      city: blank(f.city),
      locality: blank(f.locality),
      yearsExperience: num(f.yearsExperience),
      website: blank(f.website),
      legalName: blank(f.legalName),
      registrationNumber: blank(f.registrationNumber),
      contactName: blank(f.contactName),
      contactEmail: blank(f.contactEmail),
      contactPhone: blank(f.contactPhone),
      address: blank(f.address),
      // Internal notes belong to the platform team; the API refuses them from anyone else, so they are not even sent.
      ...(me.platformScope ? { internalNotes: blank(f.internalNotes) } : {}),
    };
    const res = await submit.run(() => api(`/vendors/${vendor.id}`, { method: "PATCH", body }));
    if (res) {
      setSaved(true);
      onSaved();
    }
  }

  return (
    <form onSubmit={onSubmit} className="k-stack" noValidate aria-label="Business details">
      {saved && <Alert variant="success">Details saved.</Alert>}
      <ErrorSummary submit={submit} />
      <TextField label="Business name" required value={f.name} onChange={set("name")} error={err["name"]} />
      <SelectField label="Type" value={f.businessType} onChange={set("businessType")} error={err["businessType"]}>
        <option value="individual">Individual</option>
        <option value="business">Registered business</option>
      </SelectField>
      <TextField label="Tagline" hint="One line families see first." value={f.tagline} onChange={set("tagline")} error={err["tagline"]} />
      <TextAreaField label="About the business" hint="Shown to residents. Do not include phone numbers or private details." rows={4} value={f.description} onChange={set("description")} error={err["description"]} />
      <div className="k-grid">
        <TextField label="Country" value={f.country} onChange={set("country")} error={err["country"]} />
        <TextField label="State" value={f.state} onChange={set("state")} error={err["state"]} />
        <TextField label="City" value={f.city} onChange={set("city")} error={err["city"]} />
        <TextField label="Locality or area" value={f.locality} onChange={set("locality")} error={err["locality"]} />
        <TextField label="Years of experience" type="number" inputMode="numeric" min={0} value={f.yearsExperience} onChange={set("yearsExperience")} error={err["yearsExperience"]} />
        <TextField label="Website" type="url" hint="Starts with https://" value={f.website} onChange={set("website")} error={err["website"]} />
      </div>
      <h3>Private details</h3>
      <p className="k-muted">Only this business&rsquo;s own team and the platform team can see these. Residents never do.</p>
      <div className="k-grid">
        <TextField label="Legal name" value={f.legalName} onChange={set("legalName")} error={err["legalName"]} />
        <TextField label="Registration number" value={f.registrationNumber} onChange={set("registrationNumber")} error={err["registrationNumber"]} />
        <TextField label="Contact person" value={f.contactName} onChange={set("contactName")} error={err["contactName"]} />
        <TextField label="Contact email" type="email" value={f.contactEmail} onChange={set("contactEmail")} error={err["contactEmail"]} />
        <TextField label="Contact phone" type="tel" value={f.contactPhone} onChange={set("contactPhone")} error={err["contactPhone"]} />
      </div>
      <TextField label="Business address" value={f.address} onChange={set("address")} error={err["address"]} />
      {me.platformScope && (
        <TextAreaField label="Platform team notes" hint="Visible to the platform team only. The vendor cannot see these." rows={3} value={f.internalNotes} onChange={set("internalNotes")} error={err["internalNotes"]} />
      )}
      <div>
        <Button type="submit" loading={submit.submitting}>
          Save details
        </Button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------- status workflow */

const ACTION_LABEL = (from: VendorStatus, to: VendorStatus): string => {
  if (to === "verification") return "Submit for verification";
  if (to === "draft") return "Send back for changes";
  if (to === "suspended") return "Suspend vendor";
  return from === "suspended" ? "Reinstate vendor" : "Approve and activate";
};

function StatusPanel({ vendor, onChanged }: { vendor: Vendor; onChanged: () => void }) {
  const submit = useSubmit();
  const [note, setNote] = useState("");
  const historyLoader = useCallback(
    () => api<{ data: { id: string; from: string | null; to: string; note: string | null; changedBy: string | null; at: string }[] }>(`/vendors/${vendor.id}/history`),
    [vendor.id],
  );
  const history = useLoad(historyLoader);
  const status = STATUS_LABEL[vendor.status];

  async function go(to: VendorStatus) {
    const res = await submit.run(() => api(`/vendors/${vendor.id}/transitions`, { method: "POST", body: { to, ...(note.trim() ? { note: note.trim() } : {}) } }));
    if (res) {
      setNote("");
      onChanged();
      history.reload();
    }
  }

  const needsNote = vendor.transitions.some((t) => t.noteRequired);
  return (
    <Card>
      <div className="k-row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Status</h2>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <p className="k-muted">
        {vendor.status === "draft" && "Complete the profile, choose categories and the places you serve, then submit for verification."}
        {vendor.status === "verification" && "The platform team reviews your documents. Once every required document is verified, you can be approved."}
        {vendor.status === "active" && "Communities that you serve can approve you, and families can then find your offerings."}
        {vendor.status === "suspended" && "Your offerings are hidden from families while this vendor is suspended."}
      </p>
      {vendor.vetting?.state === "lapsed" && (
        <Alert variant="danger" title="Hidden from families until your documents are renewed">
          A required document has expired or is no longer verified. Families cannot see this vendor or its offerings until a current document is submitted and verified (see Documents).
        </Alert>
      )}
      {vendor.vetting?.state === "expiring" && (
        <Alert variant="warning" title="A required document expires soon">
          Submit a renewed document before {vendor.vetting.validUntil} so this vendor stays visible to families.
        </Alert>
      )}
      {vendor.transitions.length === 0 ? (
        <p className="k-muted">You do not have a step available for this vendor.</p>
      ) : (
        <div className="k-stack">
          <ErrorSummary submit={submit} />
          {vendor.transitions.map((t) =>
            t.blockers.length > 0 ? (
              <Alert key={t.to} variant="info" title={`Before you can ${ACTION_LABEL(vendor.status, t.to).toLowerCase()}`}>
                <ul>
                  {t.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </Alert>
            ) : null,
          )}
          {needsNote && <TextAreaField label="Note" hint="Recorded in the history. Required for this step." rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
          <div className="k-row">
            {vendor.transitions.map((t) => (
              <Button key={t.to} variant={t.to === "suspended" || t.to === "draft" ? "secondary" : "primary"} disabled={t.blockers.length > 0} loading={submit.submitting} onClick={() => void go(t.to)}>
                {ACTION_LABEL(vendor.status, t.to)}
              </Button>
            ))}
          </div>
        </div>
      )}
      {history.state.status === "ready" && history.state.data.data.length > 0 && (
        <>
          <h3 style={{ marginTop: "var(--k-space-5)" }}>History</h3>
          <ol style={{ paddingLeft: "var(--k-space-5)", margin: 0 }}>
            {history.state.data.data.map((h) => (
              <li key={h.id}>
                <strong>
                  {h.from ? `${STATUS_LABEL[h.from as VendorStatus]?.label ?? h.from} → ` : ""}
                  {STATUS_LABEL[h.to as VendorStatus]?.label ?? h.to}
                </strong>{" "}
                <span className="k-muted">
                  {new Date(h.at).toLocaleString()}
                  {h.changedBy ? ` · ${h.changedBy}` : ""}
                </span>
                {h.note && <div>{h.note}</div>}
              </li>
            ))}
          </ol>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------- categories and places served */

function CategoriesSection({ vendor, canEdit, onChanged }: { vendor: Vendor; canEdit: boolean; onChanged: () => void }) {
  const loader = useCallback(() => api<{ data: Category[] }>("/categories"), []);
  const { state } = useLoad(loader);
  const submit = useSubmit();
  const [selected, setSelected] = useState<string[]>(vendor.categoryIds);
  const [saved, setSaved] = useState(false);
  const dirty = [...selected].sort().join() !== [...vendor.categoryIds].sort().join();

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const res = await submit.run(() => api(`/vendors/${vendor.id}/categories`, { method: "PUT", body: { categoryIds: selected } }));
    if (res) {
      setSaved(true);
      onChanged();
    }
  }

  return (
    <Card>
      <h2>Categories</h2>
      <p className="k-muted">Where families should find you. Choose every category you offer.</p>
      {state.status === "loading" && <Skeleton height="4rem" />}
      {state.status === "error" && <Alert variant="danger">We could not load the categories.</Alert>}
      {state.status === "ready" && (
        <form onSubmit={save} className="k-stack" noValidate aria-label="Categories">
          <ErrorSummary submit={submit} />
          {state.data.data
            .filter((p) => p.parentId === null && p.isActive)
            .map((parent) => (
              <FieldGroup key={parent.id} legend={parent.name}>
                {state.data.data
                  .filter((c) => c.parentId === parent.id && c.isActive)
                  .map((c) => (
                    <CheckboxField
                      key={c.id}
                      label={c.name}
                      checked={selected.includes(c.id)}
                      disabled={!canEdit}
                      onChange={(e) => setSelected((cur) => (e.target.checked ? [...cur, c.id] : cur.filter((x) => x !== c.id)))}
                    />
                  ))}
              </FieldGroup>
            ))}
          {canEdit && (
            <div className="k-row">
              <Button type="submit" disabled={!dirty} loading={submit.submitting}>
                Save categories
              </Button>
              {saved && !dirty && <span role="status">Saved</span>}
            </div>
          )}
        </form>
      )}
    </Card>
  );
}

interface Area {
  id: string;
  communityId: string | null;
  communityName: string | null;
  city: string | null;
  travelFeeMinor: number;
  travelNote: string | null;
}
interface DirectoryCommunity {
  id: string;
  name: string;
  city: string | null;
}

function ServiceAreasSection({ id, canEdit, onChanged }: { id: string; canEdit: boolean; onChanged: () => void }) {
  const loader = useCallback(() => api<{ data: Area[] }>(`/vendors/${id}/service-areas`), [id]);
  const { state, reload } = useLoad(loader);
  const directoryLoader = useCallback(() => api<{ data: DirectoryCommunity[] }>("/directory/communities?limit=50"), []);
  const directory = useLoad(directoryLoader);
  const submit = useSubmit();
  const removal = useSubmit();
  const [kind, setKind] = useState<"community" | "city">("community");
  const [communityId, setCommunityId] = useState("");
  const [city, setCity] = useState("");
  const [fee, setFee] = useState("0");

  async function add(e: FormEvent) {
    e.preventDefault();
    const body = {
      ...(kind === "community" ? { communityId } : { city: city.trim() }),
      travelFeeMinor: Math.round(Number(fee || "0") * 100),
    };
    const res = await submit.run(() => api(`/vendors/${id}/service-areas`, { method: "POST", body }));
    if (res) {
      setCommunityId("");
      setCity("");
      reload();
      onChanged();
    }
  }
  async function remove(areaId: string) {
    const ok = await removal.run(async () => {
      await api(`/vendors/${id}/service-areas/${areaId}`, { method: "DELETE" });
      return true;
    });
    if (ok) {
      reload();
      onChanged();
    }
  }

  return (
    <Card>
      <h2>Places you serve</h2>
      <p className="k-muted">Families in a community see you only if you list it here and the community approves you.</p>
      <ErrorSummary submit={removal} />
      {state.status === "loading" && <Skeleton height="3rem" />}
      {state.status === "ready" && state.data.data.length === 0 && <EmptyState title="No places yet">Add at least one community or city before you can submit for verification.</EmptyState>}
      {state.status === "ready" && state.data.data.length > 0 && (
        <ul className="k-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {state.data.data.map((a) => {
            const label = a.communityName ?? a.city ?? "Unknown place";
            return (
              <li key={a.id} className="k-row" style={{ justifyContent: "space-between" }}>
                <div>
                  <strong>{label}</strong> <Badge>{a.communityId ? "Community" : "City"}</Badge>
                  <div className="k-muted">{a.travelFeeMinor > 0 ? `Travel fee ${(a.travelFeeMinor / 100).toFixed(2)}` : "No travel fee"}</div>
                </div>
                {canEdit && (
                  <Button size="sm" variant="secondary" onClick={() => void remove(a.id)}>
                    Remove<span className="k-sr-only"> {label}</span>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && (
        <form onSubmit={add} className="k-stack" noValidate aria-label="Add a place you serve" style={{ marginTop: "var(--k-space-4)" }}>
          <ErrorSummary submit={submit} />
          <div className="k-grid">
            <SelectField label="Kind of place" value={kind} onChange={(e) => setKind(e.target.value as "community" | "city")}>
              <option value="community">A community</option>
              <option value="city">A whole city</option>
            </SelectField>
            {kind === "community" ? (
              <SelectField label="Community" value={communityId} onChange={(e) => setCommunityId(e.target.value)} error={submit.error?.fields["communityId"]}>
                <option value="">Choose a community</option>
                {directory.state.status === "ready" &&
                  directory.state.data.data.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.city ? `, ${c.city}` : ""}
                    </option>
                  ))}
              </SelectField>
            ) : (
              <TextField label="City" value={city} onChange={(e) => setCity(e.target.value)} error={submit.error?.fields["city"]} />
            )}
            <TextField label="Travel fee (optional)" type="number" inputMode="decimal" min={0} step="0.01" value={fee} onChange={(e) => setFee(e.target.value)} />
          </div>
          <div>
            <Button type="submit" variant="secondary" loading={submit.submitting} disabled={kind === "community" ? communityId === "" : city.trim() === ""}>
              Add place
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

/* --------------------------------------------------------------------- team */

interface Person {
  userId: string;
  displayName: string;
  email: string;
  status: string;
  roles: string[];
}
const ROLE_LABEL: Record<string, string> = {
  vendor_owner: "Owner",
  vendor_admin: "Administrator",
  vendor_staff: "Staff",
  vendor_service_provider: "Service provider",
};

function TeamSection({ id, canManage }: { id: string; canManage: boolean }) {
  const { me } = useSession();
  const loader = useCallback(() => api<{ data: Person[] }>(`/vendors/${id}/staff`), [id]);
  const { state, reload } = useLoad(loader);
  const submit = useSubmit();
  const removal = useSubmit();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("vendor_staff");

  async function add(e: FormEvent) {
    e.preventDefault();
    const res = await submit.run(() => api(`/vendors/${id}/staff`, { method: "POST", body: { email, role } }));
    if (res) {
      setEmail("");
      reload();
    }
  }
  async function remove(userId: string) {
    const ok = await removal.run(async () => {
      await api(`/vendors/${id}/staff/${userId}`, { method: "DELETE" });
      return true;
    });
    if (ok) reload();
  }

  return (
    <Card>
      <h2>Team</h2>
      <p className="k-muted">People who can work on this vendor&rsquo;s behalf. Each needs an account first.</p>
      <ErrorSummary submit={removal} />
      {state.status === "loading" && <Skeleton height="3rem" />}
      {state.status === "error" && <Alert variant="danger">We could not load the team.</Alert>}
      {state.status === "ready" && state.data.data.length === 0 && <EmptyState title="No team members yet">Add an owner so the business can manage itself.</EmptyState>}
      {state.status === "ready" && state.data.data.length > 0 && (
        <ul className="k-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {state.data.data.map((p) => (
            <li key={p.userId} className="k-row" style={{ justifyContent: "space-between" }}>
              <div>
                <strong>{p.displayName}</strong> {p.roles.map((r) => <Badge key={r}>{ROLE_LABEL[r] ?? r}</Badge>)}
                <div className="k-muted">{p.email}</div>
              </div>
              {canManage && p.userId !== me.user.id && (
                <Button size="sm" variant="secondary" onClick={() => void remove(p.userId)}>
                  Remove<span className="k-sr-only"> {p.displayName}</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <form onSubmit={add} className="k-stack" noValidate aria-label="Add a team member" style={{ marginTop: "var(--k-space-4)" }}>
          <ErrorSummary submit={submit} />
          <div className="k-grid">
            <TextField label="Email of the person to add" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} error={submit.error?.fields["email"]} />
            <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
              {me.platformScope && <option value="vendor_owner">Owner</option>}
              <option value="vendor_admin">Administrator</option>
              <option value="vendor_staff">Staff</option>
              <option value="vendor_service_provider">Service provider</option>
            </SelectField>
          </div>
          <div>
            <Button type="submit" variant="secondary" loading={submit.submitting} disabled={email.trim() === ""}>
              Add to team
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

/* --------------------------------------------------------------------- page */

const SECTIONS = [
  { id: "status", label: "Status" },
  { id: "details", label: "Details" },
  { id: "categories", label: "Categories" },
  { id: "places", label: "Places served" },
  { id: "documents", label: "Documents" },
  { id: "offerings", label: "Offerings" },
  { id: "availability", label: "Availability" },
  { id: "team", label: "Team" },
];

export function VendorDetail({ id }: { id: string }) {
  const { can, me } = useSession();
  const loader = useCallback(() => api<Vendor>(`/vendors/${id}`), [id]);
  const { state, reload } = useLoad(loader);

  if (state.status === "loading") return <Skeleton height="8rem" />;
  if (state.status === "error") {
    const notFound = state.error instanceof ApiError && state.error.status === 404;
    return (
      <Alert variant="danger" title={notFound ? "Vendor not found" : "We could not load this vendor"}>
        {notFound ? "It may not exist, or you may not have access to it." : "Please try again in a moment."}
      </Alert>
    );
  }
  const v = state.data;
  const status = STATUS_LABEL[v.status];
  // Section visibility mirrors the permissions the API enforces (the API remains the only enforcement point).
  const show = {
    edit: can("vendors.update"),
    documents: can("vendor_documents.manage"),
    offerings: can("offerings.manage"),
    availability: can("availability.manage"),
    team: can("vendors.read"),
  };
  const sections = SECTIONS.filter((s) => (s.id === "documents" ? show.documents : s.id === "offerings" ? show.offerings : s.id === "availability" ? show.availability : s.id === "team" ? show.team : true));

  return (
    <div className="k-stack k-stack-lg">
      <div>
        <div className="k-row">
          <h1 style={{ margin: 0 }}>{v.name}</h1>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        <p className="k-muted">{v.tagline ?? ([v.locality, v.city, v.state].filter(Boolean).join(", ") || "Profile not completed yet")}</p>
      </div>
      <nav aria-label="On this page">
        <ul className="k-section-nav">
          {sections.map((s) => (
            <li key={s.id}>
              <a className="k-btn k-btn-secondary k-btn-sm" href={`#${s.id}`}>
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <section id="status" aria-label="Status">
        <StatusPanel vendor={v} onChanged={reload} />
      </section>
      <section id="details" aria-labelledby="vendor-details-title">
        <Card>
          <h2 id="vendor-details-title">Details</h2>
          {show.edit ? <ProfileForm vendor={v} onSaved={reload} /> : <p className="k-muted">You can view but not change these details.</p>}
        </Card>
      </section>
      <section id="categories" aria-label="Categories">
        <CategoriesSection vendor={v} canEdit={show.edit} onChanged={reload} />
      </section>
      <section id="places" aria-label="Places served">
        <ServiceAreasSection id={id} canEdit={show.edit} onChanged={reload} />
      </section>
      {show.documents && (
        <section id="documents" aria-label="Documents">
          <DocumentsSection id={id} canReview={me.platformScope && can("vendors.vet")} onChanged={reload} />
        </section>
      )}
      {show.offerings && (
        <section id="offerings" aria-label="Offerings">
          <OfferingsSection id={id} />
        </section>
      )}
      {show.availability && (
        <section id="availability" aria-label="Availability">
          <AvailabilitySection id={id} />
        </section>
      )}
      {show.team && (
        <section id="team" aria-label="Team">
          <TeamSection id={id} canManage={can("vendor_staff.manage")} />
        </section>
      )}
    </div>
  );
}
