import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attributeIsInViewport,
  collectAttributes,
  collectPieces,
  createTranslationCollector,
  pieceIsInViewport,
  translationLane,
} from "./pieces";

afterEach(() => vi.restoreAllMocks());

function texts(html: string, hostname = "example.com") {
  document.documentElement.innerHTML = html;
  return collectPieces(document.documentElement, hostname).map((piece) =>
    piece.nodes.map((node) => node.textContent),
  );
}

function rect(top: number, bottom: number, left = 10, right = 110) {
  return {
    top,
    bottom,
    left,
    right,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => undefined,
  } as DOMRect;
}

describe("piece collector", () => {
  it("groups consecutive inline text into one piece", () => {
    expect(texts("<p>Hello <b>world</b></p>")).toEqual([["Hello ", "world"]]);
  });

  it("starts a new piece at a block boundary", () => {
    expect(texts("<div>One</div><div>Two</div>")).toEqual([["One"], ["Two"]]);
  });

  it("keeps a Feature badge out of the title piece", () => {
    expect(
      texts(
        '<p><span style="display:inline-flex">Feature</span>Beatus talio subiungo.</p>',
      ),
    ).toEqual([["Feature"], ["Beatus talio subiungo."]]);
  });

  it("still groups a phrasing span with its sentence", () => {
    expect(texts("<p><span>Hello</span> world</p>")).toEqual([
      ["Hello", " world"],
    ]);
  });

  it("bypasses notranslate while protecting code and script", () => {
    expect(
      texts(
        "<p>Keep</p><p class='notranslate'>Skip</p><code>x = 1</code><script>var a = 1</script>",
      ),
    ).toEqual([["Keep"], ["Skip"]]);
  });

  it("skips CodeMirror and material icon fonts", () => {
    expect(
      texts(
        "<p>Keep</p><div class='CodeMirror'>editor</div><span class='material-icons'>home</span>",
      ),
    ).toEqual([["Keep"]]);
  });

  it("skips twitter article links only on twitter.com", () => {
    const markup = "<article><p>Hello <a href='/x'>link</a></p></article>";
    expect(texts(markup, "example.com")).toEqual([["Hello ", "link"]]);
    expect(texts(markup, "twitter.com")).toEqual([["Hello "]]);
  });

  it("does not treat aria-hidden as a skip rule", () => {
    expect(texts("<p aria-hidden='true'>Hidden</p>")).toEqual([["Hidden"]]);
  });

  it("bypasses a page-wide opt-out on the html root", () => {
    document.documentElement.setAttribute("translate", "no");
    try {
      expect(texts("<p>Keep</p><p translate='no'>Skip</p>")).toEqual([
        ["Keep"],
        ["Skip"],
      ]);
    } finally {
      document.documentElement.removeAttribute("translate");
    }
  });

  it("bypasses a notranslate body and inner opt-outs", () => {
    document.documentElement.innerHTML =
      "<body class='notranslate'><p>Keep</p><p class='notranslate'>Skip</p></body>";
    const pieces = collectPieces(document.documentElement, "example.com").map(
      (piece) => piece.nodes.map((node) => node.textContent),
    );
    expect(pieces).toEqual([["Keep"], ["Skip"]]);
  });

  it("keeps editable, editor, style, and math content protected despite opt-outs", () => {
    expect(
      texts(`<p translate="no">Readable</p>
          <div contenteditable="true" class="notranslate"><p>Editable</p></div>
          <div contenteditable="plaintext-only">Plain editor</div>
          <div class="CodeMirror notranslate">Editor</div>
          <textarea translate="no">Typed value</textarea>
          <style>.example { color: red }</style><math translate="no">Equation</math>`),
    ).toEqual([["Readable"]]);
  });

  it.each(['contenteditable="true"', 'class="CodeMirror"'])(
    "preserves protected ancestors when collecting an added subtree inside %s",
    (protection) => {
      document.body.innerHTML = `<div ${protection}><p title="Editor hint">Added text</p></div>`;
      const addedRoot = document.querySelector("p")!;
      expect(
        createTranslationCollector(addedRoot, "example.com").drain(Infinity),
      ).toEqual({
        pieces: [],
        attributes: [],
        done: true,
      });
    },
  );

  it("excludes extension-owned wrapper and marker text, tooltip attributes, and mutation subtrees", () => {
    document.body.innerHTML = `<p title="Source hint">Source text</p>
      <tryhand-ellipsis class="tryhand-ellipsis" title="Accepted translation"><span>Accepted translation</span></tryhand-ellipsis>
      <tryhand-baseline-marker class="tryhand-baseline-marker" title="Internal marker">Internal marker</tryhand-baseline-marker>`;
    const collected = createTranslationCollector(
      document.body,
      "example.com",
    ).drain(Infinity);
    expect(
      collected.pieces.flatMap((piece) => piece.nodes.map((node) => node.data)),
    ).toEqual(["Source text"]);
    expect(collected.attributes.map((item) => item.original)).toEqual([
      "Source hint",
    ]);
    expect(
      createTranslationCollector(
        document.querySelector("tryhand-ellipsis span")!,
        "example.com",
      ).drain(Infinity),
    ).toEqual({ pieces: [], attributes: [], done: true });
  });

  it("resumes without changing groups, owners, shadow text, or attributes", () => {
    document.documentElement.innerHTML = `
      <body>
        <h1>Title <span>now</span></h1>
        <select id="owner"><option>One</option><option>Two</option></select>
        <table><thead><tr><th>Month</th></tr></thead><tbody><tr><td>August</td></tr></tbody></table>
        <p>Keep <span>inline</span><code>skip</code></p>
        <input placeholder="Search" title="Hint" />
        <div id="shadow-host"></div>
      </body>
    `;
    const shadow = document
      .getElementById("shadow-host")!
      .attachShadow({ mode: "open" });
    shadow.innerHTML = "<p>Shadow <b>text</b></p><input placeholder='Private'>";

    const expectedPieces = collectPieces(
      document.documentElement,
      "example.com",
    );
    const expectedAttributes = collectAttributes(document.documentElement);
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 5));
    const collector = createTranslationCollector(
      document.documentElement,
      "example.com",
    );
    const pieces = [] as typeof expectedPieces;
    const attributes = [] as typeof expectedAttributes;
    let drains = 0;
    let result: ReturnType<typeof collector.drain>;
    do {
      result = collector.drain(8);
      pieces.push(...result.pieces);
      attributes.push(...result.attributes);
      drains += 1;
    } while (!result.done && drains < 500);

    expect(result!.done).toBe(true);
    expect(drains).toBeGreaterThan(1);
    expect(
      pieces.map((piece) => ({
        nodes: piece.nodes,
        parentElement: piece.parentElement,
        topElement: piece.topElement,
        bottomElement: piece.bottomElement,
      })),
    ).toEqual(
      expectedPieces.map((piece) => ({
        nodes: piece.nodes,
        parentElement: piece.parentElement,
        topElement: piece.topElement,
        bottomElement: piece.bottomElement,
      })),
    );
    expect(new Set(pieces.flatMap((piece) => piece.nodes)).size).toBe(
      pieces.flatMap((piece) => piece.nodes).length,
    );
    expect(
      attributes.map(({ node, attribute, original }) => ({
        node,
        attribute,
        original,
      })),
    ).toEqual(
      expectedAttributes.map(({ node, attribute, original }) => ({
        node,
        attribute,
        original,
      })),
    );
    expect(
      pieces.find((piece) => piece.nodes[0]?.textContent === "One")
        ?.parentElement,
    ).toBe(document.getElementById("owner"));
    expect(
      pieces.some((piece) =>
        piece.nodes.some((node) => node.textContent === "Shadow "),
      ),
    ).toBe(true);
    expect(attributes.some(({ original }) => original === "Private")).toBe(
      false,
    );
  });
});

describe("translation lanes", () => {
  it("prioritizes semantic UI and headers while keeping row data bulk", () => {
    document.documentElement.innerHTML = `
      <body>
        <h2>Heading</h2>
        <nav><ul><li>Navigation item</li></ul></nav>
        <table>
          <thead><tr><th>Table header</th></tr></thead>
          <tbody><tr><td>Table value</td><td><button>Action</button></td></tr></tbody>
        </table>
        <div role="grid">
          <div role="row">
            <div role="gridcell">Grid value</div>
            <div role="columnheader">Grid header</div>
          </div>
        </div>
        <ul><li>List value</li></ul>
        <p>Article copy</p>
        <input placeholder="Search" />
      </body>
    `;
    const pieces = collectPieces(document.documentElement, "example.com");
    const byText = new Map(
      pieces.map((piece) => [
        piece.nodes
          .map((node) => node.textContent)
          .join("")
          .trim(),
        translationLane(piece),
      ]),
    );

    expect(byText.get("Heading")).toBe("priority");
    expect(byText.get("Navigation item")).toBe("priority");
    expect(byText.get("Table header")).toBe("priority");
    expect(byText.get("Action")).toBe("priority");
    expect(byText.get("Grid header")).toBe("priority");
    expect(byText.get("Article copy")).toBe("priority");
    expect(byText.get("Table value")).toBe("bulk");
    expect(byText.get("Grid value")).toBe("bulk");
    expect(byText.get("List value")).toBe("bulk");
    expect(translationLane(collectAttributes(document.body)[0]!)).toBe(
      "priority",
    );
  });
});

describe("viewport membership", () => {
  it("uses the collected visible select owner for native no-box options without changing values", () => {
    document.body.innerHTML =
      '<select><option value="source-value">Readable label</option></select>';
    const select = document.querySelector("select")!;
    const option = document.querySelector("option")!;
    select.getBoundingClientRect = () => rect(10, 40);
    option.getBoundingClientRect = () => rect(0, 0, 0, 0);
    const [piece] = collectPieces(document.body, "example.com");
    expect(piece!.parentElement).toBe(select);
    expect(pieceIsInViewport(piece!, 800, 800)).toBe(true);
    piece!.nodes[0]!.data = "Translated label";
    expect(option.value).toBe("source-value");
    expect(select.value).toBe("source-value");
    option.style.visibility = "hidden";
    expect(pieceIsInViewport(piece!, 800, 800)).toBe(false);
    option.style.visibility = "visible";
    option.style.display = "none";
    expect(pieceIsInViewport(piece!, 800, 800)).toBe(false);
    option.style.display = "block";
    select.style.visibility = "hidden";
    expect(pieceIsInViewport(piece!, 800, 800)).toBe(false);
  });

  it.each(["contents", "shadow"])(
    "uses actual glyph bounds for readable no-box %s text",
    (kind) => {
      document.body.innerHTML = '<div id="owner"></div>';
      const owner = document.querySelector("div")!;
      if (kind === "contents") owner.style.display = "contents";
      const root =
        kind === "shadow" ? owner.attachShadow({ mode: "open" }) : owner;
      const node = document.createTextNode("Readable glyphs");
      root.appendChild(node);
      owner.getBoundingClientRect = () => rect(0, 0, 0, 0);
      const rangeRect = vi.fn(() => rect(20, 40));
      vi.spyOn(document, "createRange").mockReturnValue({
        selectNodeContents: vi.fn(),
        getBoundingClientRect: rangeRect,
      } as unknown as Range);
      const [piece] = collectPieces(owner, "example.com");
      expect(pieceIsInViewport(piece!, 800, 800)).toBe(true);
      owner.style.visibility = "hidden";
      expect(pieceIsInViewport(piece!, 800, 800)).toBe(false);
      owner.style.visibility = "visible";
      owner.style.contentVisibility = "hidden";
      expect(pieceIsInViewport(piece!, 800, 800)).toBe(false);
      owner.style.contentVisibility = "visible";
      rangeRect.mockReturnValue(rect(2000, 2020));
      expect(pieceIsInViewport(piece!, 800, 800)).toBe(false);
    },
  );

  it("waits for hidden content to become rendered and rejects zero-sized elements", () => {
    document.body.innerHTML =
      '<div style="visibility:hidden"><p title="Hint">Hidden source</p></div>';
    const element = document.querySelector("p")!;
    element.getBoundingClientRect = () => rect(10, 40);
    document.body.getBoundingClientRect = () => rect(0, 100);
    const [piece] = collectPieces(document.body, "example.com");
    // A visible grouping boundary cannot make hidden Text eligible.
    piece!.topElement = document.body;
    piece!.bottomElement = document.body;
    expect(pieceIsInViewport(piece!, 800, 800)).toBe(false);
    expect(attributeIsInViewport(element, 800, 800)).toBe(false);
    (element.parentElement as HTMLElement).style.visibility = "visible";
    expect(pieceIsInViewport(piece!, 800, 800)).toBe(true);
    expect(attributeIsInViewport(element, 800, 800)).toBe(true);
    element.getBoundingClientRect = () => rect(10, 10);
    expect(pieceIsInViewport(piece!, 800, 800)).toBe(false);
    expect(attributeIsInViewport(element, 800, 800)).toBe(false);
  });

  it("uses one viewport of prefetch on both axes for pieces and attributes", () => {
    document.documentElement.innerHTML =
      "<p id='above'>Above</p><p id='visible'>Hello</p><p id='below'>World</p><p id='far'>Far</p><p id='side'>Side</p><p id='side-far'>Side far</p><p id='left'>Left</p><p id='left-far'>Left far</p>";
    const above = document.getElementById("above")!;
    const visible = document.getElementById("visible")!;
    const below = document.getElementById("below")!;
    const far = document.getElementById("far")!;
    const side = document.getElementById("side")!;
    const sideFar = document.getElementById("side-far")!;
    const left = document.getElementById("left")!;
    const leftFar = document.getElementById("left-far")!;
    above.getBoundingClientRect = () => rect(-800, -799);
    visible.getBoundingClientRect = () => rect(10, 40);
    below.getBoundingClientRect = () => rect(1599, 1600);
    far.getBoundingClientRect = () => rect(1600, 1640);
    side.getBoundingClientRect = () => rect(10, 40, 1599, 1600);
    sideFar.getBoundingClientRect = () => rect(10, 40, 1600, 1700);
    left.getBoundingClientRect = () => rect(10, 40, -900, -799);
    leftFar.getBoundingClientRect = () => rect(10, 40, -1000, -800);
    const pieces = collectPieces(document.documentElement, "example.com");
    expect(pieceIsInViewport(pieces[0]!, 800, 800, 800, 800)).toBe(true);
    expect(pieceIsInViewport(pieces[1]!, 800, 800, 800, 800)).toBe(true);
    expect(pieceIsInViewport(pieces[2]!, 800, 800, 800, 800)).toBe(true);
    expect(pieceIsInViewport(pieces[3]!, 800, 800, 800, 800)).toBe(false);
    expect(pieceIsInViewport(pieces[4]!, 800, 800, 800, 800)).toBe(true);
    expect(pieceIsInViewport(pieces[5]!, 800, 800, 800, 800)).toBe(false);
    expect(pieceIsInViewport(pieces[6]!, 800, 800, 800, 800)).toBe(true);
    expect(pieceIsInViewport(pieces[7]!, 800, 800, 800, 800)).toBe(false);
    expect(attributeIsInViewport(above, 800, 800, 800, 800)).toBe(true);
    expect(attributeIsInViewport(below, 800, 800, 800, 800)).toBe(true);
    expect(attributeIsInViewport(far, 800, 800, 800, 800)).toBe(false);
    expect(attributeIsInViewport(side, 800, 800, 800, 800)).toBe(true);
    expect(attributeIsInViewport(sideFar, 800, 800, 800, 800)).toBe(false);
    expect(attributeIsInViewport(left, 800, 800, 800, 800)).toBe(true);
    expect(attributeIsInViewport(leftFar, 800, 800, 800, 800)).toBe(false);
  });

  it("selects pieces flush with the top of the viewport", () => {
    document.documentElement.innerHTML = "<p id='hero'>Hello</p>";
    const hero = document.getElementById("hero")!;
    hero.getBoundingClientRect = () => rect(0, 1200);
    const [piece] = collectPieces(document.documentElement, "example.com");
    expect(pieceIsInViewport(piece!, 800, 800)).toBe(true);
    expect(attributeIsInViewport(hero, 800, 800)).toBe(true);
  });
});

describe("attribute collector", () => {
  it("bypasses nested opt-outs for visible attributes and preserves editable values", () => {
    document.body.innerHTML = `<section translate="no" class="notranslate">
      <input translate="no" placeholder="Search" value="Typed value">
      <textarea class="notranslate" placeholder="Write">Typed text</textarea>
      <img class="notranslate" alt="Cat"><p translate="no" title="Hint">Text</p>
      <div contenteditable="true"><p title="Editable hint">Editor</p></div>
      <div class="CodeMirror"><input placeholder="Editor hint"></div>
      <code title="Code hint">Code</code><math title="Equation hint">Math</math>
    </section>`;
    expect(
      collectAttributes(document.body).map(({ attribute, original }) => [
        attribute,
        original,
      ]),
    ).toEqual([
      ["placeholder", "Search"],
      ["placeholder", "Write"],
      ["alt", "Cat"],
      ["title", "Hint"],
    ]);
    expect((document.querySelector("input") as HTMLInputElement).value).toBe(
      "Typed value",
    );
    expect(document.querySelector("textarea")!.value).toBe("Typed text");
  });

  it("collects placeholder, alt, title, and button values", () => {
    document.documentElement.innerHTML = `
      <body>
        <img alt="Cat" />
        <input placeholder="Search" />
        <input type="submit" value="Go" />
        <p title="Hint">Text</p>
      </body>
    `;
    const attributes = collectAttributes(document.body);
    expect(attributes.map((item) => [item.attribute, item.original])).toEqual([
      ["placeholder", "Search"],
      ["alt", "Cat"],
      ["value", "Go"],
      ["title", "Hint"],
    ]);
  });

  it("collects an added attribute-bearing root exactly once", () => {
    const cases = [
      ["<input placeholder='Search'>", "placeholder", "Search"],
      ["<img alt='Cat'>", "alt", "Cat"],
      ["<p title='Hint'>Text</p>", "title", "Hint"],
      ["<input type='submit' value='Go'>", "value", "Go"],
    ] as const;

    for (const [markup, attribute, original] of cases) {
      document.body.innerHTML = markup;
      const root = document.body.firstElementChild!;
      expect(
        collectAttributes(root).map(({ attribute, original }) => [
          attribute,
          original,
        ]),
      ).toEqual([[attribute, original]]);
    }
  });
});
