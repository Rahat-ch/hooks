/**
 * Every built-in Hook. Keep one import and one entry per line, sorted by
 * Hook name, so parallel additions merge cleanly.
 */
import type { Hook } from "./hook";
import { blockDestructiveShell } from "./block-destructive-shell";
import { check } from "./check";
import { formatOnEdit } from "./format-on-edit";
import { gitGuard } from "./git-guard";
import { notify } from "./notify";
import { sessionContext } from "./session-context";

export const hooks: readonly Hook<any>[] = [
  blockDestructiveShell,
  check,
  formatOnEdit,
  gitGuard,
  notify,
  sessionContext,
];
