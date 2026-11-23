"use client";

import { Alert, Badge, Button, ButtonLink, EmptyState, NextSteps, ReviewList, SelectField, Skeleton, TableWrap, TextField, Wizard } from "@kidos/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ErrorSummary, useDraft, useSubmit } from "@/lib/forms";
import { STATUS_LABEL } from "./community-detail";
import { PlatformModeGate } from "./communities-admin";
import type { VendorStatus } from "./vendor-detail";

interface Row {
  id: string;
  name: string;
  status: VendorStatus;
  businessType: string | null;
  city: string | null;
  locality: string | null;
  vetting: { state: "current" | "expiring" | "lapsed"; validUntil: string | null } | null;
  createdAt: string;
}
interface Page {
  data: Row[];
  page: { hasMore: boolean; nextCursor: string | null };
}

async function fetchPage(status: string, q: string, vetting: string, cursor: string | null): Promise<Page | "error"> {
  const qs = new URLSearchParams({ limit: "25" });
  if (status) qs.set("status", status);
  if (q) qs.set("q", q);
  if (vetting) qs.set("vetting", vetting);
  if (cursor) qs.set("cursor", cursor);
  try {
    return await api<Page>(`/vendors?${qs.toString()}`);
  } catch {
    return "error";
  }
}

function VendorTable({ status, q, vetting }: { status: string; q: string; vetting: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchPage(status, q, vetting, null).then((r) => {
      if (!active) return;
      if (r === "error") setFailed(true);
      else {
        setRows(r.data);
        setCursor(r.page.nextCursor);
      }
    });
    return () => {
      active = false;
    };
  }, [status, q, vetting]);

  async function loadMore() {
    setMore(true);
    const r = await fetchPage(status, q, vetting, cursor);
    if (r === "error") setFailed(true);
    else {
      setRows((cur) => [...(cur ?? []), ...r.data]);
      setCursor(r.page.nextCursor);
    }
    setMore(false);
  }

  if (failed) return <Alert variant="danger">We could not load the vendors. Please try again.</Alert>;
  if (rows === null) return <Skeleton height="4rem" />;
  if (rows.length === 0) return <EmptyState title="No vendors found">{status || q || vetting ? "Try a different filter." : "Register the first vendor to get started."}</EmptyState>;
  return (
    <>
      <TableWrap label="Vendors">
        <table className="k-table" aria-label="Vendors">
          <thead>
            <tr>
              <th scope="col">Vendor</th>
              <th scope="col">Type</th>
              <th scope="col">Area</th>
              <th scope="col">Status</th>
              <th scope="col">Documents</th>
              <th scope="col">Registered</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/app/vendors/${r.id}`}>{r.name}</Link>
                </td>
                <td>{r.businessType === "business" ? "Business" : r.businessType === "individual" ? "Individual" : "—"}</td>
                <td>{[r.locality, r.city].filter(Boolean).join(", ") || "—"}</td>
                <td>
                  <Badge tone={STATUS_LABEL[r.status].tone}>{STATUS_LABEL[r.status].label}</Badge>
                </td>
                <td>
                  {r.vetting?.state === "lapsed" && <Badge tone="danger">Lapsed: hidden from families</Badge>}
                  {r.vetting?.state === "expiring" && <Badge tone="warning">Expires {r.vetting.validUntil}</Badge>}
                  {r.vetting?.state === "current" && <Badge tone="success">Current</Badge>}
                  {!r.vetting && "—"}
                </td>
                <td>{new Date(r.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {cursor && (
        <div style={{ marginTop: "var(--k-space-4)" }}>
          <Button variant="secondary" loading={more} onClick={() => void loadMore()}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}

export function VendorsList() {
  const [status, setStatus] = useState("");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [vetting, setVetting] = useState("");
  return (
    <div className="k-stack k-stack-lg">
      <div className="k-row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Vendors</h1>
          <p className="k-muted">Register service providers, verify their documents and bring them live.</p>
        </div>
        <ButtonLink href="/app/vendors/new">Register a vendor</ButtonLink>
      </div>
      <PlatformModeGate>
        <form
          className="k-row"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(qInput.trim());
          }}
        >
          <div style={{ flex: "1 1 14rem" }}>
            <TextField label="Search by name or city" value={qInput} onChange={(e) => setQInput(e.target.value)} />
          </div>
          <div style={{ flex: "0 1 14rem" }}>
            <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="verification">In verification</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </SelectField>
          </div>
          <div style={{ flex: "0 1 16rem" }}>
            <SelectField label="Documents" value={vetting} onChange={(e) => setVetting(e.target.value)}>
              <option value="">Any</option>
              <option value="lapsed">Lapsed (hidden from families)</option>
              <option value="expiring">Expiring within 30 days</option>
            </SelectField>
          </div>
          <Button type="submit" variant="secondary" style={{ alignSelf: "flex-end" }}>
            Search
          </Button>
        </form>
        <VendorTable key={`${status}|${q}|${vetting}`} status={status} q={q} vetting={vetting} />
      </PlatformModeGate>
    </div>
  );
}

export function VendorNew() {
  const router = useRouter();
  const submit = useSubmit();
  const [f, setF, clearDraft, restored] = useDraft("vendor-new", { name: "", businessType: "individual", country: "India", state: "", city: "", contactName: "", contactEmail: "", contactPhone: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((c) => ({ ...c, [k]: e.target.value }));
  const err = submit.error?.fields ?? {};

  async function onSubmit() {
    const blank = (v: string) => (v.trim() === "" ? undefined : v.trim());
    const body = {
      name: f.name.trim(),
      businessType: f.businessType,
      ...(blank(f.country) ? { country: blank(f.country) } : {}),
      ...(blank(f.state) ? { state: blank(f.state) } : {}),
      ...(blank(f.city) ? { city: blank(f.city) } : {}),
      ...(blank(f.contactName) ? { contactName: blank(f.contactName) } : {}),
      ...(blank(f.contactEmail) ? { contactEmail: blank(f.contactEmail) } : {}),
      ...(blank(f.contactPhone) ? { contactPhone: blank(f.contactPhone) } : {}),
    };
    const created = await submit.run(() => api<{ id: string }>("/vendors", { method: "POST", body }));
    if (created) {
      clearDraft();
      router.push(`/app/vendors/${created.id}`);
    }
  }

  return (
    <div className="k-stack k-stack-lg">
      <div>
        <h1>Register a vendor</h1>
        <p className="k-muted">Four short steps. Only the business name is required now. Profile, categories, places served and documents come on the next screen.</p>
      </div>
      <PlatformModeGate>
        <Wizard
          label="Register a vendor"
          submitLabel="Register vendor"
          submitting={submit.submitting}
          onSubmit={() => void onSubmit()}
          errorFields={Object.keys(err)}
          header={
            <>
              <ErrorSummary submit={submit} />
              {restored && <Alert variant="info">We kept what you typed earlier in this tab.</Alert>}
            </>
          }
          extraActions={
            <ButtonLink href="/app/vendors" variant="ghost">
              Cancel
            </ButtonLink>
          }
          steps={[
            {
              id: "business",
              title: "The business",
              intro: "Who residents will be dealing with.",
              fields: ["name", "businessType"],
              validate: () => (f.name.trim() ? null : "Enter the business name. It is the only thing we need right now."),
              content: (
                <>
                  <TextField label="Business name" required value={f.name} onChange={set("name")} error={err["name"]} hint="The name residents will see in the catalog." />
                  <SelectField
                    label="Type"
                    value={f.businessType}
                    onChange={set("businessType")}
                    error={err["businessType"]}
                    tip="Choose Registered business if it has a company or shop registration. Its registration details are added on the next screen."
                  >
                    <option value="individual">Individual</option>
                    <option value="business">Registered business</option>
                  </SelectField>
                </>
              ),
            },
            {
              id: "where",
              title: "Where they work",
              intro: "Their base. The exact places they serve are added on the next screen.",
              fields: ["country", "state", "city"],
              content: (
                <div className="k-grid">
                  <TextField label="Country" value={f.country} onChange={set("country")} error={err["country"]} />
                  <TextField label="State" value={f.state} onChange={set("state")} error={err["state"]} />
                  <TextField label="City" value={f.city} onChange={set("city")} error={err["city"]} />
                </div>
              ),
            },
            {
              id: "contact",
              title: "Who to contact",
              intro: "The person the platform team talks to during vetting.",
              fields: ["contactName", "contactEmail", "contactPhone"],
              validate: () => (f.contactEmail.trim() && !/^\S+@\S+\.\S+$/u.test(f.contactEmail.trim()) ? "The contact email does not look complete. Check it, or leave it empty for now." : null),
              content: (
                <div className="k-grid">
                  <TextField label="Contact person" value={f.contactName} onChange={set("contactName")} error={err["contactName"]} tip="Private: only the vendor's own team and the platform team see contact details. Residents never do." />
                  <TextField label="Contact email" type="email" value={f.contactEmail} onChange={set("contactEmail")} error={err["contactEmail"]} />
                  <TextField label="Contact phone" type="tel" value={f.contactPhone} onChange={set("contactPhone")} error={err["contactPhone"]} />
                </div>
              ),
            },
            {
              id: "review",
              title: "Check and register",
              intro: "Nothing is visible to residents yet. The vendor starts as a draft.",
              content: (
                <>
                  <ReviewList
                    items={[
                      { label: "Business name", value: f.name.trim() },
                      { label: "Type", value: f.businessType === "business" ? "Registered business" : "Individual" },
                      { label: "Based in", value: [f.city, f.state, f.country].map((x) => x.trim()).filter(Boolean).join(", ") },
                      { label: "Contact", value: [f.contactName, f.contactEmail, f.contactPhone].map((x) => x.trim()).filter(Boolean).join(" · ") },
                    ]}
                  />
                  <NextSteps>
                    The vendor is saved as a draft. Next, complete the profile, categories, places served and documents, then submit it for vetting.
                    Residents only see a vendor after vetting and their community&apos;s approval.
                  </NextSteps>
                </>
              ),
            },
          ]}
        />
      </PlatformModeGate>
    </div>
  );
}
