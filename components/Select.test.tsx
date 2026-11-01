import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { Select } from "./Select";

const options = [
  { label: "Google", value: "google" },
  { label: "OpenAI", value: "openai" },
] as const;

test("preserves the default Select appearance and behavior", async () => {
  const user = userEvent.setup();
  const onValueChange = vi.fn();
  render(
    <Select
      label="Provider"
      options={options}
      value="google"
      onValueChange={onValueChange}
    />,
  );

  const trigger = screen.getByRole("combobox", { name: "Provider" });
  expect(trigger).toHaveClass("h-9", "px-3");
  expect(trigger).not.toHaveClass("h-8", "px-2", "text-sm");
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: "OpenAI" }));
  expect(onValueChange).toHaveBeenCalledWith("openai");
});

test("renders compact options inside the supplied ShadowRoot portal", async () => {
  const user = userEvent.setup();
  const host = document.createElement("div");
  const shadowRoot = host.attachShadow({ mode: "open" });
  document.body.append(host);

  render(
    <Select
      label="Provider"
      options={options}
      portalContainer={shadowRoot}
      value="google"
      variant="compact"
      onValueChange={() => undefined}
    />,
  );

  const trigger = screen.getByRole("combobox", { name: "Provider" });
  expect(trigger).toHaveClass("h-8", "px-2", "text-sm");
  await user.click(trigger);

  const option = await within(shadowRoot as unknown as HTMLElement).findByRole(
    "option",
    { name: "OpenAI" },
  );
  const positioner = shadowRoot.querySelector<HTMLElement>(
    '[data-role="select-positioner"]',
  );
  expect(option).toHaveClass("px-2", "py-1.5");
  expect(positioner).toHaveStyle({ pointerEvents: "auto", zIndex: "1" });
  expect(document.body.querySelector('[role="option"]')).toBeNull();
});
