/**
 * Word expansion: turns an unbash Word into the argument strings a program
 * would receive, as far as that is knowable without running anything.
 */
import type { ParsedScript, Word, WordPart } from "unbash";

/** A half-open `[start, end)` range of characters. */
export type Span = readonly [start: number, end: number];

/** One argument after expansion. */
export interface Field {
  readonly value: string;
  /** Contains an expansion we could not resolve; `value` holds its source text. */
  readonly dynamic: boolean;
  /** Some of the word was quoted. */
  readonly quoted: boolean;
  /**
   * Where in `value` the unresolved source text sits. When the field is run
   * as a script (`bash -c`, `eval`), the shell substitutes these parts before
   * the script is parsed, so whatever the script makes of them is unknown.
   */
  readonly spans?: readonly Span[];
}

/** How a node of the script being expanded relates to the text that was unresolved when the script was built. */
export type Taint = "none" | "inside" | "overlap";

export interface ExpansionEnv {
  /** Statically known shell variables. */
  readonly vars: ReadonlyMap<string, string>;
  readonly home: string | undefined;
  /**
   * A script nested in the word (command or process substitution) runs when
   * the word is expanded. Analyse it and return its stdout when statically
   * known.
   */
  runScript(script: ParsedScript | undefined): string | undefined;
  /** Some other node (parameter-expansion operand, arithmetic) may hide nested scripts. */
  scan(node: unknown): void;
  /**
   * Whether the source range `[pos, end)` of the script being walked lies in
   * text an enclosing shell substitutes at run time (see `Field.spans`).
   */
  taint(pos: number, end: number): Taint;
}

export function taintOf(spans: readonly Span[] | undefined, pos: number, end: number): Taint {
  let result: Taint = "none";
  for (const [start, stop] of spans ?? []) {
    if (start <= pos && end <= stop) return "inside";
    if (start < end && pos < stop) result = "overlap";
  }
  return result;
}

function expandTilde(text: string, home: string | undefined): string {
  if (home === undefined) return text;
  if (text === "~") return home;
  if (text.startsWith("~/")) return home + text.slice(1);
  return text;
}

/** `{a,b,c}` → ["a", "b", "c"]. Sequences and nested braces are left alone. */
function braceAlternatives(text: string): string[] | undefined {
  const match = /^\{([^{}$`'"\\]*,[^{}$`'"\\]*)\}$/.exec(text);
  return match ? match[1]!.split(",") : undefined;
}

interface Alternative {
  readonly text: string;
  readonly spans: readonly Span[];
}

/** Split an unquoted expansion result into fields, carrying each field's share of the spans. */
function splitFields(alternative: Alternative): Alternative[] {
  const out: Alternative[] = [];
  for (const match of alternative.text.matchAll(/[^ \t\n]+/g)) {
    const start = match.index;
    const end = start + match[0].length;
    const spans = alternative.spans
      .filter(([s, e]) => s < end && start < e)
      .map(([s, e]): Span => [Math.max(s, start) - start, Math.min(e, end) - start]);
    out.push({ text: match[0], spans });
  }
  return out;
}

export function expandWord(word: Word, env: ExpansionEnv): Field[] {
  let alternatives: Alternative[] = [{ text: "", spans: [] }];
  let dynamic = false;
  let quoted = false;
  let split = false;
  /** Text appended now is unresolved, even if it reads as a literal. */
  let unresolved = false;
  const append = (text: string, unknown = false) => {
    if (unknown || unresolved) dynamic = true;
    alternatives = alternatives.map((a) => ({
      text: a.text + text,
      spans: unknown || unresolved ? [...a.spans, [a.text.length, a.text.length + text.length]] : a.spans,
    }));
  };

  const lookup = (name: string, text: string, inQuotes: boolean) => {
    const value = env.vars.get(name) ?? (name === "HOME" ? env.home : undefined);
    if (value === undefined) {
      append(text, true);
      return;
    }
    if (!inQuotes) split = true;
    append(value);
  };

  const visit = (part: WordPart, inQuotes: boolean, first: boolean) => {
    const taint = env.taint(part.pos, part.end);
    // Text an enclosing shell substitutes: it already ran (and was analysed)
    // there, and here it stands for a value nobody knows.
    if (taint === "inside" && part.type !== "DoubleQuoted" && part.type !== "LocaleString") {
      if (part.type === "SingleQuoted" || part.type === "AnsiCQuoted") quoted = true;
      append(part.type === "Literal" || part.type === "SingleQuoted" || part.type === "AnsiCQuoted" ? part.value : part.text, true);
      return;
    }
    const outer = unresolved;
    if (taint !== "none") unresolved = true;
    visitPart(part, inQuotes, first);
    unresolved = outer;
  };

  const visitPart = (part: WordPart, inQuotes: boolean, first: boolean) => {
    switch (part.type) {
      case "Literal":
        append(first && !inQuotes ? expandTilde(part.value, env.home) : part.value);
        return;
      case "SingleQuoted":
      case "AnsiCQuoted":
        quoted = true;
        append(part.value);
        return;
      case "DoubleQuoted":
      case "LocaleString":
        quoted = true;
        for (const child of part.parts) visit(child, true, false);
        return;
      case "SimpleExpansion":
        if (unresolved) append(part.text, true);
        else lookup(part.text.slice(1), part.text, inQuotes);
        return;
      case "ParameterExpansion":
        if (!unresolved && part.operation === undefined && part.prefix === undefined && part.index === undefined) {
          lookup(part.parameter, part.text, inQuotes);
          return;
        }
        env.scan(part.operation);
        env.scan(part.index);
        append(part.text, true);
        return;
      case "CommandExpansion": {
        const output = env.runScript(part.script);
        if (output === undefined || unresolved) {
          append(part.text, true);
        } else {
          if (!inQuotes) split = true;
          append(output);
        }
        return;
      }
      case "ProcessSubstitution":
        env.runScript(part.script);
        append(part.text, true);
        return;
      case "ArithmeticExpansion":
        env.scan(part.expression);
        append(part.text, true);
        return;
      case "BraceExpansion": {
        const options = inQuotes || unresolved ? undefined : braceAlternatives(part.text);
        if (options === undefined) append(part.text);
        else alternatives = alternatives.flatMap((a) => options.map((o) => ({ text: a.text + o, spans: a.spans })));
        return;
      }
      case "ExtendedGlob":
        append(part.text);
        return;
    }
  };

  // unbash computes `parts` lazily and leaves it undefined for plain literal words.
  const parts = word.parts;
  if (parts === undefined) {
    const value = expandTilde(word.value, env.home);
    if (env.taint(word.pos, word.end) === "none") return [{ value, dynamic: false, quoted: false }];
    return [{ value: word.value, dynamic: true, quoted: false, spans: [[0, word.value.length]] }];
  }
  parts.forEach((part, index) => visit(part, false, index === 0));

  return alternatives
    .flatMap((alternative) => (split ? splitFields(alternative) : [alternative]))
    .map(({ text, spans }) => ({ value: text, dynamic, quoted, ...(spans.length > 0 ? { spans } : {}) }));
}
