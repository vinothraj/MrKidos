"use client";

import { Alert, Button, Card, NextSteps, Spinner } from "@kidos/ui";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { ErrorSummary, useSubmit } from "@/lib/forms";
import { useSession, type Me } from "@/lib/session";
import { applyAppearance, isPalette, isThemeMode, PALETTES, THEME_MODES, type Palette, type ThemeMode } from "@/lib/theme";

/** What the screen should look like for this person right now: their own choice, else their community's, else Classic. */
export function effectiveAppearance(me: Me): { mode: ThemeMode; palette: Palette } {
  const a = me.appearance;
  const mode = isThemeMode(a?.themeMode) ? a.themeMode : "system";
  const palette = isPalette(a?.palette) ? a.palette : isPalette(a?.communityPalette) ? a.communityPalette : "classic";
  return { mode, palette };
}

/** Keeps <html> in step with the account's saved appearance. */
export function useApplyAppearance(me: Me): void {
  const { mode, palette } = effectiveAppearance(me);
  useEffect(() => {
    applyAppearance(mode, palette);
  }, [mode, palette]);
}

function Chips({ vars }: { vars: string[] }) {
  return (
    <span className="k-swatch-chips" aria-hidden="true">
      {vars.map((v) => (
        <span key={v} style={{ background: `var(${v})` }} />
      ))}
    </span>
  );
}

/** A person's own appearance: light, dark or device, and a palette (or their community's). Previews as they choose. */
export function AppearanceSettings() {
  const { me, refresh } = useSession();
  const submit = useSubmit();
  const saved = me.appearance;
  const [mode, setMode] = useState<ThemeMode>(isThemeMode(saved?.themeMode) ? saved.themeMode : "system");
  const [palette, setPalette] = useState<Palette | "community">(isPalette(saved?.palette) ? saved.palette : "community");
  const [done, setDone] = useState(false);
  const communityPalette = isPalette(saved?.communityPalette) ? saved.communityPalette : "classic";
  const communityName = PALETTES.find((p) => p.id === communityPalette)?.name ?? "Classic";

  // Leaving without saving puts back what is saved.
  const latest = useRef(me);
  useEffect(() => {
    latest.current = me;
  }, [me]);
  useEffect(
    () => () => {
      const e = effectiveAppearance(latest.current);
      applyAppearance(e.mode, e.palette);
    },
    [],
  );

  // Live preview: the page changes as soon as an option is picked; Save makes it stick on every device.
  useEffect(() => {
    applyAppearance(mode, palette === "community" ? communityPalette : palette);
  }, [mode, palette, communityPalette]);

  async function save() {
    setDone(false);
    const ok = await submit.run(() => api("/me/appearance", { method: "PUT", body: { themeMode: mode, palette: palette === "community" ? null : palette } }));
    if (ok !== undefined) {
      await refresh();
      setDone(true);
    }
  }

  return (
    <Card>
      <form
        className="k-stack"
        aria-label="Appearance"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div>
          <h2>Appearance</h2>
          <p className="k-muted">How the app looks for you. Changes preview straight away; save to keep them on every device you sign in on.</p>
        </div>
        <ErrorSummary submit={submit} />
        <fieldset className="k-fieldset">
          <legend className="k-label">Light or dark</legend>
          <div className="k-swatches">
            {THEME_MODES.map((m) => (
              <label key={m.id} className="k-swatch">
                <input type="radio" name="theme-mode" value={m.id} checked={mode === m.id} onChange={() => setMode(m.id)} />
                <span>{m.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="k-fieldset">
          <legend className="k-label">Colours</legend>
          <span className="k-hint">Every palette is checked for readable contrast in light and dark.</span>
          <div className="k-swatches" style={{ marginTop: "var(--k-space-2)" }}>
            <label className="k-swatch">
              <input type="radio" name="palette" value="community" checked={palette === "community"} onChange={() => setPalette("community")} />
              <span>
                My community&apos;s choice <span className="k-muted">({communityName})</span>
              </span>
            </label>
            {PALETTES.map((p) => (
              <label key={p.id} className="k-swatch" title={p.description}>
                <input type="radio" name="palette" value={p.id} checked={palette === p.id} onChange={() => setPalette(p.id)} />
                <span>{p.name}</span>
                <Chips vars={p.chips} />
              </label>
            ))}
          </div>
        </fieldset>
        {done && <Alert variant="success">Saved. This is how the app will look whenever you sign in.</Alert>}
        <div className="k-row">
          <Button type="submit" loading={submit.submitting}>
            Save appearance
          </Button>
        </div>
      </form>
    </Card>
  );
}

interface Branding {
  palette: string;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** A community administrator's palette choice: what members see unless they pick their own. */
export function CommunityBranding({ communityId }: { communityId: string }) {
  const { refresh } = useSession();
  const submit = useSubmit();
  const [branding, setBranding] = useState<Branding | null>(null);
  const [choice, setChoice] = useState<Palette>("classic");
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    void api<Branding>(`/communities/${communityId}/branding`).then((b) => {
      if (!live) return;
      setBranding(b);
      if (isPalette(b.palette)) setChoice(b.palette);
    });
    return () => {
      live = false;
    };
  }, [communityId]);

  async function save() {
    setDone(false);
    const b = await submit.run(() => api<Branding>(`/communities/${communityId}/branding`, { method: "PUT", body: { palette: choice } }));
    if (b) {
      setBranding(b);
      setDone(true);
      await refresh();
    }
  }

  if (!branding) return <Spinner label="Loading the community's colours" />;
  return (
    <Card>
      <form
        className="k-stack"
        aria-label="Community colours"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div>
          <h2>Community colours</h2>
          <p className="k-muted">The palette every member of this community sees, unless they choose their own under Appearance.</p>
        </div>
        <ErrorSummary submit={submit} />
        <fieldset className="k-fieldset">
          <legend className="k-label">Palette</legend>
          <div className="k-swatches">
            {PALETTES.map((p) => (
              <label key={p.id} className="k-swatch">
                <input type="radio" name="community-palette" value={p.id} checked={choice === p.id} onChange={() => setChoice(p.id)} />
                <span>
                  {p.name}
                  <span className="k-hint" style={{ display: "block" }}>
                    {p.description}
                  </span>
                </span>
                <Chips vars={p.chips} />
              </label>
            ))}
          </div>
        </fieldset>
        <p className="k-hint">
          {branding.isDefault
            ? "Not changed yet: members see Classic."
            : `Last changed${branding.updatedBy ? ` by ${branding.updatedBy}` : ""} on ${new Date(branding.updatedAt ?? "").toLocaleDateString()}.`}
        </p>
        {done && <Alert variant="success">Saved. Members see the new colours the next time a page loads. The change is in the audit log.</Alert>}
        <NextSteps>Members who picked their own palette keep it. Everyone else sees this one.</NextSteps>
        <div className="k-row">
          <Button type="submit" loading={submit.submitting}>
            Save community colours
          </Button>
        </div>
      </form>
    </Card>
  );
}
