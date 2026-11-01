import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import {
  deriveSpreadsheetTranslationCapabilities,
  type SpreadsheetTranslationPhase,
  type SpreadsheetTranslationState,
} from "@/lib/spreadsheet-reader-state";
import { readerMessages } from "@/lib/i18n/catalog/reader";
import { UiLocaleScope } from "@/lib/i18n/react";
import SpreadsheetReaderControls, {
  SpreadsheetReaderSourceState,
  type SpreadsheetReaderControlsProps,
} from "./SpreadsheetReaderControls";

const worksheetTitle =
  "A very long worksheet title that must remain available when truncated";

function state(
  phase: SpreadsheetTranslationPhase,
): SpreadsheetTranslationState {
  return { phase };
}

function props(
  phase: SpreadsheetTranslationPhase = "idle",
  hasTranslations = false,
): SpreadsheetReaderControlsProps {
  const translationState = state(phase);
  return {
    sourceLabel: "Google Drive file",
    sourceTitle: "Research workbook.xlsm",
    sourcePhase: "ready",
    worksheetOptions: [
      { value: "0", label: worksheetTitle },
      { value: "1", label: "Summary" },
    ],
    worksheetValue: "0",
    onWorksheetChange: vi.fn(),
    targetOptions: [{ value: "en", label: "English" }],
    targetValue: "en",
    onTargetChange: vi.fn(),
    translationState,
    translationCapabilities: deriveSpreadsheetTranslationCapabilities(
      translationState,
      {
        sourceReady: true,
        hasVisibleRecords: true,
        hasTranslations,
      },
    ),
    onPrimaryAction: vi.fn(),
    onStop: vi.fn(),
    presentation: "translation",
    onPresentationChange: vi.fn(),
    refreshDisabled: false,
    onRefresh: vi.fn(),
    clearDisabled: false,
    onClear: vi.fn(),
    connection: {
      kind: "google",
      label: "Google Workspace",
      badgeLabel: "Connected",
      disconnecting: false,
      onDisconnect: vi.fn(),
    },
  };
}

test("keeps Worksheet and Translate to inline in stable order with no Provider", () => {
  const { container } = render(<SpreadsheetReaderControls {...props()} />);
  const fields = container.querySelector(".spreadsheet-fields");

  expect(fields).not.toBeNull();
  expect(fields).toHaveClass("reader-fields", "spreadsheet-fields");
  expect(
    within(fields as HTMLElement)
      .getAllByRole("combobox")
      .map((field) => field.getAttribute("aria-label")),
  ).toEqual(["Worksheet", "Translate to"]);
  expect(fields?.children).toHaveLength(2);
  expect(fields?.firstElementChild).toHaveAttribute("title", worksheetTitle);
  expect(screen.getByText("Research workbook.xlsm")).toHaveAttribute(
    "title",
    "Research workbook.xlsm",
  );
});

test.each([
  ["idle", "Translate", false, true],
  ["translating", "Translating…", true, false],
  ["watching", "Translation on", true, false],
  ["paused", "Resume translation", false, true],
  ["partial", "Retry unresolved", false, true],
  ["error", "Retry", false, true],
] as const)(
  "renders stable primary and Stop slots for %s",
  (phase, primaryLabel, primaryDisabled, stopDisabled) => {
    const { container } = render(
      <SpreadsheetReaderControls {...props(phase, true)} />,
    );
    const actions = container.querySelector(".spreadsheet-primary-actions");
    const primary = screen.getByRole("button", { name: primaryLabel });
    const stop = screen.getByRole("button", { name: "Stop" });

    expect(actions?.children).toHaveLength(2);
    expect(primary).toHaveProperty("disabled", primaryDisabled);
    expect(stop).toHaveProperty("disabled", stopDisabled);
    expect(primary).toHaveAttribute(
      "aria-busy",
      phase === "translating" ? "true" : "false",
    );
    expect(container.querySelector(".spinner")).toBe(
      phase === "translating" ? primary.querySelector("svg") : null,
    );
  },
);

test("keeps presentation disabled until translations exist and forwards actions", () => {
  const initial = props("idle", false);
  const { rerender } = render(<SpreadsheetReaderControls {...initial} />);

  expect(screen.getByRole("button", { name: "Translation" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Original" })).toBeDisabled();

  const ready = props("idle", true);
  rerender(<SpreadsheetReaderControls {...ready} />);
  fireEvent.click(screen.getByRole("button", { name: "Original" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear view" }));
  fireEvent.click(screen.getByRole("button", { name: "Translate" }));

  expect(ready.onPresentationChange).toHaveBeenCalledWith("original");
  expect(ready.onRefresh).toHaveBeenCalledOnce();
  expect(ready.onClear).toHaveBeenCalledOnce();
  expect(ready.onPrimaryAction).toHaveBeenCalledOnce();
});

test("locks settings during a request and forwards the persistent Stop action", () => {
  const active = props("translating", true);
  const { rerender } = render(<SpreadsheetReaderControls {...active} />);

  for (const select of screen.getAllByRole("combobox")) {
    expect(select).toBeDisabled();
  }
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(active.onStop).toHaveBeenCalledOnce();

  const watching = props("watching", true);
  rerender(<SpreadsheetReaderControls {...watching} />);
  for (const select of screen.getAllByRole("combobox")) {
    expect(select).toBeEnabled();
  }
});

test("allows connected pre-start settings while showing a disabled Office worksheet placeholder", () => {
  const current = props();
  render(
    <SpreadsheetReaderControls
      {...current}
      sourcePhase="awaiting-start"
      worksheetOptions={[]}
      worksheetValue="30002"
      worksheetPlaceholder="Available after Translate"
      translationCapabilities={deriveSpreadsheetTranslationCapabilities(
        current.translationState,
        {
          sourceReady: false,
          settingsReady: true,
          hasVisibleRecords: false,
          hasTranslations: false,
        },
      )}
    />,
  );

  const worksheet = screen.getByRole("combobox", { name: "Worksheet" });
  expect(worksheet).toBeDisabled();
  expect(worksheet).toHaveTextContent("Available after Translate");
  expect(worksheet.closest(".spreadsheet-field")).toHaveAttribute(
    "title",
    "Available after Translate",
  );
  expect(screen.queryByText("30002")).toBeNull();
  expect(screen.getByRole("combobox", { name: "Translate to" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Translate" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  expect(current.onWorksheetChange).not.toHaveBeenCalled();
});

test("replaces the presentation placeholder with the real catalog and hides unknown ids", async () => {
  const user = userEvent.setup();
  const current = props();
  const { rerender } = render(
    <SpreadsheetReaderControls
      {...current}
      worksheetOptions={[]}
      worksheetValue="30002"
    />,
  );
  expect(screen.getByRole("combobox", { name: "Worksheet" })).toHaveTextContent(
    "Select a worksheet",
  );

  rerender(
    <SpreadsheetReaderControls
      {...current}
      worksheetPlaceholder="Loading names"
    />,
  );
  const worksheet = screen.getByRole("combobox", { name: "Worksheet" });
  expect(worksheet).toBeEnabled();
  expect(worksheet).toHaveTextContent(worksheetTitle);
  await user.click(worksheet);
  expect(screen.queryByRole("option", { name: "Loading names" })).toBeNull();
  await user.click(await screen.findByRole("option", { name: "Summary" }));
  expect(current.onWorksheetChange).toHaveBeenCalledWith("1");

  rerender(<SpreadsheetReaderControls {...current} worksheetValue="30002" />);
  expect(
    screen.getByRole("combobox", { name: "Worksheet" }),
  ).not.toHaveTextContent("30002");
  expect(
    screen
      .getByRole("combobox", { name: "Worksheet" })
      .closest(".spreadsheet-field"),
  ).toHaveAttribute("title", "");
});

test("shows only actionable visible status and hides completion announcement", () => {
  const { container } = render(
    <SpreadsheetReaderControls
      {...props("partial", true)}
      actionableMessage={{ tone: "partial", text: "2 cells need retry." }}
      completionAnnouncement="9 translations completed."
    />,
  );

  expect(screen.getByText("2 cells need retry.")).toBeVisible();
  expect(screen.getByText("9 translations completed.")).toHaveClass(
    "reader-sr-only",
  );
  expect(container.querySelectorAll(".reader-status")).toHaveLength(1);
});

test("keeps Google disconnect separate and disables it only while disconnecting", () => {
  const connected = props();
  const { rerender } = render(<SpreadsheetReaderControls {...connected} />);
  const disconnect = screen.getByRole("button", { name: "Disconnect Google" });

  expect(disconnect).toBeEnabled();
  fireEvent.click(disconnect);
  expect(
    connected.connection.kind === "google"
      ? connected.connection.onDisconnect
      : undefined,
  ).toHaveBeenCalledOnce();

  rerender(
    <SpreadsheetReaderControls
      {...connected}
      sourcePhase="disconnecting"
      connection={{
        kind: "google",
        label: "Google Workspace",
        badgeLabel: "Connected",
        disconnecting: true,
        onDisconnect: vi.fn(),
      }}
    />,
  );
  expect(screen.getByRole("button", { name: "Disconnecting…" })).toBeDisabled();
});

test("uses an explicit local connection capability without a Google action", () => {
  render(
    <SpreadsheetReaderControls
      {...props()}
      connection={{
        kind: "local",
        label: "Local spreadsheet",
        badgeLabel: "File stays local",
      }}
    />,
  );

  expect(screen.getByText("File stays local")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Disconnect Google" }),
  ).toBeNull();
});

test.each([
  "bootstrapping",
  "identifying",
  "discovering",
  "loading-sheet",
] as const)(
  "retains settings and blocks conflicting actions during %s",
  (phase) => {
    const current = props();
    render(<SpreadsheetReaderControls {...current} sourcePhase={phase} />);

    for (const select of screen.getAllByRole("combobox")) {
      expect(select).toBeDisabled();
    }
    expect(
      screen.getByRole("combobox", { name: "Translate to" }),
    ).toHaveTextContent("English");
    const primary = screen.getByRole("button", { name: "Loading…" });
    expect(primary).toBeDisabled();
    expect(primary).toHaveAttribute("aria-busy", "true");
    fireEvent.click(primary);
    expect(current.onPrimaryAction).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Disconnect Google" }),
    ).toBeEnabled();
  },
);

test("keeps Stop a fixed-size decorative icon and accessible label", () => {
  render(<SpreadsheetReaderControls {...props("translating")} />);
  const stop = screen.getByRole("button", { name: "Stop" });
  const icon = stop.querySelector("svg");
  expect(icon).toHaveAttribute("width", "16");
  expect(icon).toHaveAttribute("height", "16");
  expect(icon).toHaveAttribute("aria-hidden", "true");
  expect(stop.querySelector("span")).toHaveTextContent("Stop");
});

test("allows latest worksheet selection while loading only with explicit catalog permission", () => {
  const current = props();
  const { rerender } = render(
    <SpreadsheetReaderControls {...current} sourcePhase="loading-sheet" />,
  );
  expect(screen.getByRole("combobox", { name: "Worksheet" })).toBeDisabled();

  rerender(
    <SpreadsheetReaderControls
      {...current}
      sourcePhase="loading-sheet"
      worksheetDisabled={false}
    />,
  );
  expect(screen.getByRole("combobox", { name: "Worksheet" })).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Translate to" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
});

test("announces truthful source loading while excluding skeleton from accessibility", () => {
  const { container, rerender } = render(
    <SpreadsheetReaderSourceState
      phase="identifying"
      description="Checking the current file type."
    />,
  );
  const source = screen.getByRole("region", { name: "Spreadsheet source" });
  expect(source).toHaveClass("spreadsheet-source-state", "is-loading");
  expect(source).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("status")).toHaveTextContent(
    "Identifying spreadsheet…Checking the current file type.",
  );
  expect(container.querySelector(".spreadsheet-grid-skeleton")).toHaveAttribute(
    "aria-hidden",
    "true",
  );

  rerender(<SpreadsheetReaderSourceState phase="discovering" />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Discovering worksheet…",
  );
  expect(screen.getAllByRole("status")).toHaveLength(1);

  rerender(<SpreadsheetReaderSourceState phase="ready" />);
  expect(container).toBeEmptyDOMElement();
});

test("uses neutral awaiting-start/empty state and replaces failed skeleton with one alert", () => {
  const { container, rerender } = render(
    <SpreadsheetReaderSourceState
      phase="awaiting-start"
      title="Budget.xlsx"
      description="Select Translate to read this file."
    />,
  );
  expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "false");
  expect(screen.getByRole("status")).toHaveTextContent("Budget.xlsx");
  expect(container.querySelector(".spreadsheet-grid-skeleton")).toBeNull();

  rerender(<SpreadsheetReaderSourceState phase="empty" />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "This worksheet has no readable text",
  );

  rerender(
    <SpreadsheetReaderSourceState
      phase="error"
      title="Google access expired"
      description="Reconnect Google to continue."
    />,
  );
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.queryByRole("status")).toBeNull();
  expect(container.querySelector(".spreadsheet-grid-skeleton")).toBeNull();
});

test.each([
  ["idle", "Dịch"],
  ["translating", "Đang dịch…"],
  ["watching", "Đang bật dịch"],
  ["paused", "Dịch tiếp"],
  ["partial", "Dịch lại phần còn thiếu"],
  ["error", "Thử lại"],
] as const)("words the %s primary action in Vietnamese", (phase, label) => {
  render(
    <UiLocaleScope locale="vi">
      <SpreadsheetReaderControls {...props(phase, true)} />
    </UiLocaleScope>,
  );
  expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
});

test("words the shared toolbar and source states in Vietnamese", () => {
  const { rerender } = render(
    <UiLocaleScope locale="vi">
      <SpreadsheetReaderControls
        {...props("idle", true)}
        worksheetOptions={[]}
        worksheetValue=""
      />
    </UiLocaleScope>,
  );

  expect(
    screen.getByRole("region", { name: "Điều khiển trình đọc bảng tính" }),
  ).toBeInTheDocument();
  expect(
    screen
      .getAllByRole("combobox")
      .map((field) => field.getAttribute("aria-label")),
  ).toEqual(["Trang tính", "Dịch sang"]);
  expect(
    screen.getByRole("combobox", { name: "Trang tính" }),
  ).toHaveTextContent("Chọn trang tính");
  expect(screen.getByRole("button", { name: "Dừng" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Bản dịch" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Bản gốc" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Làm mới" })).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Xóa kết quả hiển thị" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Ngắt kết nối Google" }),
  ).toBeEnabled();

  rerender(
    <UiLocaleScope locale="vi">
      <SpreadsheetReaderControls {...props()} sourcePhase="loading-sheet" />
    </UiLocaleScope>,
  );
  expect(screen.getByRole("button", { name: "Đang tải…" })).toBeDisabled();

  rerender(
    <UiLocaleScope locale="vi">
      <SpreadsheetReaderSourceState phase="identifying" />
    </UiLocaleScope>,
  );
  expect(
    screen.getByRole("region", { name: "Nguồn bảng tính" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Đang nhận diện bảng tính…",
  );

  rerender(
    <UiLocaleScope locale="vi">
      <SpreadsheetReaderSourceState phase="error" />
    </UiLocaleScope>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Trình đọc không tải được bảng tính này",
  );
});

test("words Reader counts with plural forms and locale digits", () => {
  const en = readerMessages.translator("en");
  const vi = readerMessages.translator("vi");

  expect(en.t("reader.status.completed", { count: 1 })).toBe(
    "1 translation completed.",
  );
  expect(en.t("reader.status.completed", { count: 1200 })).toBe(
    "1,200 translations completed.",
  );
  expect(vi.t("reader.status.completed", { count: 1200 })).toBe(
    "Đã hoàn tất 1.200 bản dịch.",
  );
  expect(vi.t("reader.partial.mixed", { count: 1, oversized: 2 })).toBe(
    "Có thể dịch lại 1 ô; 2 ô vượt giới hạn dịch 4.000 ký tự.",
  );
  expect(en.t("reader.status.translatingCells", { count: 1 })).toBe(
    "Translating 1 visible cell…",
  );
});
