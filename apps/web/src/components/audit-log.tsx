"use client";

import { Alert, Button, EmptyState, SelectField, Skeleton, TableWrap } from "@kidos/ui";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";

interface Entry {
  id: string;
  tenantId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
}

interface Page {
  data: Entry[];
  page: { hasMore: boolean; nextCursor: string | null };
}

type Problem = { code: string; message: string } | null;

type Result = { ok: true; page: Page } | { ok: false; problem: NonNullable<Problem> };

interface Filters {
  area: string;
  days: string;
}

const AREAS: { value: string; label: string }[] = [
  { value: "", label: "Everything" },
  { value: "security", label: "Sign-in and security" },
  { value: "community", label: "Community settings" },
  { value: "members", label: "Members and families" },
  { value: "vendors", label: "Vendors and offerings" },
  { value: "requests", label: "Requests, quotes and bookings" },
  { value: "concerns", label: "Concerns" },
];
const SPANS: { value: string; label: string }[] = [
  { value: "", label: "Any time" },
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

async function fetchPage(after: string | null, filters: Filters): Promise<Result> {
  const qs = new URLSearchParams({ limit: "25" });
  if (after) qs.set("cursor", after);
  if (filters.area) qs.set("area", filters.area);
  if (filters.days) qs.set("days", filters.days);
  try {
    return { ok: true, page: await api<Page>(`/admin/audit?${qs.toString()}`) };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, problem: { code: err.code, message: err.message } };
    return { ok: false, problem: { code: "unknown", message: "Something went wrong." } };
  }
}

/** Remounts when the active organization changes, so the list always belongs to the organization shown in the header. */
export function AuditLog() {
  const { me } = useSession();
  const [filters, setFilters] = useState<Filters>({ area: "", days: "" });
  return (
    <div className="k-stack">
      <div>
        <h1>Audit log</h1>
        <p className="k-muted">A record of security-relevant actions in the active organization, newest first. It cannot be edited or deleted.</p>
      </div>
      <form className="k-grid" aria-label="Filter the audit log" onSubmit={(e) => e.preventDefault()}>
        <SelectField label="Area" value={filters.area} onChange={(e) => setFilters((f) => ({ ...f, area: e.target.value }))}>
          {AREAS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </SelectField>
        <SelectField label="When" value={filters.days} onChange={(e) => setFilters((f) => ({ ...f, days: e.target.value }))}>
          {SPANS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </SelectField>
      </form>
      <AuditLogList key={`${me.activeTenantId ?? "none"}:${filters.area}:${filters.days}`} filters={filters} />
    </div>
  );
}

function AuditLogList({ filters }: { filters: Filters }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchPage(null, filters).then((r) => {
      if (!active) return;
      if (r.ok) {
        setEntries(r.page.data);
        setCursor(r.page.page.nextCursor);
      } else {
        setProblem(r.problem);
      }
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the parent remounts this list whenever the filters change
  }, []);

  async function more() {
    setLoadingMore(true);
    const r = await fetchPage(cursor, filters);
    if (r.ok) {
      setEntries((prev) => [...(prev ?? []), ...r.page.data]);
      setCursor(r.page.page.nextCursor);
    } else {
      setProblem(r.problem);
    }
    setLoadingMore(false);
  }

  return (
    <div className="k-stack">
      {problem?.code === "tenant_required" && <Alert variant="info">Choose an organization using the selector at the top of the page.</Alert>}
      {problem?.code === "forbidden" && <Alert variant="danger">You do not have permission to view the audit log here.</Alert>}
      {problem?.code === "email_verification_required" && (
        <Alert variant="warning">
          Confirm your email address first. You can resend the link from your <Link href="/app">home page</Link>.
        </Alert>
      )}
      {problem?.code === "mfa_enrollment_required" && (
        <Alert variant="danger">
          Your role requires two-step verification. Set it up on the <Link href="/app/security">Security page</Link>.
        </Alert>
      )}
      {problem && !["tenant_required", "forbidden", "email_verification_required", "mfa_enrollment_required"].includes(problem.code) && (
        <Alert variant="danger">{problem.message}</Alert>
      )}

      {!problem && entries === null && (
        <div className="k-stack k-stack-sm" aria-busy="true">
          <Skeleton height="2.5rem" />
          <Skeleton height="2.5rem" />
          <Skeleton height="2.5rem" />
        </div>
      )}

      {!problem && entries && entries.length === 0 && <EmptyState title={filters.area || filters.days ? "Nothing matches these filters" : "Nothing recorded yet"}>{filters.area || filters.days ? "Try a wider time span, or Everything." : "Actions will appear here as they happen."}</EmptyState>}

      {!problem && entries && entries.length > 0 && (
        <>
          <TableWrap label="Audit log entries">
            <table className="k-table" aria-label="Audit log entries">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Action</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Actor</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td>{new Date(e.createdAt).toLocaleString()}</td>
                    <td className="k-mono">{e.action}</td>
                    <td>{e.entityType ? `${e.entityType}${e.entityId ? ` ${e.entityId.slice(0, 8)}…` : ""}` : "—"}</td>
                    <td className="k-mono">{e.actorUserId ? `${e.actorUserId.slice(0, 8)}…` : "system"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          {cursor && (
            <div>
              <Button variant="secondary" loading={loadingMore} onClick={() => void more()}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
