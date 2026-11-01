import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("content CSS isolation", () => {
  test("styles only extension-owned elements", async () => {
    const css = await readFile("assets/content.css", "utf8");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);

    const rules = [...(style.sheet?.cssRules ?? [])];
    expect(rules.some((rule) => rule.type === CSSRule.IMPORT_RULE)).toBe(false);
    for (const rule of rules) {
      if (!(rule instanceof CSSStyleRule)) continue;
      for (const selector of rule.selectorText.split(",")) {
        expect(
          selector.trim() === ":host" ||
            selector.trim().startsWith("tryhand-ellipsis.tryhand-ellipsis"),
        ).toBe(true);
      }
    }
  });
});
