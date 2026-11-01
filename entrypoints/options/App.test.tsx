import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import App from "./App";

const KEY = ["sk", "proj", "settingspage0123456789abcdef"].join("-");

function view(configured: boolean, model = "gpt-5-nano") {
  return {
    ok: true,
    settings: {
      activeProvider: "openai",
      providers: {
        openai: configured
          ? { configured: true, maskedKey: "sk-…cdef", model }
          : { configured: false, model },
      },
    },
    keyRejected: false,
  };
}

let sent: Record<string, unknown>[];
let configured: boolean;

beforeEach(() => {
  sent = [];
  configured = false;
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation((async (
    message: Record<string, unknown>,
  ) => {
    sent.push(message);
    if (message.type === "PROVIDER_SETTINGS_GET") return view(configured);
    if (message.type === "PROVIDER_SETTINGS_SAVE") {
      configured = true;
      return view(true, String(message.model));
    }
    if (message.type === "DIAGNOSTICS_GET")
      return { ok: true, report: { readlaceDiagnostics: 1, recentRuns: [] } };
    if (message.type === "UI_LOCALE_GET") return { locale: "en", stored: null };
    return undefined;
  }) as never);
});

test("saves a pasted key with the chosen model and shows only the masked key", async () => {
  const user = userEvent.setup();
  render(<App />);
  expect(
    await screen.findByText("No key saved. Translation runs on-device."),
  ).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Provider" })).toBeDisabled();

  await user.selectOptions(
    screen.getByRole("combobox", { name: "Model" }),
    "gpt-5-mini",
  );
  const input = screen.getByLabelText("API key");
  expect(input).toHaveAttribute("type", "password");
  await user.type(input, KEY);
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText("Saved.")).toBeInTheDocument();
  expect(sent).toContainEqual({
    type: "PROVIDER_SETTINGS_SAVE",
    model: "gpt-5-mini",
    apiKey: KEY,
  });
  expect(screen.getByText("Saved key: sk-…cdef")).toBeInTheDocument();
  // The field is cleared; the full key is no longer on the page.
  expect(input).toHaveValue("");
  expect(document.body.innerHTML).not.toContain(KEY);
});

test("copies a diagnostics report to the clipboard", async () => {
  const user = userEvent.setup();
  const writeText = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValue(undefined);
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Copy diagnostics" }),
  );
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual({
    readlaceDiagnostics: 1,
    recentRuns: [],
  });
  expect(
    screen.getByText("Diagnostics copied. Paste them into your GitHub issue."),
  ).toBeInTheDocument();
});

test("reports a diagnostics failure", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new Error("denied"),
  );
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Copy diagnostics" }),
  );
  expect(
    await screen.findByText("Diagnostics could not be copied."),
  ).toBeInTheDocument();
});
