import type { ReactNode } from "react";

import { Mark } from "@/components/Mark";

/**
 * The Reader brand row: the laced-R mark, "Readlace", the Reader surface name
 * and a status pill (`children`, a `.connection` badge).
 */
export function ReaderHeader({
  subtitle,
  children,
}: {
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <header className="reader-header">
      <div className="reader-brand">
        <Mark className="size-8" />
        <div>
          <h1>Readlace</h1>
          <p>{subtitle}</p>
        </div>
      </div>
      {children}
    </header>
  );
}
