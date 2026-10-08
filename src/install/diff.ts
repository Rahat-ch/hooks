/**
 * A unified line diff, for showing what init/uninstall will change in a
 * settings file. Settings files are small, so a plain LCS table is enough.
 */

type Op = { kind: " " | "-" | "+"; line: string };

function lines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\n$/, "").split("\n");
}

function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: length of the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i++]! });
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      ops.push({ kind: "+", line: b[j++]! });
    } else {
      ops.push({ kind: "-", line: a[i++]! });
    }
  }
  return ops;
}

/**
 * `--- old` / `+++ new` headers and `@@` hunks with `context` unchanged lines
 * around each change. Empty string when the texts have the same lines.
 */
export function unifiedDiff(oldText: string, newText: string, oldLabel: string, newLabel: string, context = 3): string {
  const ops = diffLines(lines(oldText), lines(newText));
  const changed = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
  if (changed.length === 0) return "";

  // Merge each change's context window into hunks of op indices [start, end).
  const ranges: [number, number][] = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && start <= last[1]) last[1] = end;
    else ranges.push([start, end]);
  }

  // Line numbers (1-based) in the old and new text at the start of each op.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    oldAt.push(oldLine);
    newAt.push(newLine);
    if (op.kind !== "+") oldLine++;
    if (op.kind !== "-") newLine++;
  }

  const out = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const [start, end] of ranges) {
    const hunk = ops.slice(start, end);
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    // Unified diff convention: an empty range starts at the line before it.
    const oldStart = oldCount === 0 ? oldAt[start]! - 1 : oldAt[start]!;
    const newStart = newCount === 0 ? newAt[start]! - 1 : newAt[start]!;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk) out.push(`${op.kind}${op.line}`);
  }
  return out.join("\n") + "\n";
}
