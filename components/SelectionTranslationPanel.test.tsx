import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { UiLocaleScope } from "@/lib/i18n/react";
import {
  SelectionTranslationPanel,
  type SelectionTranslationPanelProps,
} from "./SelectionTranslationPanel";

function props(
  overrides: Partial<SelectionTranslationPanelProps> = {},
): SelectionTranslationPanelProps {
  return {
    busy: false,
    error: false,
    iconUrl: "chrome-extension://readlace/icon/32.png",
    message: "Choose a language, then translate.",
    onClose: vi.fn(),
    onOpen: vi.fn(),
    onTargetChange: vi.fn(),
    onTranslate: vi.fn(),
    portalContainer: document.body,
    result: "",
    target: "en",
    timedOut: false,
    view: "panel",
    ...overrides,
  };
}

test("renders the brand trigger and opens the controlled panel", async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  render(<SelectionTranslationPanel {...props({ onOpen, view: "icon" })} />);

  const trigger = screen.getByRole("button", {
    name: "Translate selected text",
  });

  expect(trigger.querySelector("img")).toHaveAttribute(
    "src",
    "chrome-extension://readlace/icon/32.png",
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(trigger);
  expect(onOpen).toHaveBeenCalledOnce();
});

test("keeps the result mounted through its exit transition", async () => {
  vi.useFakeTimers();
  try {
    const { rerender } = render(
      <SelectionTranslationPanel {...props({ result: "Translated text" })} />,
    );
    const result = screen.getByRole("status", { name: "Translation result" });
    const group = result.closest("[data-has-result]");

    expect(group).toHaveAttribute("data-has-result", "true");
    rerender(<SelectionTranslationPanel {...props({ result: "" })} />);
    expect(group).toHaveAttribute("data-has-result", "false");
    expect(result).toHaveTextContent("Translated text");

    await act(async () => vi.advanceTimersByTime(180));
    expect(result).toBeEmptyDOMElement();

    rerender(
      <SelectionTranslationPanel {...props({ result: "Next result" })} />,
    );
    rerender(
      <SelectionTranslationPanel {...props({ result: "", view: "icon" })} />,
    );
    expect(result).toBeEmptyDOMElement();
  } finally {
    vi.useRealTimers();
  }
});

test("renders shared compact controls, Lucide actions and callbacks", async () => {
  const user = userEvent.setup();
  const shadowHost = document.createElement("div");
  const shadowRoot = shadowHost.attachShadow({ mode: "open" });
  document.body.append(shadowHost);
  const onClose = vi.fn();
  const onTargetChange = vi.fn();
  const onTranslate = vi.fn();
  render(
    <SelectionTranslationPanel
      {...props({
        onClose,
        onTargetChange,
        onTranslate,
        portalContainer: shadowRoot,
      })}
    />,
  );

  const dialog = screen.getByRole("dialog", { name: "Readlace" });
  expect(dialog.querySelector(".lucide-x")).toBeInTheDocument();
  expect(dialog.querySelector(".lucide-languages")).toBeInTheDocument();
  const fields = within(dialog)
    .getByRole("combobox", { name: "Translate to" })
    .closest('[data-role="selection-fields"]');
  expect(fields).toHaveAttribute("data-role", "selection-fields");
  expect(fields).toHaveClass("grid", "grid-cols-1");
  expect(
    within(dialog).queryByRole("combobox", { name: "Provider" }),
  ).toBeNull();

  await user.click(
    within(dialog).getByRole("combobox", { name: "Translate to" }),
  );
  await user.click(
    await within(shadowRoot as unknown as HTMLElement).findByRole("option", {
      name: "Vietnamese",
    }),
  );
  expect(onTargetChange).toHaveBeenCalledWith("vi");

  const translate = within(dialog).getByRole("button", { name: "Translate" });
  expect(translate).toHaveClass("w-full");
  await user.click(translate);
  await user.click(
    within(dialog).getByRole("button", {
      name: "Close selection translator",
    }),
  );
  expect(onTranslate).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

test("keeps loading in the action and renders only errors or results below", () => {
  const hostileResult = '<img src=x onerror="window.hacked=true">\nTranslated';
  const { rerender } = render(
    <SelectionTranslationPanel {...props({ busy: true })} />,
  );

  const dialog = screen.getByRole("dialog", { name: "Readlace" });
  expect(dialog).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("button", { name: "Translating…" })).toBeDisabled();
  expect(dialog.querySelector(".lucide-loader-circle")).toBeInTheDocument();
  expect(
    screen.getByRole("status", { name: "Translation result" }),
  ).toBeEmptyDOMElement();
  expect(screen.getByText("Result", { selector: "p" })).not.toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getAllByRole("combobox")).toSatisfy((controls: HTMLElement[]) =>
    controls.every((control) => control.hasAttribute("disabled")),
  );

  rerender(
    <SelectionTranslationPanel {...props({ busy: true, timedOut: true })} />,
  );
  expect(screen.getByRole("alert")).toHaveAttribute("data-state", "error");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Translation is taking longer than expected.",
  );
  expect(dialog.querySelector(".lucide-circle-alert")).toBeInTheDocument();

  rerender(
    <SelectionTranslationPanel
      {...props({ error: true, message: "Translation failed. Try again." })}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Translation failed. Try again.",
  );

  rerender(
    <SelectionTranslationPanel
      {...props({ message: "Translation complete.", result: hostileResult })}
    />,
  );
  const result = screen.getByRole("status", { name: "Translation result" });
  const resultLabel = screen.getByText("Result", { selector: "p" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(dialog.querySelector(".lucide-circle-check")).not.toBeInTheDocument();
  expect(result).toHaveAttribute("aria-live", "polite");
  expect(result).toHaveAttribute("aria-atomic", "true");
  expect(resultLabel).toBeVisible();
  expect(result).toHaveTextContent('<img src=x onerror="window.hacked=true">');
  expect(result.textContent).toBe(hostileResult);
  expect(result.querySelector("img")).toBeNull();
  expect(result).toHaveClass("overflow-auto", "whitespace-pre-wrap");
  expect(result.closest("[data-has-result]")).toHaveAttribute(
    "data-has-result",
    "true",
  );
});

test("copies the result and confirms until the hold ends or the result changes", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue({
    writeText,
  } as unknown as Clipboard);
  try {
    const { rerender } = render(
      <SelectionTranslationPanel {...props({ result: "Translated text" })} />,
    );
    const copy = screen.getByRole("button", { name: "Copy translation" });
    expect(copy.querySelector(".lucide-copy")).toBeInTheDocument();

    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith("Translated text");
    const copied = await screen.findByRole("button", { name: "Copied" });
    expect(copied).toHaveAttribute("data-state", "copied");
    expect(copied.querySelector(".lucide-check")).toBeInTheDocument();

    // The CSS hold ends with animationend, never a timer.
    // jsdom has no AnimationEvent, so React listens for the prefixed name.
    fireEvent.animationEnd(copied);
    fireEvent(copied, new Event("webkitAnimationEnd", { bubbles: true }));
    expect(
      screen.getByRole("button", { name: "Copy translation" }),
    ).not.toHaveAttribute("data-state");

    await user.click(screen.getByRole("button", { name: "Copy translation" }));
    await screen.findByRole("button", { name: "Copied" });
    rerender(
      <SelectionTranslationPanel {...props({ result: "Next result" })} />,
    );
    expect(
      screen.getByRole("button", { name: "Copy translation" }),
    ).not.toHaveAttribute("data-state");

    writeText.mockRejectedValueOnce(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy translation" }));
    expect(
      await screen.findByRole("button", { name: "Copy failed" }),
    ).toHaveAttribute("data-state", "failed");
  } finally {
    vi.restoreAllMocks();
  }
});

test("renders every label in the UI locale it is given", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <UiLocaleScope locale="vi">
      <SelectionTranslationPanel {...props({ view: "icon" })} />
    </UiLocaleScope>,
  );
  expect(
    screen.getByRole("button", { name: "Dịch đoạn đã chọn" }),
  ).toHaveAttribute("title", "Dịch đoạn đã chọn");

  rerender(
    <UiLocaleScope locale="vi">
      <SelectionTranslationPanel
        {...props({ result: "Xin chào", target: "vi", timedOut: true })}
      />
    </UiLocaleScope>,
  );
  const dialog = screen.getByRole("dialog");
  expect(
    within(dialog).getByRole("button", { name: "Đóng khung dịch đoạn chọn" }),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByRole("combobox", { name: "Dịch sang" }),
  ).toHaveTextContent("Tiếng Việt");
  expect(within(dialog).getByRole("button", { name: "Dịch" })).toBeEnabled();
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Bản dịch đang lâu hơn bình thường.",
  );
  expect(within(dialog).getByText("Kết quả")).toBeInTheDocument();
  expect(
    within(dialog).getByRole("status", { name: "Kết quả dịch" }),
  ).toHaveTextContent("Xin chào");
  expect(
    within(dialog).getByRole("button", { name: "Sao chép bản dịch" }),
  ).toHaveTextContent("Sao chép");
  await user.click(within(dialog).getByRole("combobox", { name: "Dịch sang" }));
  expect(
    await screen.findByRole("option", { name: "Tiếng Nhật" }),
  ).toBeInTheDocument();

  rerender(
    <UiLocaleScope locale="vi">
      <SelectionTranslationPanel {...props({ busy: true })} />
    </UiLocaleScope>,
  );
  expect(screen.getByText("Đang dịch…")).toBeInTheDocument();
});
