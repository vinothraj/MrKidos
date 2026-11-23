"use client";

import { Alert, Badge, Button, ButtonLink, Card, CheckboxField, EmptyState, SelectField, Skeleton, TextField } from "@kidos/ui";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Artwork } from "@/components/artwork";
import { api, ApiError, describeError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useLoad } from "@/lib/use-load";
import { Rating } from "./reviews";
import { formatPrice, PRICING_LABEL, type Offering } from "./vendor-work";

interface VendorRating {
  count: number;
  average: number | null;
}
interface CatalogOffering extends Offering {
  vendor: { id: string; name: string };
  rating?: VendorRating;
  saved: boolean;
}

/**
 * Saves or removes one offering. The label says what the button will do (no state carried by colour or icon alone), a
 * live message confirms the result, and the button is never disabled mid-request so keyboard focus stays where it is.
 */
function SaveButton({ id, name, initial }: { id: string; name: string; initial: boolean }) {
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const next = !saved;
    try {
      await api(`/catalog/offerings/${id}/saved`, { method: next ? "PUT" : "DELETE" });
      setSaved(next);
      setMessage(next ? `Saved ${name}.` : `Removed ${name} from your saved activities.`);
    } catch (e) {
      setFailed(true);
      setMessage(describeError(e).summary);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => void toggle()}>
        {saved ? "Remove from saved" : "Save"}
        <span className="k-sr-only"> ({name})</span>
      </Button>
      <span role={failed ? "alert" : "status"} className={failed ? "k-muted" : "k-sr-only"}>
        {message}
      </span>
    </>
  );
}
interface Page {
  data: CatalogOffering[];
  page: { hasMore: boolean; nextCursor: string | null };
}
interface Category {
  id: string;
  parentId: string | null;
  name: string;
  isActive: boolean;
}

function OfferingCard({ o }: { o: CatalogOffering }) {
  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>{o.name}</h3>
      <p>
        <Link href={`/app/catalog/vendors/${o.vendor.id}`}>{o.vendor.name}</Link> <Badge>{o.category}</Badge>
      </p>
      {o.description && <p>{o.description}</p>}
      <ul className="k-muted" style={{ paddingLeft: "var(--k-space-5)" }}>
        <li>{formatPrice(o)}</li>
        {o.rating && (
          <li>
            {o.rating.average === null
              ? "No reviews yet"
              : `Rated ${o.rating.average} out of 5 (${o.rating.count} ${o.rating.count === 1 ? "review" : "reviews"})`}
          </li>
        )}
        {o.durationMinutes && <li>{o.durationMinutes} minutes</li>}
        {(o.ageMin !== null || o.ageMax !== null) && (
          <li>
            Ages {o.ageMin ?? 0}–{o.ageMax ?? "any"}
          </li>
        )}
        {(o.minParticipants !== null || o.maxParticipants !== null) && (
          <li>
            {o.minParticipants ?? 1}–{o.maxParticipants ?? "any number of"} children
          </li>
        )}
      </ul>
      {o.cancellationPolicy && <p className="k-muted">Cancellation: {o.cancellationPolicy}</p>}
      <p style={{ display: "flex", flexWrap: "wrap", gap: "var(--k-space-3)", alignItems: "center" }}>
        <ButtonLink size="sm" variant="secondary" href={`/app/requests/new?offering=${o.id}&name=${encodeURIComponent(o.name)}`}>
          Ask for this<span className="k-sr-only"> ({o.name})</span>
        </ButtonLink>
        <SaveButton id={o.id} name={o.name} initial={o.saved} />
      </p>
    </Card>
  );
}

interface Filters {
  q: string;
  categoryId: string;
  age: string;
  pricingModel: string;
  /** In rupees, as typed; the API takes the smallest unit. */
  maxPrice: string;
  minRating: string;
  savedOnly: boolean;
}
const NO_FILTERS: Filters = { q: "", categoryId: "", age: "", pricingModel: "", maxPrice: "", minRating: "", savedOnly: false };

function queryFor(filters: Filters, after: string | null): Promise<Page> {
  const qs = new URLSearchParams({ limit: "12" });
  if (filters.q) qs.set("q", filters.q);
  if (filters.categoryId) qs.set("categoryId", filters.categoryId);
  if (filters.age) qs.set("age", filters.age);
  if (filters.pricingModel) qs.set("pricingModel", filters.pricingModel);
  if (filters.maxPrice) qs.set("maxPriceMinor", String(Math.round(Number(filters.maxPrice) * 100)));
  if (filters.minRating) qs.set("minRating", filters.minRating);
  if (filters.savedOnly) qs.set("savedOnly", "true");
  if (after) qs.set("cursor", after);
  return api<Page>(`/catalog/offerings?${qs.toString()}`);
}

/** Remounted (keyed) whenever the filters change, so each search starts from a clean loading state. */
function CatalogResults({ filters }: { filters: Filters }) {
  const [rows, setRows] = useState<CatalogOffering[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let active = true;
    queryFor(filters, null).then(
      (r) => {
        if (!active) return;
        setRows(r.data);
        setCursor(r.page.nextCursor);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [filters]);

  async function loadMore() {
    setMore(true);
    try {
      const r = await queryFor(filters, cursor);
      setRows((cur) => [...(cur ?? []), ...r.data]);
      setCursor(r.page.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      setMore(false);
    }
  }

  if (failed) return <Alert variant="danger">We could not load the catalog. Please try again.</Alert>;
  if (rows === null) return <Skeleton height="6rem" />;
  if (rows.length === 0) {
    return (
      <EmptyState title="Nothing to show yet" art={<Artwork slot="explore" />}>
        {filters.savedOnly && !filters.q && !filters.categoryId && !filters.age && !filters.pricingModel && !filters.maxPrice && !filters.minRating
          ? "You have not saved any activities yet. Choose Save on an activity to find it here later."
          : JSON.stringify({ ...filters, savedOnly: false }) !== JSON.stringify(NO_FILTERS)
            ? "Try a different search."
            : "Your community has not approved any vendors with published offerings yet."}
      </EmptyState>
    );
  }
  return (
    <>
      <ul className="k-grid" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {rows.map((o) => (
          <li key={o.id}>
            <OfferingCard o={o} />
          </li>
        ))}
      </ul>
      {cursor && (
        <div>
          <Button variant="secondary" loading={more} onClick={() => void loadMore()}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}

export function Catalog() {
  const { me } = useSession();
  const community = me.platformScope ? undefined : me.tenants.find((t) => t.id === me.activeTenantId && t.type === "community");
  const catLoader = useCallback(() => api<{ data: Category[] }>("/categories"), []);
  const cats = useLoad(catLoader);
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [draft, setDraft] = useState({ categoryId: "", age: "", pricingModel: "", maxPrice: "", minRating: "", savedOnly: false });

  if (!community) {
    return (
      <Alert variant="info" title="Choose a community">
        The catalog shows the vendors your community has approved. Join a community, then select it from the menu at the top.
      </Alert>
    );
  }
  const categories = cats.state.status === "ready" ? cats.state.data.data.filter((c) => c.isActive) : [];

  return (
    <div className="k-stack k-stack-lg">
      <div>
        <h1>Find activities and services</h1>
        <p className="k-muted">Vendors approved for {community.name}.</p>
      </div>
      <form
        className="k-stack"
        role="search"
        aria-label="Search the catalog"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ q: q.trim(), ...draft });
        }}
      >
        <div className="k-grid">
          <TextField label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          <SelectField label="Category" value={draft.categoryId} onChange={(e) => setDraft((d) => ({ ...d, categoryId: e.target.value }))}>
            <option value="">All categories</option>
            {categories
              .filter((c) => c.parentId === null)
              .map((p) => (
                <optgroup key={p.id} label={p.name}>
                  <option value={p.id}>All of {p.name}</option>
                  {categories
                    .filter((c) => c.parentId === p.id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </optgroup>
              ))}
          </SelectField>
          <TextField label="Child's age" type="number" inputMode="numeric" min={0} max={100} value={draft.age} onChange={(e) => setDraft((d) => ({ ...d, age: e.target.value }))} />
          <SelectField label="How it is priced" value={draft.pricingModel} onChange={(e) => setDraft((d) => ({ ...d, pricingModel: e.target.value }))}>
            <option value="">Any</option>
            {Object.entries(PRICING_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </SelectField>
          <TextField label="Highest price (₹)" type="number" inputMode="numeric" min={0} value={draft.maxPrice} onChange={(e) => setDraft((d) => ({ ...d, maxPrice: e.target.value }))} />
          <SelectField label="Rating" value={draft.minRating} onChange={(e) => setDraft((d) => ({ ...d, minRating: e.target.value }))} hint="Only vendors that have reviews are shown when a rating is chosen.">
            <option value="">Any</option>
            <option value="4">4 out of 5 or more</option>
            <option value="3">3 out of 5 or more</option>
          </SelectField>
        </div>
        <CheckboxField label="Only the activities I have saved" checked={draft.savedOnly} onChange={(e) => setDraft((d) => ({ ...d, savedOnly: e.target.checked }))} />
        <div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </div>
      </form>
      <CatalogResults key={JSON.stringify(applied)} filters={applied} />
    </div>
  );
}

interface VendorPage {
  id: string;
  name: string;
  tagline: string | null;
  description: string | null;
  businessType: string | null;
  city: string | null;
  locality: string | null;
  website: string | null;
  yearsExperience: number | null;
  categories: string[];
  offerings: (Offering & { saved: boolean })[];
  rating: { count: number; average: number | null };
  reviews: { rating: number; body: string | null; reply: string | null; at: string }[];
}

export function CatalogVendor({ id }: { id: string }) {
  const loader = useCallback(() => api<VendorPage>(`/catalog/vendors/${id}`), [id]);
  const { state } = useLoad(loader);
  if (state.status === "loading") return <Skeleton height="8rem" />;
  if (state.status === "error") {
    const notFound = state.error instanceof ApiError && state.error.status === 404;
    return (
      <Alert variant="danger" title={notFound ? "Vendor not found" : "We could not load this vendor"}>
        {notFound ? "This vendor may not serve your community, or has not been approved by it." : "Please try again in a moment."}
      </Alert>
    );
  }
  const v = state.data;
  return (
    <div className="k-stack k-stack-lg">
      <div>
        <h1 style={{ marginBottom: 0 }}>{v.name}</h1>
        {v.tagline && <p>{v.tagline}</p>}
        <p className="k-muted">
          {[v.locality, v.city].filter(Boolean).join(", ")}
          {v.yearsExperience !== null ? ` · ${v.yearsExperience} years of experience` : ""}
          {v.businessType ? ` · ${v.businessType === "business" ? "Registered business" : "Individual"}` : ""}
        </p>
        <p>{v.categories.map((c) => <Badge key={c}>{c}</Badge>)}</p>
      </div>
      {v.description && (
        <Card>
          <h2>About</h2>
          <p>{v.description}</p>
          {v.website && (
            <p>
              <a href={v.website} rel="noopener noreferrer" target="_blank">
                Website<span className="k-sr-only"> (opens in a new tab)</span>
              </a>
            </p>
          )}
        </Card>
      )}
      <section aria-labelledby="vendor-offerings">
        <h2 id="vendor-offerings">What {v.name} offers</h2>
        {v.offerings.length === 0 ? (
          <EmptyState title="No offerings published yet" />
        ) : (
          <ul className="k-grid" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {v.offerings.map((o) => (
              <li key={o.id}>
                <OfferingCard o={{ ...o, vendor: { id: v.id, name: v.name } }} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="vendor-reviews">
        <h2 id="vendor-reviews">What families say</h2>
        {v.rating.count === 0 ? (
          <p className="k-muted">No reviews yet.</p>
        ) : (
          <div className="k-stack">
            <p>
              <strong>{v.rating.average} out of 5</strong> from {v.rating.count} {v.rating.count === 1 ? "review" : "reviews"}
            </p>
            <ul className="k-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {v.reviews.map((r, i) => (
                <li key={`${r.at}-${i}`}>
                  <Rating value={r.rating} /> <span className="k-muted">{new Date(r.at).toLocaleDateString()}</span>
                  {r.body && <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{r.body}</p>}
                  {r.reply && <p style={{ margin: 0 }}><strong>Reply from {v.name}:</strong> {r.reply}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <p>
        <Link href="/app/catalog">Back to the catalog</Link>
      </p>
      <p>
        <Link href={`/app/concerns?vendor=${v.id}&name=${encodeURIComponent(v.name)}`}>Report a concern about {v.name}</Link>
      </p>
    </div>
  );
}
