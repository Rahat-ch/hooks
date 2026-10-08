/**
 * GNU/git-style option parsing over an argv tail. Short-flag clusters are
 * expanded (`-rf` → `-r`, `-f`), long flags are recognised with `=` or a
 * separate value, options may follow operands, and `--` ends options.
 */

export interface ParsedOption {
  /** `-f` for short options, `--force` for long ones. */
  readonly name: string;
  /** The option's value, for `--name=value`, `-ovalue`, or an option listed in `withValue`. */
  readonly value: string | undefined;
}

export interface ParsedArgs {
  readonly options: readonly ParsedOption[];
  readonly operands: readonly string[];
}

export interface OptionSpec {
  /**
   * Options that take a value, e.g. `["-m", "--message"]`. A short one
   * consumes the rest of its cluster (`-mfix`) or the next argument; a long
   * one consumes the next argument unless written `--name=value`.
   */
  readonly withValue?: readonly string[];
}

export function parseOptions(args: readonly string[], spec: OptionSpec = {}): ParsedArgs {
  const withValue = new Set(spec.withValue ?? []);
  const options: ParsedOption[] = [];
  const operands: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        options.push({ name: arg.slice(0, eq), value: arg.slice(eq + 1) });
      } else if (withValue.has(arg)) {
        options.push({ name: arg, value: args[i + 1] });
        i++;
      } else {
        options.push({ name: arg, value: undefined });
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const name = `-${arg[j]}`;
        if (withValue.has(name)) {
          const rest = arg.slice(j + 1);
          if (rest !== "") {
            options.push({ name, value: rest });
          } else {
            options.push({ name, value: args[i + 1] });
            i++;
          }
          break;
        }
        options.push({ name, value: undefined });
      }
      continue;
    }
    operands.push(arg);
  }
  return { options, operands };
}
