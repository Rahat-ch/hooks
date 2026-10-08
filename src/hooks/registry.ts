/**
 * Every built-in Hook. Keep one import and one entry per line, sorted by
 * Hook name, so parallel additions merge cleanly.
 */
import type { Hook } from "./hook";
import { formatOnEdit } from "./format-on-edit";
import { gitGuard } from "./git-guard";

export const hooks: readonly Hook<any>[] = [
  formatOnEdit,
  gitGuard,
];
