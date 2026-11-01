/**
 * The drop target's border while a file is over it: a faint indigo warp with
 * a coral weft running around it (a static coral rule with reduced motion).
 * Decorative; the drop target keeps its own label.
 */
export function DropThread() {
  return (
    <svg className="reader-drop-thread" aria-hidden="true" focusable="false">
      <rect className="reader-drop-warp" />
      <rect className="reader-drop-weft" pathLength={100} />
    </svg>
  );
}
