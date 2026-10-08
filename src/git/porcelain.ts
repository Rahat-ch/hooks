/** Parsing `git status --porcelain=v2 -z` (with or without `--branch`). */

export interface PorcelainStatus {
  /** `# <key> <value>` header lines (`--branch`), e.g. `branch.head` → `main`. */
  readonly headers: ReadonlyMap<string, string>;
  /**
   * Paths with staged, unstaged, untracked or conflicted changes, relative to
   * the repo root, in git's order. A rename or copy names its new path.
   */
  readonly paths: readonly string[];
}

/** Fields before the path in each record type: ordinary, renamed/copied, unmerged, untracked. */
const fieldsBeforePath: Readonly<Record<string, number>> = { "1": 8, "2": 9, u: 10, "?": 1 };

export function parsePorcelainV2(output: string): PorcelainStatus {
  const headers = new Map<string, string>();
  const paths: string[] = [];
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.startsWith("# ")) {
      const [, key, ...rest] = record.split(" ");
      if (key !== undefined) headers.set(key, rest.join(" "));
      continue;
    }
    const fields = fieldsBeforePath[record[0] ?? ""];
    if (fields === undefined || record[1] !== " ") continue; // `!` (ignored) and anything unknown
    // Everything after the leading fields: the path may contain spaces.
    paths.push(record.split(" ").slice(fields).join(" "));
    if (record[0] === "2") i++; // the rename's original path follows as its own record
  }
  return { headers, paths };
}
