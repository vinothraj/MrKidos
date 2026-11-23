import { describe, expect, it } from "vitest";
import { waited } from "../src/lib/waiting";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

describe("how long a report has waited", () => {
  it("says so in words, with the right unit and plural", () => {
    expect(waited(ago(0.2), NOW)).toEqual({ hours: 0, text: "Waiting less than an hour" });
    expect(waited(ago(1), NOW)).toEqual({ hours: 1, text: "Waiting 1 hour" });
    expect(waited(ago(5), NOW)).toEqual({ hours: 5, text: "Waiting 5 hours" });
    expect(waited(ago(47), NOW).text).toBe("Waiting 47 hours");
    expect(waited(ago(48), NOW).text).toBe("Waiting 2 days");
    expect(waited(ago(24 * 9 + 5), NOW).text).toBe("Waiting 9 days");
  });

  it("never shows a negative or broken wait", () => {
    expect(waited(ago(-3), NOW)).toEqual({ hours: 0, text: "Waiting less than an hour" }); // a clock slightly behind
    expect(waited("not a date", NOW)).toEqual({ hours: 0, text: "Waiting less than an hour" });
  });
});
