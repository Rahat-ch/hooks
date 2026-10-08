/**
 * Every built-in Hook. Keep one import and one entry per line, sorted by
 * Hook name, so parallel additions merge cleanly.
 */
import type { Hook } from "./hook";
import { blockDestructiveShell } from "./block-destructive-shell";
import { formatOnEdit } from "./format-on-edit";
import { gitGuard } from "./git-guard";
import { sessionContext } from "./session-context";

export const hooks: readonly Hook<any>[] = [
  blockDestructiveShell,
  formatOnEdit,
  gitGuard,
  sessionContext,
];
