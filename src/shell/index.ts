/**
 * Shell analysis: "what will this command line actually execute?"
 *
 * Minimal version for the tracer bullet. #5 builds this out (wrapper
 * unwrapping, flag normalization, data-vs-command, redirections) behind the
 * same entry point, so Guards should only depend on `analyzeShell`.
 */
import { parse } from "unbash";

export interface SimpleCommand {
  /** Command name followed by its arguments, with quotes removed. */
  readonly argv: readonly string[];
}

export type ShellAnalysis =
  | { readonly ok: true; readonly commands: readonly SimpleCommand[] }
  | { readonly ok: false; readonly error: string };

export function analyzeShell(source: string): ShellAnalysis {
  let script: ReturnType<typeof parse>;
  try {
    script = parse(source);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (script.errors && script.errors.length > 0) {
    return { ok: false, error: script.errors.map((e) => e.message).join("; ") };
  }
  const commands: SimpleCommand[] = [];
  collect(script, commands);
  return { ok: true, commands };
}

/** Walk every node, collecting simple commands, including those nested in $(), subshells and lists. */
function collect(node: unknown, out: SimpleCommand[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  if (record.type === "Command") {
    const words = [record.name, ...((record.suffix as unknown[] | undefined) ?? [])].filter(
      (w): w is { type: "Word"; value: string } =>
        typeof w === "object" && w !== null && (w as { type?: unknown }).type === "Word",
    );
    if (words.length > 0) out.push({ argv: words.map((w) => w.value) });
  }
  for (const [key, value] of Object.entries(record)) {
    if (key !== "pos" && key !== "end") collect(value, out);
  }
  // unbash computes Word.parts lazily on the prototype, so Object.entries misses it.
  if (record.type === "Word") collect(record.parts, out);
}
