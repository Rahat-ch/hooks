/**
 * Every built-in Hook. Keep one import and one entry per line, sorted by
 * Hook name, so parallel additions merge cleanly.
 */
import type { Hook } from "./hook";
import { gitGuard } from "./git-guard";
import { notify } from "./notify";

export const hooks: readonly Hook<any>[] = [
  gitGuard,
  notify,
];
