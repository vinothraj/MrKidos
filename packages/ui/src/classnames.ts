export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

/** Class names for anything that should look like a button (e.g. a framework Link). */
export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", block = false): string {
  return cx("k-btn", `k-btn-${variant}`, size === "sm" && "k-btn-sm", block && "k-btn-block");
}
