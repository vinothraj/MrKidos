"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { buttonClass, cx, type ButtonSize, type ButtonVariant } from "./classnames";

/* ------------------------------------------------------------------ utility */

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="k-sr-only">{children}</span>;
}

/** First focusable element on the page: lets keyboard users jump past navigation. */
export function SkipLink({ href = "#main", children = "Skip to main content" }: { href?: string; children?: ReactNode }) {
  return (
    <a className="k-skip-link" href={href}>
      {children}
    </a>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status">
      <span className="k-spinner" aria-hidden="true" />
      <VisuallyHidden>{label}</VisuallyHidden>
    </span>
  );
}

export function Skeleton({ height = "1rem", width = "100%" }: { height?: string; width?: string }) {
  return <span className="k-skeleton" aria-hidden="true" style={{ height, width }} />;
}

/* ------------------------------------------------------------------- button */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  /** Shows a spinner and blocks further clicks while an action is in flight. */
  loading?: boolean;
}

export function Button({ variant = "primary", size = "md", block = false, loading = false, disabled, children, className, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx(buttonClass(variant, size, block), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading && <span className="k-spinner" aria-hidden="true" />}
      {children}
      {loading && <VisuallyHidden>Please wait</VisuallyHidden>}
    </button>
  );
}

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
}

export function ButtonLink({ variant = "primary", size = "md", block = false, className, ...rest }: ButtonLinkProps) {
  // eslint-disable-next-line jsx-a11y/anchor-has-content -- the caller supplies the content through `rest.children`
  return <a {...rest} className={cx(buttonClass(variant, size, block), className)} />;
}

/* ------------------------------------------------------------------- fields */

interface FieldChrome {
  label: string;
  hint?: string;
  error?: string | undefined;
  /** Adds "(required)" to the label text, so it is not conveyed by an asterisk alone. */
  required?: boolean;
  /** Optional "?" explanation beside the label: why we ask and who can see the answer. */
  tip?: ReactNode;
}

function FieldLabel({ htmlFor, label, required, tip }: { htmlFor: string; label: string; required?: boolean | undefined; tip?: ReactNode }) {
  const text = (
    <label className="k-label" htmlFor={htmlFor} id={tip ? `${htmlFor}-label` : undefined}>
      {label}
      {required ? <span className="k-muted"> (required)</span> : tip ? <span className="k-muted"> (optional)</span> : null}
    </label>
  );
  if (!tip) return text;
  return (
    <span className="k-label-row">
      {text}
      <InfoTip label={label} describedBy={`${htmlFor}-label`}>
        {tip}
      </InfoTip>
    </span>
  );
}

function describedBy(hintId: string | undefined, errorId: string | undefined): string | undefined {
  const ids = [hintId, errorId].filter(Boolean).join(" ");
  return ids || undefined;
}

export interface TextFieldProps extends FieldChrome, Omit<InputHTMLAttributes<HTMLInputElement>, "required"> {
  ref?: Ref<HTMLInputElement>;
}

export function TextField({ label, hint, error, required, tip, id, className, ref, ...rest }: TextFieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <div className="k-field">
      <FieldLabel htmlFor={inputId} label={label} required={required} tip={tip} />
      {hint && (
        <span id={hintId} className="k-hint">
          {hint}
        </span>
      )}
      <input
        {...rest}
        ref={ref}
        id={inputId}
        required={required}
        className={cx("k-input", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hintId, errorId)}
      />
      {error && (
        <span id={errorId} className="k-error-text">
          {error}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------- password strength */

const WEAK_WORDS = ["password", "123456", "qwerty", "letmein", "welcome", "iloveyou", "admin", "kidos", "abc123"];

export interface Strength {
  /** 0 too short or too common, 1 acceptable, 2 good, 3 strong. */
  score: 0 | 1 | 2 | 3;
  label: string;
  tip: string | null;
}

/**
 * A friendly estimate shown while typing. Advice only: the server's rules (12+ characters, common passwords refused)
 * are the authority, and this never sees or sends the password anywhere.
 */
export function passwordStrength(pw: string): Strength {
  if (pw.length === 0) return { score: 0, label: "Not entered yet", tip: "Use at least 12 characters. A few unrelated words work well." };
  const lower = pw.toLowerCase();
  if (WEAK_WORDS.some((w) => lower.includes(w)) && pw.length < 20) return { score: 0, label: "Too easy to guess", tip: "Avoid common words and number runs." };
  if (pw.length < 12) return { score: 0, label: "Too short", tip: `Add ${12 - pw.length} more character${12 - pw.length === 1 ? "" : "s"}.` };
  const kinds = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u].filter((r) => r.test(pw)).length;
  const words = pw.trim().split(/\s+/u).length;
  if (pw.length >= 20 || (words >= 4 && pw.length >= 16) || (pw.length >= 16 && kinds >= 3)) return { score: 3, label: "Strong", tip: null };
  if (pw.length >= 14 || kinds >= 3) return { score: 2, label: "Good", tip: "Longer is stronger: another word would make it excellent." };
  return { score: 1, label: "Acceptable", tip: "Add another word or mix in numbers and symbols." };
}

/** The meter under a new-password field: bars for sighted people, the same words for everyone. */
export function PasswordStrengthMeter({ password, id }: { password: string; id?: string }) {
  const s = passwordStrength(password);
  return (
    <div className="k-strength" data-score={s.score} id={id}>
      <span className="k-strength-bars" aria-hidden="true">
        {[1, 2, 3].map((n) => (
          <span key={n} data-on={s.score >= n} />
        ))}
      </span>
      <span className="k-hint" aria-live="polite">
        Strength: <strong>{s.label}</strong>
        {s.tip ? `. ${s.tip}` : "."}
      </span>
    </div>
  );
}

/** Password input with an accessible show/hide control. */
export function PasswordField({ label, hint, error, required, tip, id, ref, showStrength = false, ...rest }: Omit<TextFieldProps, "type"> & { /** For a NEW password: a live strength meter under the field. */ showStrength?: boolean }) {
  const auto = useId();
  const inputId = id ?? auto;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const [visible, setVisible] = useState(false);
  return (
    <div className="k-field">
      <FieldLabel htmlFor={inputId} label={label} required={required} tip={tip} />
      {hint && (
        <span id={hintId} className="k-hint">
          {hint}
        </span>
      )}
      <div className="k-input-group">
        <input
          {...rest}
          ref={ref}
          id={inputId}
          required={required}
          type={visible ? "text" : "password"}
          className="k-input"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(hintId, errorId)}
        />
        {/* The visible word ("Show"/"Hide") is contained in the accessible name, as WCAG 2.5.3 requires. */}
        <Button
          variant="secondary"
          aria-pressed={visible}
          aria-label={visible ? "Hide password" : "Show password"}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? "Hide" : "Show"}
        </Button>
      </div>
      {showStrength && <PasswordStrengthMeter password={typeof rest.value === "string" ? rest.value : ""} />}
      {error && (
        <span id={errorId} className="k-error-text">
          {error}
        </span>
      )}
    </div>
  );
}

export interface SelectFieldProps extends FieldChrome, Omit<SelectHTMLAttributes<HTMLSelectElement>, "required"> {
  children: ReactNode;
}

export function SelectField({ label, hint, error, required, tip, id, className, children, ...rest }: SelectFieldProps) {
  const auto = useId();
  const selectId = id ?? auto;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;
  return (
    <div className="k-field">
      <FieldLabel htmlFor={selectId} label={label} required={required} tip={tip} />
      {hint && (
        <span id={hintId} className="k-hint">
          {hint}
        </span>
      )}
      <select
        {...rest}
        id={selectId}
        required={required}
        className={cx("k-input", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hintId, errorId)}
      >
        {children}
      </select>
      {error && (
        <span id={errorId} className="k-error-text">
          {error}
        </span>
      )}
    </div>
  );
}

export interface TextAreaFieldProps extends FieldChrome, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "required"> {}

export function TextAreaField({ label, hint, error, required, tip, id, className, rows = 4, ...rest }: TextAreaFieldProps) {
  const auto = useId();
  const areaId = id ?? auto;
  const hintId = hint ? `${areaId}-hint` : undefined;
  const errorId = error ? `${areaId}-error` : undefined;
  return (
    <div className="k-field">
      <FieldLabel htmlFor={areaId} label={label} required={required} tip={tip} />
      {hint && (
        <span id={hintId} className="k-hint">
          {hint}
        </span>
      )}
      <textarea
        {...rest}
        id={areaId}
        rows={rows}
        required={required}
        className={cx("k-input", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hintId, errorId)}
      />
      {error && (
        <span id={errorId} className="k-error-text">
          {error}
        </span>
      )}
    </div>
  );
}

export interface CheckboxFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  hint?: string;
  error?: string | undefined;
}

/** A single checkbox with its label to the right (the whole label is clickable and meets the 44px target). */
export function CheckboxField({ label, hint, error, id, className, ...rest }: CheckboxFieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <div className="k-field">
      <label className="k-check" htmlFor={inputId}>
        <input
          {...rest}
          id={inputId}
          type="checkbox"
          className={cx("k-check-box", className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(hintId, errorId)}
        />
        <span>{label}</span>
      </label>
      {hint && (
        <span id={hintId} className="k-hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} className="k-error-text">
          {error}
        </span>
      )}
    </div>
  );
}

/** Groups related controls (for example a list of interests) under a visible legend. */
export function FieldGroup({ legend, hint, children }: { legend: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="k-fieldset">
      <legend className="k-label">{legend}</legend>
      {hint && <span className="k-hint">{hint}</span>}
      <div className="k-checks">{children}</div>
    </fieldset>
  );
}

/* ----------------------------------------------------------- feedback blocks */

export type AlertVariant = "info" | "success" | "warning" | "danger";

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  variant?: AlertVariant;
  title?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Danger alerts are announced immediately (role="alert"); the rest politely (role="status").
 * Pass a ref to move focus to an error summary after a failed submit.
 */
export function Alert({ variant = "info", title, children, className, ref, ...rest }: AlertProps) {
  return (
    <div
      role={variant === "danger" ? "alert" : "status"}
      tabIndex={-1}
      {...rest}
      ref={ref}
      className={cx("k-alert", `k-alert-${variant}`, className)}
    >
      {title && <p className="k-alert-title">{title}</p>}
      {children}
    </div>
  );
}

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

/** Status chip. Always carries text, never color alone. */
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={cx("k-badge", tone !== "neutral" && `k-badge-${tone}`)}>{children}</span>;
}

export function Card({ interactive = false, className, ...rest }: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return <div {...rest} className={cx("k-card", interactive && "k-card-interactive", className)} />;
}

export function EmptyState({ title, children, action, art }: { title: string; children?: ReactNode; action?: ReactNode; art?: ReactNode }) {
  return (
    <div className="k-empty">
      {art}
      <h2>{title}</h2>
      {children && <p className="k-muted">{children}</p>}
      {action}
    </div>
  );
}

/** Scrollable table container that keyboard users can scroll, with an accessible name. */
export function TableWrap({ label, children }: { label: string; children: ReactNode }) {
  return (
    // A horizontally scrollable region must be focusable so keyboard users can scroll it.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="k-table-wrap" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------- help and guidance */

/**
 * A small "?" button that reveals a short explanation (why we ask, who can see it). A disclosure, not a hover-only
 * tooltip, so it works with touch, keyboard and screen readers. Escape or clicking elsewhere closes it.
 */
export function InfoTip({ label, children, describedBy }: { label: string; children: ReactNode; /** Beside a form field: the label's id. The button is then named "More information" and described by the label, so the field's own name stays unique. */ describedBy?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span className="k-tip" ref={wrap}>
      <button type="button" className="k-tip-btn" aria-expanded={open} aria-controls={id} aria-label={describedBy ? "More information" : `More about ${label}`} aria-describedby={describedBy} onClick={() => setOpen((o) => !o)}>
        ?
      </button>
      {open && (
        <span id={id} className="k-tip-body" role="note">
          {children}
        </span>
      )}
    </span>
  );
}

/** "What happens next": a calm note that tells people what follows an action, so no step feels like a dead end. */
export function NextSteps({ title = "What happens next", children }: { title?: string; children: ReactNode }) {
  return (
    <aside className="k-next" aria-label={title}>
      <div>
        <p className="k-next-title">{title}</p>
        {children}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------- wizard */

export interface WizardStep {
  id: string;
  title: string;
  /** One sentence under the step title: what this step is for. */
  intro?: string;
  content: ReactNode;
  /** Returns a plain-language message when the step cannot be left yet, or null. */
  validate?: () => string | null;
  /** Field names on this step, so a server error on one of them brings the person back here. */
  fields?: string[];
}

export interface WizardProps {
  /** Accessible name of the form. */
  label: string;
  steps: WizardStep[];
  submitLabel: string;
  submitting?: boolean;
  onSubmit: () => void;
  /** Field names the server rejected: the wizard opens the first step that holds one of them. */
  errorFields?: string[];
  /** Rendered above the steps (for example an error summary). */
  header?: ReactNode;
  /** Rendered beside Back / Next (for example Cancel or Save draft). */
  extraActions?: ReactNode;
  /** Called whenever the current step changes (lets a draft remember where the person was). */
  onStepChange?: (index: number) => void;
  initialStep?: number;
}

/**
 * A long form split into short steps: "Step 2 of 4" with a progress bar, Back / Next, a check before leaving each step,
 * and a final step (usually a review) whose button submits. Focus moves to the step's title on every change so screen
 * reader and keyboard users always know where they are.
 */
export function Wizard({ label, steps, submitLabel, submitting = false, onSubmit, errorFields, header, extraActions, onStepChange, initialStep = 0 }: WizardProps) {
  const [index, setIndex] = useState(Math.min(Math.max(initialStep, 0), steps.length - 1));
  const [problem, setProblem] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const first = useRef(true);
  const step = steps[index] as WizardStep;
  const last = index === steps.length - 1;

  // A new set of server errors opens the first step that holds one of them (adjusting state while rendering, keyed by
  // the field names so the same errors do not move the person again).
  const errorKey = errorFields?.join(",") ?? "";
  const [seenErrorKey, setSeenErrorKey] = useState("");
  if (errorKey !== seenErrorKey) {
    setSeenErrorKey(errorKey);
    const at = steps.findIndex((s) => s.fields?.some((f) => errorFields?.includes(f)));
    if (at >= 0 && at !== index) setIndex(at);
  }

  useEffect(() => {
    if (first.current) first.current = false;
    else heading.current?.focus();
    onStepChange?.(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the step changes
  }, [index]);

  function go(to: number) {
    setProblem(null);
    setIndex(to);
  }

  function next() {
    const message = step.validate?.() ?? null;
    if (message) {
      setProblem(message);
      return;
    }
    if (last) onSubmit();
    else go(index + 1);
  }

  return (
    <form
      className="k-wizard"
      aria-label={label}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        next();
      }}
    >
      {header}
      <ol className="k-wizard-steps" aria-label="Progress">
        {steps.map((s, i) => (
          <li key={s.id} data-state={i < index ? "done" : i === index ? "current" : "todo"} aria-current={i === index ? "step" : undefined}>
            <span className="k-wizard-step-name">{s.title}</span>
            <span className="k-sr-only">{i < index ? " (done)" : i === index ? " (current step)" : " (not started)"}</span>
          </li>
        ))}
      </ol>
      <section className="k-wizard-panel k-stack" key={step.id} aria-labelledby={`${step.id}-title`}>
        <div>
          <p className="k-eyebrow">
            Step {index + 1} of {steps.length}
          </p>
          <h2 id={`${step.id}-title`} ref={heading} tabIndex={-1}>
            {step.title}
          </h2>
          {step.intro && <p className="k-muted">{step.intro}</p>}
        </div>
        {problem && (
          <Alert variant="warning" title="Before you continue">
            {problem}
          </Alert>
        )}
        {step.content}
      </section>
      <div className="k-wizard-actions">
        {index > 0 && (
          <Button variant="secondary" onClick={() => go(index - 1)}>
            Back
          </Button>
        )}
        {extraActions}
        <Button type="submit" className="k-wizard-next" loading={last && submitting}>
          {last ? submitLabel : "Next"}
        </Button>
      </div>
    </form>
  );
}

/** A two-column summary for a wizard's review step. Empty values read "Not given" rather than leaving a blank. */
export function ReviewList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="k-review">
      {items.map((it) => (
        <div key={it.label} style={{ display: "contents" }}>
          <dt>{it.label}</dt>
          <dd>{it.value === "" || it.value === null || it.value === undefined ? <span className="k-muted">Not given</span> : it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------------------------------------------------------------- app shell */

export interface NavItem {
  href: string;
  label: string;
  current?: boolean;
}

export interface AppHeaderProps {
  brand: ReactNode;
  brandHref: string;
  /** Rendered as a link per item. `renderLink` lets a framework supply client-side navigation. */
  nav?: NavItem[];
  navLabel?: string;
  actions?: ReactNode;
  renderLink?: (item: NavItem) => ReactNode;
}

/** Site header with a disclosure menu on small screens and an inline nav from 768px. */
export function AppHeader({ brand, brandHref, nav = [], navLabel = "Main", actions, renderLink }: AppHeaderProps) {
  const [open, setOpen] = useState(false);
  const navId = useId();
  return (
    <header className="k-header">
      <div className="k-container k-header-inner">
        <a className="k-brand" href={brandHref}>
          {brand}
        </a>
        {nav.length > 0 && (
          <Button className="k-menu-toggle" variant="secondary" size="sm" aria-expanded={open} aria-controls={navId} onClick={() => setOpen((o) => !o)}>
            Menu
          </Button>
        )}
        {nav.length > 0 && (
          <nav id={navId} className="k-nav" aria-label={navLabel} data-open={open}>
            <ul>
              {nav.map((item) => (
                <li key={item.href}>
                  {renderLink ? (
                    renderLink(item)
                  ) : (
                    <a href={item.href} aria-current={item.current ? "page" : undefined}>
                      {item.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        )}
        {actions && <div className="k-row k-header-actions">{actions}</div>}
      </div>
    </header>
  );
}
