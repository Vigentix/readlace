import type { WorkspaceSheetTextRun } from "./google-workspace-reader";

/** Style of one visible stretch of cell text; color null = the cell color. */
export interface TextSegmentStyle {
  color: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
}

export interface TextSegment {
  text: string;
  style: TextSegmentStyle;
}

function styleOf(run: WorkspaceSheetTextRun): TextSegmentStyle {
  return {
    color: run.color,
    bold: run.bold,
    italic: run.italic,
    underline: run.underline,
    strikethrough: run.strikethrough,
  };
}

function keyOf(style: TextSegmentStyle) {
  return `${style.color ?? ""}|${+style.bold}${+style.italic}${+style.underline}${+style.strikethrough}`;
}

/** The source text exactly as authored, one segment per run. */
export function originalSegments(
  runs: readonly WorkspaceSheetTextRun[],
): TextSegment[] {
  return runs
    .filter((run) => run.text.length > 0)
    .map((run) => ({ text: run.text, style: styleOf(run) }));
}

interface Range {
  start: number;
  end: number;
}

/** Sentence units: split after newlines and sentence-ending punctuation. */
function unitsOf(text: string): Range[] {
  const units: Range[] = [];
  let start = 0;
  for (const match of text.matchAll(/[。！？!?\n]+|\.(?=\s|$)/g)) {
    const end = match.index + match[0].length;
    units.push({ start, end });
    start = end;
  }
  if (start < text.length || units.length === 0)
    units.push({ start, end: text.length });
  return units;
}

/**
 * A translation has no run boundaries, so styles follow the source structure:
 * lines first, then sentences inside a line. Each source unit takes the style
 * covering most of its visible characters; a translated unit takes the style
 * of the source unit at the same position (one to one when the counts agree,
 * otherwise by relative position). Single-sentence text gets its dominant
 * style as a whole.
 */
export function translatedSegments(
  runs: readonly WorkspaceSheetTextRun[],
  translated: string,
): TextSegment[] {
  const source = runs.map((run) => run.text).join("");
  const spans: { range: Range; style: TextSegmentStyle }[] = [];
  let offset = 0;
  for (const run of runs) {
    spans.push({
      range: { start: offset, end: offset + run.text.length },
      style: styleOf(run),
    });
    offset += run.text.length;
  }
  const fallback = spans[0]?.style ?? styleOf(run0());
  const dominant = (range: Range, previous: TextSegmentStyle | null) => {
    const weights = new Map<
      string,
      { style: TextSegmentStyle; weight: number }
    >();
    for (const { range: span, style } of spans) {
      const from = Math.max(range.start, span.start);
      const to = Math.min(range.end, span.end);
      if (to <= from) continue;
      const weight = source.slice(from, to).replace(/\s/g, "").length;
      const entry = weights.get(keyOf(style));
      if (entry) entry.weight += weight;
      else weights.set(keyOf(style), { style, weight });
    }
    let best: { style: TextSegmentStyle; weight: number } | null = null;
    for (const entry of weights.values())
      if (!best || entry.weight > best.weight) best = entry;
    return best && best.weight > 0
      ? best.style
      : (previous ?? best?.style ?? fallback);
  };
  const styleAt = (position: number): TextSegmentStyle =>
    (
      spans.find(
        ({ range }) => position >= range.start && position < range.end,
      ) ?? spans[spans.length - 1]
    )?.style ?? fallback;

  const segments: TextSegment[] = [];
  const push = (text: string, style: TextSegmentStyle) => {
    if (!text) return;
    const previous = segments[segments.length - 1];
    if (previous && keyOf(previous.style) === keyOf(style))
      previous.text += text;
    else segments.push({ text, style });
  };
  // Map one source range onto one translated text, sentence by sentence.
  const mapRange = (
    range: Range,
    text: string,
    previous: TextSegmentStyle | null,
  ): TextSegmentStyle => {
    const sourceUnits = unitsOf(source.slice(range.start, range.end)).map(
      (unit) => ({
        start: range.start + unit.start,
        end: range.start + unit.end,
      }),
    );
    const styles: TextSegmentStyle[] = [];
    for (const unit of sourceUnits)
      styles.push(dominant(unit, styles[styles.length - 1] ?? previous));
    const translatedUnits = unitsOf(text);
    if (sourceUnits.length === 1) {
      push(text, styles[0]!);
      return styles[0]!;
    }
    const length = Math.max(1, text.length);
    translatedUnits.forEach((unit, index) => {
      const style =
        translatedUnits.length === sourceUnits.length
          ? styles[index]!
          : styleAt(
              range.start +
                Math.floor(
                  ((unit.start + unit.end) / 2 / length) *
                    (range.end - range.start),
                ),
            );
      push(text.slice(unit.start, unit.end), style);
    });
    return styles[styles.length - 1]!;
  };

  const sourceLines = source.split("\n");
  const translatedLines = translated.split("\n");
  if (sourceLines.length === translatedLines.length) {
    let cursor = 0;
    let previous: TextSegmentStyle | null = null;
    sourceLines.forEach((line, index) => {
      const range = { start: cursor, end: cursor + line.length };
      cursor += line.length + 1;
      const last = index === sourceLines.length - 1;
      previous = mapRange(
        range,
        last ? translatedLines[index]! : `${translatedLines[index]!}\n`,
        previous,
      );
    });
  } else {
    mapRange({ start: 0, end: source.length }, translated, null);
  }
  return segments;
}

function run0(): WorkspaceSheetTextRun {
  return {
    text: "",
    color: null,
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
  };
}
