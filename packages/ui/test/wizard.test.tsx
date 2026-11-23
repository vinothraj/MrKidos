// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfoTip, NextSteps, ReviewList, TextField, Wizard } from "../src";

afterEach(cleanup);

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  return result.violations.map((v) => `${v.id}: ${v.help}`);
}

function Demo({ onSubmit, errorFields }: { onSubmit: () => void; errorFields?: string[] }) {
  const [name, setName] = useState("");
  return (
    <Wizard
      label="Demo form"
      submitLabel="Create"
      onSubmit={onSubmit}
      {...(errorFields ? { errorFields } : {})}
      steps={[
        { id: "a", title: "Basics", content: <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />, validate: () => (name ? null : "Enter a name."), fields: ["name"] },
        { id: "b", title: "Details", intro: "Optional details.", content: <TextField label="City" tip="Used to find nearby services." /> , fields: ["city"] },
        { id: "c", title: "Review", content: <ReviewList items={[{ label: "Name", value: name }, { label: "City", value: "" }]} /> },
      ]}
    />
  );
}

describe("Wizard", () => {
  it("shows one step at a time with its position, and blocks Next until the step is valid", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Demo onSubmit={onSubmit} />);
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Enter a name.")).toBeTruthy();
    expect(screen.queryByText("Step 2 of 3")).toBeNull();

    await user.type(screen.getByLabelText("Name"), "Sunrise");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Details" }));

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Sunrise"); // nothing lost going back
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Not given")).toBeTruthy(); // empty answers say so on the review
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("opens the step holding a field the server rejected", () => {
    render(<Demo onSubmit={() => undefined} errorFields={["city"]} />);
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
  });

  it("marks the current step for assistive technology and has no axe violations", async () => {
    const { container } = render(<Demo onSubmit={() => undefined} />);
    expect(container.querySelector('[aria-current="step"]')).toBeTruthy();
    expect(await violations(container)).toEqual([]);
  });
});

describe("InfoTip", () => {
  it("is a named disclosure that opens on click and closes on Escape", async () => {
    const user = userEvent.setup();
    render(<InfoTip label="City">Used to find nearby services.</InfoTip>);
    const btn = screen.getByRole("button", { name: "More about City" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    await user.click(btn);
    expect(screen.getByRole("note").textContent).toBe("Used to find nearby services.");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("marks a field with help but no requirement as optional, in words", () => {
    render(<TextField label="City" tip="Why we ask." />);
    expect(screen.getByLabelText("City (optional)")).toBeTruthy();
    // The help button does not reuse the field's name, so the field stays uniquely findable by its label.
    expect(screen.getByRole("button", { name: "More information" }).getAttribute("aria-describedby")).toBeTruthy();
  });
});

describe("NextSteps", () => {
  it("is a labelled note", () => {
    render(<NextSteps>We email you when it is approved.</NextSteps>);
    expect(screen.getByRole("complementary", { name: "What happens next" })).toBeTruthy();
  });
});

describe("password strength", () => {
  it("rates by length, variety and common words, and always says it in words", async () => {
    const { passwordStrength, PasswordField } = await import("../src");
    expect(passwordStrength("").score).toBe(0);
    expect(passwordStrength("short1!").label).toBe("Too short");
    expect(passwordStrength("password12345").label).toBe("Too easy to guess");
    expect(passwordStrength("abcdefghijkl").score).toBe(1);
    expect(passwordStrength("Abcdefghij12").score).toBe(2);
    expect(passwordStrength("violet piano harbour lantern").score).toBe(3);
    const { container } = render(<PasswordField label="New password" showStrength value="violet piano harbour lantern" onChange={() => undefined} />);
    expect(container.textContent).toContain("Strength: Strong");
    expect(await violations(container)).toEqual([]);
  });
});
