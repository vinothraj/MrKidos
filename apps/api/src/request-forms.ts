import { AppError } from "./errors";

/**
 * Request forms are data: each request type stores a small field schema (see migration 0012). The server validates
 * every submission against it, so the browser's form is a convenience, never the authority.
 */
export type FieldType = "text" | "long_text" | "number" | "date" | "select" | "multi_select" | "boolean";

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  hint?: string;
}
export interface FormSchema {
  fields: FormField[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Returns the cleaned answers (only known fields, normalised) or throws a 400 listing every problem by field.
 * Unknown keys are refused rather than silently kept: nothing unreviewed is stored.
 */
export function validateAnswers(schema: FormSchema, raw: unknown): Record<string, unknown> {
  const issues: { field: string; message: string }[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, "validation_failed", "One or more fields are invalid.", [{ field: "answers", message: "Answers must be an object." }]);
  }
  const input = raw as Record<string, unknown>;
  const known = new Set(schema.fields.map((f) => f.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) issues.push({ field: `answers.${key}`, message: "This question is not part of the form." });
  }
  const out: Record<string, unknown> = {};
  for (const f of schema.fields) {
    const field = `answers.${f.key}`;
    const value = input[f.key];
    const empty = value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (f.required) issues.push({ field, message: "This is required." });
      continue;
    }
    switch (f.type) {
      case "text":
      case "long_text": {
        if (typeof value !== "string") {
          issues.push({ field, message: "Enter text." });
          break;
        }
        const text = value.trim();
        const max = f.max ?? (f.type === "text" ? 200 : 1000);
        if (text.length > max) issues.push({ field, message: `Use at most ${max} characters.` });
        else out[f.key] = text;
        break;
      }
      case "number": {
        if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
          issues.push({ field, message: "Enter a whole number." });
          break;
        }
        if (f.min !== undefined && value < f.min) issues.push({ field, message: `Enter ${f.min} or more.` });
        else if (f.max !== undefined && value > f.max) issues.push({ field, message: `Enter ${f.max} or less.` });
        else out[f.key] = value;
        break;
      }
      case "date": {
        if (typeof value !== "string" || !DATE.test(value) || Number.isNaN(Date.parse(value))) issues.push({ field, message: "Enter a date." });
        else out[f.key] = value;
        break;
      }
      case "boolean": {
        if (typeof value !== "boolean") issues.push({ field, message: "Choose yes or no." });
        else out[f.key] = value;
        break;
      }
      case "select": {
        if (typeof value !== "string" || !f.options?.some((o) => o.value === value)) issues.push({ field, message: "Choose one of the options." });
        else out[f.key] = value;
        break;
      }
      case "multi_select": {
        if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && f.options?.some((o) => o.value === v))) issues.push({ field, message: "Choose from the options." });
        else out[f.key] = [...new Set(value as string[])];
        break;
      }
    }
  }
  if (issues.length > 0) throw new AppError(400, "validation_failed", "One or more fields are invalid.", issues);
  return out;
}
