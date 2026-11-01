import { expect, test } from "vitest";
import {
  STATUS_PRIORITY,
  topStatusNotice,
  type StatusSignals,
} from "./status-priority";

const NONE: StatusSignals = {
  onDeviceUnsupported: false,
  sheetsComingSoon: false,
};

test("orders notices on-device > Sheets", () => {
  expect(STATUS_PRIORITY).toEqual([
    "on-device-unsupported",
    "sheets-coming-soon",
  ]);
});

test("shows nothing when no signal is set", () => {
  expect(topStatusNotice(NONE)).toBeUndefined();
});

test("shows the most urgent notice", () => {
  expect(
    topStatusNotice({ onDeviceUnsupported: true, sheetsComingSoon: true }),
  ).toBe("on-device-unsupported");
  expect(topStatusNotice({ ...NONE, sheetsComingSoon: true })).toBe(
    "sheets-coming-soon",
  );
});
