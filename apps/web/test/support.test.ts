import { describe, expect, it } from "vitest";
import { parseSupport, phoneHref } from "../src/lib/support";

/** The public safety page shows contact details from the build environment; only plain, valid values may become links. */
describe("support contact details", () => {
  it("accepts a plain email address and phone number", () => {
    expect(parseSupport("safety@kidos.example", "+91 98765 43210")).toEqual({ email: "safety@kidos.example", phone: "+91 98765 43210" });
    expect(parseSupport("  help.desk+kids@mail.example.org ", " 080 1234 5678 ")).toEqual({ email: "help.desk+kids@mail.example.org", phone: "080 1234 5678" });
  });

  it("shows nothing when nothing is set", () => {
    expect(parseSupport(undefined, undefined)).toEqual({ email: null, phone: null });
    expect(parseSupport("", "   ")).toEqual({ email: null, phone: null });
  });

  it("refuses values that could become an unsafe or broken link", () => {
    for (const bad of ["javascript:alert(1)", "a@b", "not an email", "x@y.z", "a b@c.example", "<a@b.example>", "a@b.example?subject=x", "a@b.example,c@d.example", "a@b.example\nBcc: x@y.example"]) {
      expect(parseSupport(bad, undefined).email, bad).toBeNull();
    }
    for (const bad of ["javascript:alert(1)", "call me", "12", "+91-98765-43210;rm", "tel:+911234567890", "+91 98765 43210 ext 5"]) {
      expect(parseSupport(undefined, bad).phone, bad).toBeNull();
    }
  });

  it("builds a tel link from digits and a leading plus only", () => {
    expect(phoneHref("+91 (98765) 43210")).toBe("tel:+919876543210");
    expect(phoneHref("080-1234-5678")).toBe("tel:08012345678");
  });
});
