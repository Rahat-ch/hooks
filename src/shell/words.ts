/**
 * Word expansion: turns an unbash Word into the argument strings a program
 * would receive, as far as that is knowable without running anything.
 */
import type { ParsedScript, Word, WordPart } from "unbash";

/** One argument after expansion. */
export interface Field {
  readonly value: string;
  /** Contains an expansion we could not resolve; `value` holds its source text. */
  readonly dynamic: boolean;
  /** Some of the word was quoted. */
  readonly quoted: boolean;
}

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

export function expandWord(word: Word, env: ExpansionEnv): Field[] {
  let alternatives = [""];
  let dynamic = false;
  let quoted = false;
  let split = false;
  const append = (text: string) => {
    alternatives = alternatives.map((a) => a + text);
  };

  const lookup = (name: string, text: string, inQuotes: boolean) => {
    const value = env.vars.get(name) ?? (name === "HOME" ? env.home : undefined);
    if (value === undefined) {
      dynamic = true;
      append(text);
      return;
    }
    if (!inQuotes) split = true;
    append(value);
  };

  const visit = (part: WordPart, inQuotes: boolean, first: boolean) => {
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
        lookup(part.text.slice(1), part.text, inQuotes);
        return;
      case "ParameterExpansion":
        if (part.operation === undefined && part.prefix === undefined && part.index === undefined) {
          lookup(part.parameter, part.text, inQuotes);
          return;
        }
        env.scan(part.operation);
        env.scan(part.index);
        dynamic = true;
        append(part.text);
        return;
      case "CommandExpansion": {
        const output = env.runScript(part.script);
        if (output === undefined) {
          dynamic = true;
          append(part.text);
        } else {
          if (!inQuotes) split = true;
          append(output);
        }
        return;
      }
      case "ProcessSubstitution":
        env.runScript(part.script);
        dynamic = true;
        append(part.text);
        return;
      case "ArithmeticExpansion":
        env.scan(part.expression);
        dynamic = true;
        append(part.text);
        return;
      case "BraceExpansion": {
        const options = inQuotes ? undefined : braceAlternatives(part.text);
        if (options === undefined) append(part.text);
        else alternatives = alternatives.flatMap((a) => options.map((o) => a + o));
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
    return [{ value: expandTilde(word.value, env.home), dynamic: false, quoted: false }];
  }
  parts.forEach((part, index) => visit(part, false, index === 0));

  return alternatives.flatMap((value) => {
    if (!split) return [{ value, dynamic, quoted }];
    return value
      .split(/[ \t\n]+/)
      .filter((field) => field !== "")
      .map((field) => ({ value: field, dynamic, quoted }));
  });
}
