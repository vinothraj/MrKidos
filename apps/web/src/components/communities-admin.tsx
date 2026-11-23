"use client";

import { Alert, Badge, Button, ButtonLink, EmptyState, NextSteps, ReviewList, SelectField, Skeleton, TableWrap, TextField, Wizard } from "@kidos/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { ErrorSummary, useDraft, useSubmit } from "@/lib/forms";
import { useSession } from "@/lib/session";
import { STATUS_LABEL, type Community } from "./community-detail";

/** These screens act for the whole platform, which needs platform mode (and the platform team's permissions). */
function PlatformModeGate({ children }: { children: React.ReactNode }) {
  const { me, platformMode, setPlatformModeOn } = useSession();
  const [busy, setBusy] = useState(false);
  if (me.platformScope && platformMode) return <>{children}</>;
  return (
    <Alert variant="info" title="This area is for the platform team">
      {me.platformStaff ? (
        <>
          <p>Switch to platform mode to manage communities across the whole platform.</p>
          <Button
            size="sm"
            loading={busy}
            onClick={() => {
              setBusy(true);
              void setPlatformModeOn(true).finally(() => setBusy(false));
            }}
          >
            Switch to platform mode
          </Button>
        </>
      ) : (
        <p>Community onboarding is handled by the platform team. If you administer a community, use &ldquo;My community&rdquo; in the menu.</p>
      )}
    </Alert>
  );
}

/* --------------------------------------------------------------------- list */

type Row = Pick<Community, "id" | "name" | "status" | "city" | "locality" | "unitCount"> & { createdAt: string };
interface Page {
  data: Row[];
  page: { hasMore: boolean; nextCursor: string | null };
}

async function fetchPage(status: string, q: string, cursor: string | null): Promise<Page | "error"> {
  const qs = new URLSearchParams({ limit: "25" });
  if (status) qs.set("status", status);
  if (q) qs.set("q", q);
  if (cursor) qs.set("cursor", cursor);
  try {
    return await api<Page>(`/communities?${qs.toString()}`);
  } catch (err) {
    return err instanceof ApiError && err.status === 403 ? "error" : "error";
  }
}

function CommunityTable({ status, q }: { status: string; q: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchPage(status, q, null).then((r) => {
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
  }, [status, q]);

  async function loadMore() {
    setMore(true);
    const r = await fetchPage(status, q, cursor);
    if (r === "error") setFailed(true);
    else {
      setRows((cur) => [...(cur ?? []), ...r.data]);
      setCursor(r.page.nextCursor);
    }
    setMore(false);
  }

  if (failed) return <Alert variant="danger">We could not load the communities. Please try again.</Alert>;
  if (rows === null) return <Skeleton height="4rem" />;
  if (rows.length === 0) return <EmptyState title="No communities found">{status || q ? "Try a different filter." : "Register the first community to get started."}</EmptyState>;
  return (
    <>
      <TableWrap label="Communities">
        <table className="k-table" aria-label="Communities">
          <thead>
            <tr>
              <th scope="col">Community</th>
              <th scope="col">Area</th>
              <th scope="col">Homes</th>
              <th scope="col">Status</th>
              <th scope="col">Registered</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/app/communities/${r.id}`}>{r.name}</Link>
                </td>
                <td>{[r.locality, r.city].filter(Boolean).join(", ") || "—"}</td>
                <td>{r.unitCount ?? "—"}</td>
                <td>
                  <Badge tone={STATUS_LABEL[r.status].tone}>{STATUS_LABEL[r.status].label}</Badge>
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

export function CommunitiesList() {
  const [status, setStatus] = useState("");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  return (
    <div className="k-stack k-stack-lg">
      <div className="k-row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Communities</h1>
          <p className="k-muted">Register residential communities, verify them and bring them live.</p>
        </div>
        <ButtonLink href="/app/communities/new">Register a community</ButtonLink>
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
          <Button type="submit" variant="secondary" style={{ alignSelf: "flex-end" }}>
            Search
          </Button>
        </form>
        <CommunityTable key={`${status}|${q}`} status={status} q={q} />
      </PlatformModeGate>
    </div>
  );
}

/* ------------------------------------------------------------- registration */

export function CommunityNew() {
  const router = useRouter();
  const submit = useSubmit();
  const [f, setF, clearDraft, restored] = useDraft("community-new", { name: "", country: "India", state: "", city: "", locality: "", unitCount: "", address: "", contactName: "", contactEmail: "", contactPhone: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((c) => ({ ...c, [k]: e.target.value }));
  const err = submit.error?.fields ?? {};

  async function onSubmit() {
    const blank = (v: string) => (v.trim() === "" ? undefined : v.trim());
    const body = {
      name: f.name.trim(),
      ...(blank(f.country) ? { country: blank(f.country) } : {}),
      ...(blank(f.state) ? { state: blank(f.state) } : {}),
      ...(blank(f.city) ? { city: blank(f.city) } : {}),
      ...(blank(f.locality) ? { locality: blank(f.locality) } : {}),
      ...(blank(f.unitCount) ? { unitCount: Number(f.unitCount) } : {}),
      ...(blank(f.address) ? { address: blank(f.address) } : {}),
      ...(blank(f.contactName) ? { contactName: blank(f.contactName) } : {}),
      ...(blank(f.contactEmail) ? { contactEmail: blank(f.contactEmail) } : {}),
      ...(blank(f.contactPhone) ? { contactPhone: blank(f.contactPhone) } : {}),
    };
    const created = await submit.run(() => api<{ id: string }>("/communities", { method: "POST", body }));
    if (created) {
      clearDraft();
      router.push(`/app/communities/${created.id}`);
    }
  }

  const units = f.unitCount.trim();
  return (
    <div className="k-stack k-stack-lg">
      <div>
        <h1>Register a community</h1>
        <p className="k-muted">Four short steps. Only the name is required now; everything else can be completed later, before you submit the community for verification.</p>
      </div>
      <PlatformModeGate>
        <Wizard
          label="Register a community"
          submitLabel="Register community"
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
            <ButtonLink href="/app/communities" variant="ghost">
              Cancel
            </ButtonLink>
          }
          steps={[
            {
              id: "basics",
              title: "The community",
              intro: "What the community is called and roughly how big it is.",
              fields: ["name", "unitCount"],
              validate: () => {
                if (!f.name.trim()) return "Enter the community's name. It is the only thing we need right now.";
                if (units && !(Number(units) >= 1)) return "The number of homes must be 1 or more, or leave it empty.";
                return null;
              },
              content: (
                <>
                  <TextField label="Community name" required value={f.name} onChange={set("name")} error={err["name"]} hint="As residents know it, for example Lakeview Residency." />
                  <TextField
                    label="Number of homes (units)"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={f.unitCount}
                    onChange={set("unitCount")}
                    error={err["unitCount"]}
                    tip="Shown in the community directory once the community is active. It helps vendors judge the size of events."
                  />
                </>
              ),
            },
            {
              id: "location",
              title: "Where it is",
              intro: "Vendors are matched to communities in the places they serve.",
              fields: ["country", "state", "city", "locality", "address"],
              content: (
                <>
                  <div className="k-grid">
                    <TextField label="Country" value={f.country} onChange={set("country")} error={err["country"]} />
                    <TextField label="State" value={f.state} onChange={set("state")} error={err["state"]} />
                    <TextField label="City" value={f.city} onChange={set("city")} error={err["city"]} tip="Once the community is active, anyone signed in can see its city and locality in the community directory." />
                    <TextField label="Locality or area" value={f.locality} onChange={set("locality")} error={err["locality"]} />
                  </div>
                  <TextField label="Street address" value={f.address} onChange={set("address")} error={err["address"]} tip="Private: only the community's administrators and the platform team can see the street address." />
                </>
              ),
            },
            {
              id: "contact",
              title: "Who to contact",
              intro: "The person the platform team talks to during verification.",
              fields: ["contactName", "contactEmail", "contactPhone"],
              validate: () => (f.contactEmail.trim() && !/^\S+@\S+\.\S+$/u.test(f.contactEmail.trim()) ? "The contact email does not look complete. Check it, or leave it empty for now." : null),
              content: (
                <div className="k-grid">
                  <TextField label="Contact person" value={f.contactName} onChange={set("contactName")} error={err["contactName"]} tip="Private: never shown to residents or vendors." />
                  <TextField label="Contact email" type="email" value={f.contactEmail} onChange={set("contactEmail")} error={err["contactEmail"]} />
                  <TextField label="Contact phone" type="tel" value={f.contactPhone} onChange={set("contactPhone")} error={err["contactPhone"]} />
                </div>
              ),
            },
            {
              id: "review",
              title: "Check and register",
              intro: "Nothing is public yet. The community starts as a draft.",
              content: (
                <>
                  <ReviewList
                    items={[
                      { label: "Name", value: f.name.trim() },
                      { label: "Homes", value: units },
                      { label: "Place", value: [f.locality, f.city, f.state, f.country].map((x) => x.trim()).filter(Boolean).join(", ") },
                      { label: "Street address", value: f.address.trim() },
                      { label: "Contact", value: [f.contactName, f.contactEmail, f.contactPhone].map((x) => x.trim()).filter(Boolean).join(" · ") },
                    ]}
                  />
                  <NextSteps>
                    The community is saved as a draft. On the next screen, assign at least one administrator and fill in anything missing, then submit it for
                    verification. Residents can only find it once it is verified and active.
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

export { PlatformModeGate };
