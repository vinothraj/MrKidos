// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Alert,
  AppHeader,
  Badge,
  Button,
  ButtonLink,
  Card,
  CheckboxField,
  EmptyState,
  FieldGroup,
  PasswordField,
  SelectField,
  Skeleton,
  SkipLink,
  Spinner,
  TableWrap,
  TextAreaField,
  TextField,
} from "../src";

afterEach(cleanup);

/** Structural accessibility check. Color contrast is verified separately from the tokens (jsdom has no layout). */
async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  return result.violations.map((v) => `${v.id}: ${v.help}`);
}

describe("Button", () => {
  it("defaults to type=button so it never submits a form by accident", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("type", "button");
  });

  it("blocks clicks and announces busy state while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const btn = screen.getByRole("button", { name: /save/i });
    expect(btn).toHaveProperty("disabled", true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(within(btn).getByText("Please wait")).toBeTruthy();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("fires onClick when enabled and applies variant classes", async () => {
    const onClick = vi.fn();
    render(
      <Button variant="danger" size="sm" onClick={onClick}>
        Delete
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn.className).toContain("k-btn-danger");
    expect(btn.className).toContain("k-btn-sm");
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("ButtonLink", () => {
  it("renders a real link styled as a button", () => {
    render(<ButtonLink href="/register">Create account</ButtonLink>);
    const link = screen.getByRole("link", { name: "Create account" });
    expect(link.getAttribute("href")).toBe("/register");
    expect(link.className).toContain("k-btn-primary");
  });
});

describe("TextField", () => {
  it("associates the label, hint and error with the input", () => {
    render(<TextField label="Email" hint="We never share it" error="Enter a valid email" />);
    const input = screen.getByLabelText("Email");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(described).toHaveLength(2);
    const texts = described.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toEqual(["We never share it", "Enter a valid email"]);
  });

  it("omits aria attributes when there is nothing to describe", () => {
    render(<TextField label="Name" />);
    const input = screen.getByLabelText("Name");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBeNull();
  });

  it("states 'required' in words and sets the native attribute", () => {
    render(<TextField label="Email" required />);
    expect(screen.getByLabelText(/Email/)).toHaveProperty("required", true);
    expect(screen.getByText("(required)")).toBeTruthy();
  });

  it("forwards a ref so forms can move focus to the first invalid field", () => {
    const ref = createRef<HTMLInputElement>();
    render(<TextField label="Email" ref={ref} />);
    ref.current?.focus();
    expect(document.activeElement).toBe(screen.getByLabelText("Email"));
  });

  it("gives every instance a unique id", () => {
    render(
      <>
        <TextField label="A" />
        <TextField label="B" />
      </>,
    );
    expect(screen.getByLabelText("A").id).not.toBe(screen.getByLabelText("B").id);
  });
});

describe("PasswordField", () => {
  it("toggles visibility with an accessible, stateful control", async () => {
    render(<PasswordField label="Password" autoComplete="new-password" />);
    const input = screen.getByLabelText("Password") as HTMLInputElement;
    expect(input.type).toBe("password");
    const toggle = screen.getByRole("button", { name: /show password/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(toggle);
    expect(input.type).toBe("text");
    expect(screen.getByRole("button", { name: /hide password/i }).getAttribute("aria-pressed")).toBe("true");
    expect(input.getAttribute("autocomplete")).toBe("new-password");
  });
});

describe("SelectField", () => {
  it("is labelled and reports errors", () => {
    render(
      <SelectField label="Organization" error="Pick one">
        <option value="a">A</option>
      </SelectField>,
    );
    const select = screen.getByLabelText("Organization");
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Pick one")).toBeTruthy();
  });
});

describe("TextAreaField, CheckboxField, FieldGroup", () => {
  it("textarea is labelled, described and reports errors like the other fields", () => {
    render(<TextAreaField label="Notes" hint="Optional" error="Too long" required />);
    const area = screen.getByLabelText(/Notes/);
    expect(area.tagName).toBe("TEXTAREA");
    expect(area.getAttribute("aria-invalid")).toBe("true");
    const described = (area.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["Optional", "Too long"]);
    expect(screen.getByText("(required)")).toBeTruthy();
  });

  it("checkbox: the whole label toggles it, and the hint and error are announced", async () => {
    const onChange = vi.fn();
    render(<CheckboxField label="I agree" hint="You can change this later" error="Please agree" onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: "I agree" });
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect((box.getAttribute("aria-describedby") ?? "").split(" ")).toHaveLength(2);
    await userEvent.click(screen.getByText("I agree")); // clicking the label text, not the box
    expect(onChange).toHaveBeenCalledOnce();
    expect((box as HTMLInputElement).checked).toBe(true);
  });

  it("a field group exposes a named group of checkboxes", () => {
    render(
      <FieldGroup legend="Interests" hint="Pick any">
        <CheckboxField label="Chess" />
        <CheckboxField label="Magic" />
      </FieldGroup>,
    );
    const group = screen.getByRole("group", { name: "Interests" });
    expect(within(group).getAllByRole("checkbox")).toHaveLength(2);
  });

  it("have no structural accessibility violations", async () => {
    const { container } = render(
      <form aria-label="Child">
        <TextAreaField label="About" rows={2} />
        <FieldGroup legend="Interests">
          <CheckboxField label="Chess" />
        </FieldGroup>
        <CheckboxField label="I agree" error="Required" />
      </form>,
    );
    expect(await violations(container)).toEqual([]);
  });
});

describe("Alert, Badge, Spinner, Skeleton, EmptyState, Card", () => {
  it("announces danger alerts assertively and others politely", () => {
    const { rerender } = render(<Alert variant="danger">Failed</Alert>);
    expect(screen.getByRole("alert").textContent).toBe("Failed");
    rerender(<Alert variant="success">Saved</Alert>);
    expect(screen.getByRole("status").textContent).toBe("Saved");
  });

  it("can receive programmatic focus for error summaries", () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <Alert variant="danger" title="Fix these" ref={ref}>
        details
      </Alert>,
    );
    ref.current?.focus();
    expect(document.activeElement).toBe(ref.current);
  });

  it("badges carry text, not color alone", () => {
    render(<Badge tone="success">Verified</Badge>);
    expect(screen.getByText("Verified").className).toContain("k-badge-success");
  });

  it("spinner exposes a status with a label and hides the graphic", () => {
    render(<Spinner label="Loading sessions" />);
    expect(screen.getByRole("status").textContent).toBe("Loading sessions");
  });

  it("skeletons are hidden from assistive technology", () => {
    const { container } = render(<Skeleton />);
    expect(container.querySelector("[aria-hidden='true']")).toBeTruthy();
  });

  it("empty state explains and offers a next action", () => {
    render(<EmptyState title="No requests yet" action={<ButtonLink href="/new">Create one</ButtonLink>}>Start by creating a request.</EmptyState>);
    expect(screen.getByRole("heading", { name: "No requests yet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create one" })).toBeTruthy();
  });

  it("card passes through attributes", () => {
    render(<Card data-testid="c" interactive />);
    expect(screen.getByTestId("c").className).toContain("k-card-interactive");
  });
});

describe("TableWrap", () => {
  it("is a named, keyboard-focusable scroll region", () => {
    render(
      <TableWrap label="Audit log">
        <table>
          <caption>Entries</caption>
          <tbody>
            <tr>
              <td>x</td>
            </tr>
          </tbody>
        </table>
      </TableWrap>,
    );
    const region = screen.getByRole("region", { name: "Audit log" });
    expect(region.getAttribute("tabindex")).toBe("0");
  });
});

describe("AppHeader", () => {
  const nav = [
    { href: "/app", label: "Home", current: true },
    { href: "/app/security", label: "Security" },
  ];

  it("exposes navigation with aria-current and a disclosure menu button", async () => {
    render(<AppHeader brand="Kidos" brandHref="/" nav={nav} actions={<button type="button">Sign out</button>} />);
    const navEl = screen.getByRole("navigation", { name: "Main" });
    expect(within(navEl).getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBe("page");
    expect(within(navEl).getByRole("link", { name: "Security" }).getAttribute("aria-current")).toBeNull();

    const toggle = screen.getByRole("button", { name: "Menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(navEl.id);
    expect(navEl.getAttribute("data-open")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(navEl.getAttribute("data-open")).toBe("true");
  });

  it("renders no menu button or nav when there are no items", () => {
    render(<AppHeader brand="Kidos" brandHref="/" />);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
  });

  it("lets the host supply framework links", () => {
    render(
      <AppHeader
        brand="Kidos"
        brandHref="/"
        nav={nav}
        renderLink={(item) => (
          <a href={item.href} data-custom="1">
            {item.label}
          </a>
        )}
      />,
    );
    expect(screen.getAllByRole("link").filter((a) => a.getAttribute("data-custom") === "1")).toHaveLength(2);
  });

  it("skip link targets the main landmark", () => {
    render(<SkipLink />);
    expect(screen.getByRole("link", { name: "Skip to main content" }).getAttribute("href")).toBe("#main");
  });
});

describe("accessibility (axe, structure)", () => {
  it("a page composed of the components has no violations", async () => {
    const { container } = render(
      <div>
        <SkipLink />
        <AppHeader brand="Kidos" brandHref="/" nav={[{ href: "/app", label: "Home", current: true }]} actions={<Button size="sm">Sign out</Button>} />
        <main id="main">
          <h1>Account</h1>
          <form>
            <TextField label="Email" type="email" autoComplete="email" hint="Used to sign in" required />
            <PasswordField label="Password" autoComplete="current-password" error="Too short" />
            <SelectField label="Organization">
              <option value="a">Aqualily</option>
            </SelectField>
            <Button type="submit" loading>
              Save
            </Button>
          </form>
          <Alert variant="danger" title="Something went wrong">
            Try again.
          </Alert>
          <Badge tone="info">Pilot</Badge>
          <Spinner />
          <EmptyState title="Nothing here" />
          <TableWrap label="Entries">
            <table className="k-table">
              <caption>Entries</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>now</td>
                  <td>login</td>
                </tr>
              </tbody>
            </table>
          </TableWrap>
        </main>
      </div>,
    );
    expect(await violations(container)).toEqual([]);
  });
});
