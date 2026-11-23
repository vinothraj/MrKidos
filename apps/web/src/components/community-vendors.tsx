"use client";

import { Alert, Badge, Button, Card, EmptyState, Skeleton, TextField, type BadgeTone } from "@kidos/ui";
import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import { useSession } from "@/lib/session";
import { useLoad } from "@/lib/use-load";

interface VendorRow {
  vendorId: string;
  name: string;
  tagline: string | null;
  city: string | null;
  locality: string | null;
  categories: string[];
  decision: "undecided" | "approved" | "rejected" | "revoked";
  note: string | null;
  decidedAt: string | null;
}

const DECISION: Record<VendorRow["decision"], { label: string; tone: BadgeTone }> = {
  undecided: { label: "Waiting for your decision", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Not approved", tone: "danger" },
  revoked: { label: "Approval withdrawn", tone: "danger" },
};

function VendorDecision({ communityId, vendor, onChanged }: { communityId: string; vendor: VendorRow; onChanged: () => void }) {
  const submit = useSubmit();
  const [note, setNote] = useState("");
  const d = DECISION[vendor.decision];

  async function decide(status: "approved" | "rejected" | "revoked") {
    const res = await submit.run(() => api(`/communities/${communityId}/vendors/${vendor.vendorId}`, { method: "PUT", body: { status, ...(note.trim() ? { note: note.trim() } : {}) } }));
    if (res) {
      setNote("");
      onChanged();
    }
  }

  return (
    <li className="k-stack k-stack-sm">
      <div className="k-row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>{vendor.name}</strong> <Badge tone={d.tone}>{d.label}</Badge>
          {vendor.tagline && <div>{vendor.tagline}</div>}
          <div className="k-muted">
            {[vendor.locality, vendor.city].filter(Boolean).join(", ") || "Location not given"}
            {vendor.categories.length > 0 ? ` · ${vendor.categories.join(", ")}` : ""}
          </div>
          {vendor.note && <div>Your note: {vendor.note}</div>}
        </div>
      </div>
      <ErrorSummary submit={submit} />
      <TextField label={`Note about ${vendor.name}`} hint="Required when you do not approve, or withdraw an approval." value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="k-row">
        {vendor.decision !== "approved" && (
          <Button size="sm" loading={submit.submitting} onClick={() => void decide("approved")}>
            Approve<span className="k-sr-only"> {vendor.name}</span>
          </Button>
        )}
        {vendor.decision === "undecided" && (
          <Button size="sm" variant="secondary" loading={submit.submitting} onClick={() => void decide("rejected")}>
            Do not approve<span className="k-sr-only"> {vendor.name}</span>
          </Button>
        )}
        {vendor.decision === "approved" && (
          <Button size="sm" variant="secondary" loading={submit.submitting} onClick={() => void decide("revoked")}>
            Withdraw approval<span className="k-sr-only"> for {vendor.name}</span>
          </Button>
        )}
      </div>
    </li>
  );
}

export function CommunityVendors() {
  const { me } = useSession();
  const community = me.platformScope ? undefined : me.tenants.find((t) => t.id === me.activeTenantId && t.type === "community");
  const id = community?.id ?? "";
  const loader = useCallback(() => (id ? api<{ data: VendorRow[] }>(`/communities/${id}/vendors`) : Promise.resolve({ data: [] })), [id]);
  const { state, reload } = useLoad(loader);

  if (!community) {
    return (
      <Alert variant="info" title="Choose a community">
        Select the community you administer from the menu at the top to review the vendors that want to serve it.
      </Alert>
    );
  }
  return (
    <div className="k-stack k-stack-lg">
      <div>
        <h1>Vendors for {community.name}</h1>
        <p className="k-muted">
          Only vendors the platform has verified, and who say they serve your community, appear here. Residents see a vendor&rsquo;s offerings only after you approve it (unless you turned this requirement off in your policies).
        </p>
      </div>
      <Card>
        {state.status === "loading" && <Skeleton height="4rem" />}
        {state.status === "error" && <Alert variant="danger">We could not load the vendors.</Alert>}
        {state.status === "ready" && state.data.data.length === 0 && <EmptyState title="No vendors to review yet">When a verified vendor lists your community as a place it serves, it will appear here.</EmptyState>}
        {state.status === "ready" && state.data.data.length > 0 && (
          <ul className="k-stack k-stack-lg" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {state.data.data.map((v) => (
              <VendorDecision key={v.vendorId} communityId={id} vendor={v} onChanged={reload} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
