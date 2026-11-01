/**
 * The laced-R mark (`public/logo/readlace-mark.svg`, ADR 0019): an indigo
 * stem that stays put, like the page layout, and one coral thread that laces
 * through it to draw the bowl and leg of the R, the translation. The thread
 * passes behind the stem at the top and over it at the waist (the short
 * third path redraws that crossing on top).
 *
 * This is the hand-tuned 16-unit drawing (stem and horizontal runs on whole
 * pixels) used up to about 40 px: popup, Reader and selection panel. The
 * 128-unit drawing lives in the brand files.
 * Stroke attributes sit on each path so host or panel CSS that styles `svg`
 * cannot change them. Colors come from the shared tokens (the indigo
 * lightens in dark mode); decorative next to the "Readlace" heading.
 */
const STEM = { stroke: "var(--rl-mark-stem, #2f2ba8)" };
const THREAD = { stroke: "var(--rl-coral, #f0614a)" };

export function Mark({ className = "size-8" }: { className?: string }) {
  const line = {
    fill: "none",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      data-mark=""
      className={`shrink-0 ${className}`}
    >
      <path {...line} style={THREAD} d="M2.5 4H10A3 3 0 0 1 10 10H6L13 14" />
      <path {...line} style={STEM} d="M6 2V14" />
      <path {...line} style={THREAD} d="M8 10H6L8.24 11.28" />
    </svg>
  );
}
