import type { ReactNode } from "react";
import { Mark } from "@/components/Mark";

/**
 * Brand, plan, settings and account (popup states review, 2026-10-17). The signed-in
 * email lives in the account menu, not here. A fixed 56px row so the loading
 * skeleton and the ready popup share the same height.
 */
export function PopupHeader({
  plan,
  settings,
  account,
}: {
  plan?: ReactNode;
  settings?: ReactNode;
  account?: ReactNode;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2.5 px-4">
      <Mark className="size-8" />
      <h1 className="min-w-0 flex-1 text-[15.5px] leading-5 font-semibold tracking-[-0.01em] text-ink">
        Readlace
      </h1>
      {plan}
      {settings}
      {account}
    </header>
  );
}
