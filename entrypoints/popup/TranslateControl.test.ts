import { expect, test } from "vitest";
import { pageStatusFor, translateControlView } from "./TranslateControl";

type ViewInput = Parameters<typeof translateControlView>[0];

const IDLE: ViewInput = {
  readerMode: false,
  readerOpening: false,
  pageState: "original",
  translationActive: false,
  translated: false,
  retarget: false,
  restored: false,
  label: "Translate",
  disabled: false,
  originalLocked: false,
};

test("an untranslated page shows the indigo Translate button", () => {
  expect(translateControlView(IDLE)).toEqual({
    kind: "button",
    tone: "idle",
    label: "Translate",
    disabled: false,
  });
  expect(translateControlView({ ...IDLE, disabled: true })).toMatchObject({
    kind: "button",
    disabled: true,
  });
});

test("a running page translation is busy and can be stopped", () => {
  for (const pageState of ["translating", "preparing"] as const)
    expect(
      translateControlView({
        ...IDLE,
        pageState,
        translationActive: true,
        label: "Translating…",
      }),
    ).toEqual({ kind: "busy", label: "Translating…", canStop: true });
});

test("opening the Reader is busy without Stop; otherwise Reader mode is a button", () => {
  const reader = { ...IDLE, readerMode: true };
  expect(
    translateControlView({ ...reader, readerOpening: true, label: "Opening…" }),
  ).toEqual({ kind: "busy", label: "Opening…", canStop: false });
  // Reader mode ignores page states: it never shows the view switch.
  expect(
    translateControlView({
      ...reader,
      pageState: "translated",
      translated: true,
    }),
  ).toMatchObject({ kind: "button", tone: "idle" });
});

test("an error offers Try again", () => {
  expect(
    translateControlView({ ...IDLE, pageState: "error", label: "Try again" }),
  ).toEqual({
    kind: "button",
    tone: "error",
    label: "Try again",
    disabled: false,
  });
});

test("a translated page shows the view switch with Translation pressed", () => {
  for (const pageState of ["translated", "partial"] as const)
    expect(
      translateControlView({ ...IDLE, pageState, translated: true }),
    ).toEqual({
      kind: "view",
      showing: "translation",
      translationDisabled: false,
      originalDisabled: false,
    });
  // Show original stays locked while a popup operation runs.
  expect(
    translateControlView({
      ...IDLE,
      pageState: "translated",
      translated: true,
      originalLocked: true,
    }),
  ).toMatchObject({ kind: "view", originalDisabled: true });
});

test("after Show original the switch shows Original pressed and Translation follows the Translate rules", () => {
  expect(translateControlView({ ...IDLE, restored: true })).toEqual({
    kind: "view",
    showing: "original",
    translationDisabled: false,
    originalDisabled: true,
  });
  expect(
    translateControlView({ ...IDLE, restored: true, disabled: true }),
  ).toMatchObject({ kind: "view", translationDisabled: true });
});

test("a changed target replaces the view switch with Translate to <language>", () => {
  expect(
    translateControlView({
      ...IDLE,
      pageState: "translated",
      translated: true,
      retarget: true,
      label: "Translate to Vietnamese",
    }),
  ).toEqual({
    kind: "button",
    tone: "idle",
    label: "Translate to Vietnamese",
    disabled: false,
  });
});

type StatusInput = Parameters<typeof pageStatusFor>[0];

const STATUS_IDLE: StatusInput = {
  readerMode: false,
  pageState: "original",
  translated: false,
  restored: false,
  translationActive: false,
};

test("the card status line follows the page state", () => {
  expect(pageStatusFor(STATUS_IDLE)).toBeUndefined();
  expect(
    pageStatusFor({
      ...STATUS_IDLE,
      pageState: "translated",
      translated: true,
    }),
  ).toBe("translated");
  expect(
    pageStatusFor({ ...STATUS_IDLE, pageState: "partial", translated: true }),
  ).toBe("partial");
  expect(pageStatusFor({ ...STATUS_IDLE, restored: true })).toBe("original");
  expect(pageStatusFor({ ...STATUS_IDLE, pageState: "error" })).toBe("error");
});

test("no card status line while busy or in Reader mode", () => {
  expect(
    pageStatusFor({
      ...STATUS_IDLE,
      pageState: "translating",
      translated: true,
      translationActive: true,
    }),
  ).toBeUndefined();
  expect(
    pageStatusFor({
      ...STATUS_IDLE,
      readerMode: true,
      pageState: "error",
    }),
  ).toBeUndefined();
});
