"use client";

import { Alert } from "@kidos/ui";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { describeError } from "./api";

export interface FormErrors {
  summary: string;
  fields: Record<string, string>;
}

export interface Submit {
  submitting: boolean;
  error: FormErrors | null;
  errorRef: RefObject<HTMLDivElement | null>;
  /** Runs `fn`, tracking progress and capturing errors. Resolves to `fn`'s value, or undefined if it failed. */
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  clear: () => void;
}

/**
 * Shared submit behavior: one in-flight request at a time, errors captured for display, and focus moved to the error
 * summary so screen-reader and keyboard users notice a failure.
 */
export function useSubmit(): Submit {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FormErrors | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined; // ignore double submits
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(describeError(err));
      return undefined;
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }, []);

  const clear = useCallback(() => setError(null), []);
  return { submitting, error, errorRef, run, clear };
}

/** Error summary shown above a form. Receives focus when it appears. */
export function ErrorSummary({ submit }: { submit: Pick<Submit, "error" | "errorRef"> }) {
  const { error, errorRef } = submit;
  if (!error) return null;
  return (
    <Alert variant="danger" ref={errorRef} title="We couldn't complete that">
      {error.summary}
    </Alert>
  );
}

/**
 * Form state that survives a page refresh (a long form should never lose what was typed). Kept in this TAB's session
 * storage only: it is cleared when the tab closes, so answers never linger on a shared computer. Never store passwords
 * or codes with this. Call `clearDraft` after a successful submit.
 */
export function useDraft<T extends object>(key: string, initial: T): [T, (update: (current: T) => T) => void, () => void, boolean] {
  const storageKey = `kidos.draft.${key}`;
  // Read once, on first render. These forms render only in the browser (after the account has loaded).
  const [start] = useState(() => {
    try {
      const raw = typeof window === "undefined" ? null : window.sessionStorage.getItem(storageKey);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (parsed && typeof parsed === "object") return { value: { ...initial, ...(parsed as Partial<T>) }, restored: true };
    } catch {
      // storage unavailable or corrupt: start fresh
    }
    return { value: initial, restored: false };
  });
  const [value, setValue] = useState<T>(start.value);
  const restored = start.restored;
  const update = useCallback(
    (fn: (current: T) => T) => {
      setValue((current) => {
        const next = fn(current);
        try {
          window.sessionStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // ignore: the form still works without a draft
        }
        return next;
      });
    },
    [storageKey],
  );
  const clear = useCallback(() => {
    try {
      window.sessionStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
  }, [storageKey]);
  return [value, update, clear, restored];
}

/** Only same-site paths inside the signed-in app are accepted as post-login destinations (prevents open redirects). */
export function safeNext(value: string | null): string {
  if (value && value.startsWith("/app") && !value.startsWith("//") && !value.includes("\\")) return value;
  return "/app";
}
