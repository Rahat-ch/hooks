/**
 * The walker behind `analyzeShell`: visits every node of an unbash AST,
 * expands words, unwraps launcher programs and emits simple commands.
 */
import { resolve } from "node:path";
import { parse, type Command, type ParsedScript, type Redirection as AstRedirection, type Statement } from "unbash";
import type { AnalyzeOptions, Redirection, ShellAnalysis, SimpleCommand } from "./index";
import { expandWord, taintOf, type ExpansionEnv, type Field, type Span } from "./words";

class AnalysisError extends Error {}

/** Nested scripts (bash -c, eval, substitutions, data) deeper than this fail the analysis. */
const MAX_DEPTH = 16;
/** Data text longer than this is not inspected for embedded commands. */
const MAX_DATA_LENGTH = 64 * 1024;

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "ash"]);
const DECLARATIONS = new Set(["export", "declare", "local", "readonly", "typeset"]);

interface Scope {
  vars: Map<string, string>;
  cwd: string | undefined;
}

interface Ctx {
  readonly out: SimpleCommand[];
  readonly home: string | undefined;
  readonly depth: number;
  readonly executes: boolean;
  readonly via: readonly string[];
  /**
   * Source ranges of the script being walked that an enclosing shell fills in
   * at run time: unresolved expansions in a `bash -c`/`eval` string, `{}` in
   * a `find -exec sh -c` script. Words touching them are dynamic.
   */
  readonly taint: readonly Span[] | undefined;
}

/** Inherited from an enclosing pipeline or redirected compound command. */
interface Io {
  readonly redirections: readonly Redirection[];
  /** Static text arriving on stdin through a pipe, e.g. from `echo "..." |`. */
  readonly pipedText: string | undefined;
  readonly pipedFrom: readonly SimpleCommand[] | undefined;
}

/** One command invocation on its way through `unwrap`. */
interface Call {
  readonly cwd: string | undefined;
  readonly via: readonly string[];
  readonly redirections: readonly Redirection[];
  /** The command's own heredoc or here-string text. */
  readonly stdinText: string | undefined;
  readonly pipedText: string | undefined;
  readonly pipedFrom: readonly SimpleCommand[] | undefined;
  /** Arguments will be appended or substituted at run time (xargs, find -exec). */
  readonly dynamic: boolean;
  /** Still running in the current shell (no process-spawning wrapper crossed), so `cd` affects later commands. */
  readonly inShell: boolean;
  /** Text that `find -exec` or `xargs -I` replaces with a run-time value, e.g. `{}`. */
  readonly placeholder?: string | undefined;
}

const noIo: Io = { redirections: [], pipedText: undefined, pipedFrom: undefined };

export function analyze(source: string, options: AnalyzeOptions): ShellAnalysis {
  const ctx: Ctx = { out: [], home: options.home, depth: 0, executes: true, via: [], taint: undefined };
  try {
    runSource(source, { vars: new Map(), cwd: options.cwd }, ctx);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, commands: ctx.out };
}

function copyScope(scope: Scope): Scope {
  return { vars: new Map(scope.vars), cwd: scope.cwd };
}

function deeper(ctx: Ctx, changes: Partial<Ctx> = {}): Ctx {
  const next = { ...ctx, depth: ctx.depth + 1, ...changes };
  if (next.depth > MAX_DEPTH) throw new AnalysisError("commands are nested too deeply to analyse");
  return next;
}

function checkErrors(script: ParsedScript | undefined): asserts script is ParsedScript {
  if (script === undefined) throw new AnalysisError("could not parse a command substitution");
  if (script.errors && script.errors.length > 0) {
    throw new AnalysisError(script.errors.map((e) => e.message).join("; "));
  }
}

/** Parse and walk a script; returns the static stdout of a single-command script. */
function runSource(source: string, scope: Scope, ctx: Ctx): string | undefined {
  const script = parse(source);
  checkErrors(script);
  return walkStatements(script.commands, scope, ctx);
}

function walkStatements(statements: readonly Statement[], scope: Scope, ctx: Ctx, io: Io = noIo): string | undefined {
  let stdout: string | undefined;
  for (const statement of statements) stdout = walkNode(statement.command, scope, ctx, io);
  return statements.length === 1 ? stdout : undefined;
}

/** Text that only looks like commands: record what it contains as non-executing. Never fails the analysis. */
function inspectData(text: string, scope: Scope, ctx: Ctx): void {
  if (!/\s/.test(text.trim()) || text.length > MAX_DATA_LENGTH || ctx.depth >= MAX_DEPTH) return;
  try {
    const script = parse(text);
    if (script.errors && script.errors.length > 0) return;
    walkStatements(script.commands, copyScope(scope), deeper(ctx, { executes: false, taint: undefined }));
  } catch {
    // Prose that isn't valid shell is just prose.
  }
}

function expansionEnv(scope: Scope, ctx: Ctx): ExpansionEnv {
  return {
    vars: scope.vars,
    home: ctx.home,
    runScript(script) {
      checkErrors(script);
      return walkStatements(script.commands, copyScope(scope), deeper(ctx));
    },
    scan(node) {
      scanForScripts(node, scope, ctx);
    },
    taint(pos, end) {
      return taintOf(ctx.taint, pos, end);
    },
  };
}

/** Find and walk scripts hidden anywhere in a node (arithmetic, test expressions, parameter operands). */
function scanForScripts(node: unknown, scope: Scope, ctx: Ctx): void {
  if (Array.isArray(node)) {
    for (const child of node) scanForScripts(child, scope, ctx);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  if (record.type === "Word") {
    expandWord(record as never, expansionEnv(scope, ctx));
    return;
  }
  if (
    record.type === "CommandExpansion" ||
    record.type === "ProcessSubstitution" ||
    record.type === "ArithmeticCommandExpansion"
  ) {
    expansionEnv(scope, ctx).runScript(record.script as ParsedScript | undefined);
    return;
  }
  for (const [key, value] of Object.entries(record)) {
    if (key !== "pos" && key !== "end") scanForScripts(value, scope, ctx);
  }
}

function expandAll(words: readonly unknown[], scope: Scope, ctx: Ctx): void {
  const env = expansionEnv(scope, ctx);
  for (const word of words) expandWord(word as never, env);
}

/** Walk any AST node. Returns the static stdout of a simple command, when known. */
function walkNode(node: unknown, scope: Scope, ctx: Ctx, io: Io): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const n = node as { type: string } & Record<string, any>;
  switch (n.type) {
    case "Command":
      return walkCommand(n as unknown as Command, scope, ctx, io);
    case "Statement":
    case "Time":
    case "Negation":
      return walkNode(n.command, scope, ctx, io);
    case "AndOr":
      for (const child of n.commands) walkNode(child, scope, ctx, io);
      return undefined;
    case "Pipeline": {
      let pipedText: string | undefined;
      let pipedFrom: SimpleCommand[] | undefined;
      n.commands.forEach((stage: unknown, index: number) => {
        const before = ctx.out.length;
        const stageIo: Io = { redirections: io.redirections, pipedText, pipedFrom };
        // Every stage of a pipeline runs in its own subshell.
        pipedText = walkNode(stage, index === n.commands.length - 1 ? scope : copyScope(scope), ctx, stageIo);
        pipedFrom = ctx.out.slice(before);
      });
      return undefined;
    }
    case "CompoundList":
      return walkStatements(n.commands, scope, ctx, io);
    case "Subshell":
      walkNode(n.body, copyScope(scope), ctx, io);
      return undefined;
    case "BraceGroup":
      walkNode(n.body, scope, ctx, io);
      return undefined;
    case "If":
      walkNode(n.clause, scope, ctx, io);
      walkNode(n.then, scope, ctx, io);
      walkNode(n.else, scope, ctx, io);
      return undefined;
    case "While":
      walkNode(n.clause, scope, ctx, io);
      walkNode(n.body, scope, ctx, io);
      return undefined;
    case "For":
    case "Select":
      expandAll(n.wordlist ?? [], scope, ctx);
      walkNode(n.body, scope, ctx, io);
      return undefined;
    case "ArithmeticFor":
      scanForScripts([n.initialize, n.test, n.update], scope, ctx);
      walkNode(n.body, scope, ctx, io);
      return undefined;
    case "Case":
      expandAll([n.word], scope, ctx);
      for (const item of n.items) {
        expandAll(item.pattern, scope, ctx);
        walkNode(item.body, scope, ctx, io);
      }
      return undefined;
    case "TestCommand":
    case "ArithmeticCommand":
      scanForScripts(n.expression, scope, ctx);
      return undefined;
    case "Function":
    case "Coproc":
      // A function body runs whenever it's called; assume it is.
      walkNode(n.body, copyScope(scope), ctx, io);
      return undefined;
    case "Redirected": {
      const own = convertRedirections(n.redirects, scope, ctx);
      walkNode(n.command, scope, ctx, {
        ...io,
        redirections: [...io.redirections, ...own.redirections],
        pipedText: own.stdinText ?? io.pipedText,
      });
      return undefined;
    }
    default:
      scanForScripts(n, scope, ctx);
      return undefined;
  }
}

interface ConvertedRedirections {
  redirections: Redirection[];
  /** Text of a heredoc or here-string feeding stdin. */
  stdinText: string | undefined;
}

function convertRedirections(redirects: readonly AstRedirection[], scope: Scope, ctx: Ctx): ConvertedRedirections {
  const env = expansionEnv(scope, ctx);
  const redirections: Redirection[] = [];
  let stdinText: string | undefined;
  for (const r of redirects) {
    if (r.type === "HereDoc") {
      // With an unquoted delimiter, substitutions in the body run before the program reads it.
      if (!r.delimiter?.quoted) for (const part of r.body.parts ?? []) scanForScripts(part, scope, ctx);
      stdinText = r.operator === "<<-" ? r.body.text.replace(/^\t+/gm, "") : r.body.text;
      continue;
    }
    if (r.target === undefined) continue;
    const fields = expandWord(r.target, env);
    const target = fields.map((f) => f.value).join(" ");
    const dynamic = fields.some((f) => f.dynamic);
    if (r.type === "HereString") {
      stdinText = `${target}\n`;
      continue;
    }
    // `2>&1`, `<&0`, `>&-`: descriptor duplication, not a file.
    if ((r.operator === ">&" || r.operator === "<&") && /^(\d+-?|-)$/.test(target)) continue;
    const direction = r.operator === "<" || r.operator === "<&" ? "read" : r.operator === "<>" ? "readwrite" : "write";
    const path = !dynamic && scope.cwd !== undefined ? resolve(scope.cwd, target) : undefined;
    redirections.push({ operator: r.operator, direction, target, path });
  }
  return { redirections, stdinText };
}

function walkCommand(cmd: Command, scope: Scope, ctx: Ctx, io: Io): string | undefined {
  const env = expansionEnv(scope, ctx);

  // Assignment prefixes (`FOO=1 cmd`) only set the command's environment and are stripped.
  for (const item of cmd.prefix) {
    if (item.type !== "Assignment") continue;
    const values = item.value.type === "ArrayValue" ? item.value.elements : [item.value];
    const fields = values.flatMap((word) => expandWord(word, env));
    if (cmd.name === undefined) assign(scope, item.name, fields);
  }

  const fields: Field[] = [];
  const words = cmd.name === undefined ? [] : [cmd.name, ...cmd.args];
  let declaration = false;
  for (const word of words) {
    if (word.type === "Word") {
      fields.push(...expandWord(word, env));
      if (fields.length === 1 && DECLARATIONS.has(fields[0]!.value)) declaration = true;
      continue;
    }
    // An assignment argument, as in `export FOO=bar`.
    const values = word.value.type === "ArrayValue" ? word.value.elements : [word.value];
    const expanded = values.flatMap((w) => expandWord(w, env));
    if (declaration) assign(scope, word.name, expanded);
    fields.push({
      value: `${word.name}=${expanded.map((f) => f.value).join(" ")}`,
      dynamic: expanded.some((f) => f.dynamic),
      quoted: expanded.some((f) => f.quoted),
    });
  }

  const own = convertRedirections(cmd.redirects, scope, ctx);
  const call: Call = {
    cwd: scope.cwd,
    via: ctx.via,
    redirections: [...io.redirections, ...own.redirections],
    stdinText: own.stdinText,
    pipedText: io.pipedText,
    pipedFrom: io.pipedFrom,
    dynamic: false,
    inShell: true,
  };

  if (fields.length === 0) {
    // A bare redirection such as `> file` still opens the file.
    if (call.redirections.length > 0) emit([], scope, ctx, call);
    return undefined;
  }

  unwrap(fields, scope, ctx, call);
  return staticStdout(fields, own.stdinText);
}

function assign(scope: Scope, name: string, fields: readonly Field[]): void {
  if (fields.some((f) => f.dynamic)) scope.vars.delete(name);
  else scope.vars.set(name, fields.map((f) => f.value).join(" "));
}

function unescape(text: string): string {
  return text.replace(/\\([ntr\\])/g, (_, c: string) => ({ n: "\n", t: "\t", r: "\r", "\\": "\\" })[c]!);
}

/** What `echo`, `printf` or `cat <<EOF` would print, when that is statically known. */
function staticStdout(fields: readonly Field[], stdinText: string | undefined): string | undefined {
  if (fields.some((f) => f.dynamic)) return undefined;
  const program = programName(fields[0]!.value);
  const args = fields.slice(1).map((f) => f.value);
  if (program === "echo") {
    while (args[0] !== undefined && /^-[neE]+$/.test(args[0])) args.shift();
    return args.join(" ");
  }
  if (program === "printf") {
    const [format, ...values] = args;
    if (format === undefined || /%[^s%]/.test(format)) return undefined;
    return unescape(format.replace(/%([s%])/g, (_, c: string) => (c === "%" ? "%" : (values.shift() ?? ""))));
  }
  if (program === "cat" && args.length === 0) return stdinText;
  // `$(which rm)` and `$(command -v rm)` print a path to `rm`; its name is all a Guard needs.
  if (program === "which" && args.length === 1 && !args[0]!.startsWith("-")) return args[0];
  if (program === "command" && args.length === 2 && args[0] === "-v") return args[1];
  return undefined;
}

export function programName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).replace(/\.exe$/i, "").toLowerCase();
}

/**
 * `runsUnseenScript`: the command is a shell whose script only arrives at
 * run time (unknown piped text, arguments xargs appends to `sh -c`).
 */
function emit(fields: readonly Field[], scope: Scope, ctx: Ctx, call: Call, runsUnseenScript = false): void {
  const head = fields[0];
  const program = head === undefined ? "" : programName(head.value);
  const placeholder = call.placeholder !== undefined && call.placeholder !== "" ? call.placeholder : undefined;
  ctx.out.push({
    program,
    argv: fields.map((f) => f.value),
    redirections: call.redirections,
    executes: ctx.executes,
    cwd: call.cwd,
    dynamic: call.dynamic || fields.some((f) => f.dynamic),
    dynamicProgram:
      runsUnseenScript ||
      head?.dynamic === true ||
      (head !== undefined && placeholder !== undefined && head.value.includes(placeholder)),
    via: call.via,
    pipedFrom: call.pipedFrom,
  });
  // Quoted arguments and heredocs given to an ordinary program are data. Record
  // any commands they contain as non-executing, so Guards can tell the difference.
  for (const field of fields.slice(1)) {
    if (field.quoted && !field.dynamic) inspectData(field.value, scope, ctx);
  }
  if (call.stdinText !== undefined) inspectData(call.stdinText, scope, ctx);
}

interface ScannedOption {
  name: string;
  value: string | undefined;
  /** The value as a field, keeping its unresolved parts. */
  field?: Field | undefined;
}

/** The last `length` characters of a field, e.g. the value in `--command=...`. */
function suffixField(field: Field, length: number): Field {
  const offset = field.value.length - length;
  const spans = fieldSpans(field).flatMap(([s, e]): Span[] => (e <= offset ? [] : [[Math.max(s, offset) - offset, e - offset]]));
  return { value: field.value.slice(offset), dynamic: spans.length > 0, quoted: field.quoted, spans };
}

/**
 * GNU-style option scan. It stops at the first operand, as launcher programs
 * do, unless `permute` (getopt's default), which collects operands and goes on.
 */
function scanOptions(
  args: readonly Field[],
  shortWithValue: string,
  longWithValue: readonly string[] = [],
  permute = false,
): { index: number; options: ScannedOption[]; operands: Field[] } {
  const options: ScannedOption[] = [];
  const operands: Field[] = [];
  const withValue = (name: string, field: Field, value: string): ScannedOption => ({
    name,
    value,
    field: suffixField(field, value.length),
  });
  let i = 0;
  while (i < args.length) {
    const field = args[i]!;
    const arg = field.value;
    if (arg === "--") {
      if (permute) operands.push(...args.slice(i + 1));
      return { index: i + 1, options, operands };
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const next = args[i + 1];
      if (eq !== -1) {
        options.push(withValue(arg.slice(0, eq), field, arg.slice(eq + 1)));
      } else if (longWithValue.includes(arg) && next !== undefined) {
        options.push(withValue(arg, next, next.value));
        i++;
      } else {
        options.push({ name: arg, value: undefined });
      }
      i++;
      continue;
    }
    if (!arg.startsWith("-") || arg.length === 1) {
      if (!permute) break;
      operands.push(field);
      i++;
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j]!;
      if (shortWithValue.includes(letter)) {
        const rest = arg.slice(j + 1);
        const next = args[i + 1];
        if (rest !== "") {
          options.push(withValue(`-${letter}`, field, rest));
        } else if (next !== undefined) {
          options.push(withValue(`-${letter}`, next, next.value));
          i++;
        } else {
          options.push({ name: `-${letter}`, value: undefined });
        }
        break;
      }
      options.push({ name: `-${letter}`, value: undefined });
    }
    i++;
  }
  return { index: i, options, operands };
}

/** The value of the last of the named options, as a field. */
function optionField(options: readonly ScannedOption[], names: readonly string[]): Field | undefined {
  return options.filter((o) => names.includes(o.name)).pop()?.field;
}

/** Fields joined with spaces into one string, as `eval` and `watch` do. */
function joinFields(fields: readonly Field[]): Field {
  let value = "";
  const spans: Span[] = [];
  for (const field of fields) {
    if (value !== "") value += " ";
    spans.push(...fieldSpans(field).map(([s, e]): Span => [s + value.length, e + value.length]));
    value += field.value;
  }
  return { value, dynamic: fields.some((f) => f.dynamic), quoted: false, spans };
}

/** `su`/`runuser`: `-c` runs a string in the user's shell; options may follow the user name. */
function switchUser(args: readonly Field[], runuser: boolean): Launch | undefined {
  const longWithValue = ["--command", "--session-command", "--group", "--supp-group", "--shell", "--whitelist-environment", "--user"];
  const { options } = scanOptions(args, "cgGswu", longWithValue, true);
  const script = optionField(options, ["-c", "--command", "--session-command"]);
  if (script !== undefined) return { inner: [], script, spawns: true };
  // `runuser -u user [--] command args`
  if (runuser && options.some((o) => o.name === "-u" || o.name === "--user")) {
    return { inner: args.slice(scanOptions(args, "cgGswu", longWithValue).index), spawns: true };
  }
  return undefined;
}

const isAssignment = (field: Field) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(field.value);

/** Result of peeling one launcher off a command: the command it launches. */
interface Launch {
  inner: Field[];
  cwd?: string | undefined;
  dynamic?: boolean;
  /** The launcher runs `inner` in a new process, so `cd` there doesn't affect this shell. */
  spawns: boolean;
  /** Text the launcher replaces with run-time values in `inner` (`xargs -I {}`). */
  placeholder?: string | undefined;
  /** Instead of `inner`, a string the launcher runs with `sh -c` (`su -c`, `watch`). */
  script?: Field | undefined;
}

function dirOption(options: { name: string; value: string | undefined }[], names: string[], cwd: string | undefined) {
  const dir = options.filter((o) => names.includes(o.name)).pop()?.value;
  if (dir === undefined) return cwd;
  return cwd === undefined ? undefined : resolve(cwd, dir);
}

/** Launcher programs that run their arguments as a command. undefined: not launching anything this time. */
const launchers: Record<string, (args: Field[], call: Call) => Launch | undefined> = {
  env(args, call) {
    const rest = args[0]?.value === "-" ? args.slice(1) : args;
    const { index, options } = scanOptions(rest, "uCS", ["--unset", "--chdir", "--split-string"]);
    let inner = rest.slice(index);
    const splitString = optionField(options, ["-S", "--split-string"]);
    if (splitString !== undefined) {
      const spans = fieldSpans(splitString);
      const words = [...splitString.value.matchAll(/\S+/g)].map((match): Field => {
        const start = match.index;
        const end = start + match[0].length;
        return { value: match[0], dynamic: spans.some(([s, e]) => s < end && start < e), quoted: false };
      });
      inner = [...words, ...inner];
    }
    while (inner[0] !== undefined && isAssignment(inner[0])) inner = inner.slice(1);
    return { inner, cwd: dirOption(options, ["-C", "--chdir"], call.cwd), spawns: true };
  },
  sudo(args, call) {
    const { index, options } = scanOptions(args, "ugpCDrtUTR", [
      "--user",
      "--group",
      "--prompt",
      "--chdir",
      "--close-from",
      "--role",
      "--type",
      "--other-user",
      "--command-timeout",
      "--chroot",
      "--host",
    ]);
    // `sudo -e` / `--edit` edits files rather than running a command.
    if (options.some((o) => o.name === "-e" || o.name === "--edit")) return undefined;
    let inner = args.slice(index);
    while (inner[0] !== undefined && isAssignment(inner[0])) inner = inner.slice(1);
    return { inner, cwd: dirOption(options, ["-D", "--chdir"], call.cwd), spawns: true };
  },
  doas(args) {
    return { inner: args.slice(scanOptions(args, "uC").index), spawns: true };
  },
  xargs(args) {
    const { index, options } = scanOptions(args, "ILnPsdEa", [
      "--arg-file",
      "--delimiter",
      "--max-args",
      "--max-procs",
      "--max-chars",
      "--process-slot-var",
    ]);
    const inner = args.slice(index);
    const replace = options.filter((o) => o.name === "-I" || o.name === "-i" || o.name === "--replace").pop();
    return {
      inner: inner.length > 0 ? inner : [{ value: "echo", dynamic: false, quoted: false }],
      dynamic: true,
      spawns: true,
      placeholder: replace === undefined ? undefined : (replace.value ?? "{}"),
    };
  },
  nice(args) {
    return { inner: args.slice(scanOptions(args, "n", ["--adjustment"]).index), spawns: true };
  },
  timeout(args) {
    // Options, then the duration, then the command.
    return { inner: args.slice(scanOptions(args, "sk", ["--signal", "--kill-after"]).index + 1), spawns: true };
  },
  nohup(args) {
    return { inner: args[0]?.value === "--" ? args.slice(1) : args, spawns: true };
  },
  stdbuf(args) {
    return { inner: args.slice(scanOptions(args, "ioe", ["--input", "--output", "--error"]).index), spawns: true };
  },
  time(args) {
    return { inner: args.slice(scanOptions(args, "of", ["--output", "--format"]).index), spawns: true };
  },
  command(args) {
    const { index, options } = scanOptions(args, "");
    // `command -v git` only looks the program up.
    if (options.some((o) => o.name === "-v" || o.name === "-V")) return undefined;
    return { inner: args.slice(index), spawns: false };
  },
  builtin(args) {
    return { inner: args, spawns: false };
  },
  exec(args) {
    return { inner: args.slice(scanOptions(args, "a").index), spawns: false };
  },
  setsid(args) {
    return { inner: args.slice(scanOptions(args, "").index), spawns: true };
  },
  ionice(args) {
    const { index, options } = scanOptions(args, "cnpPu", ["--class", "--classdata", "--pid", "--pgid", "--uid"]);
    // `ionice -p PID` changes a running process.
    if (options.some((o) => ["-p", "-P", "-u", "--pid", "--pgid", "--uid"].includes(o.name))) return undefined;
    return { inner: args.slice(index), spawns: true };
  },
  su(args) {
    return switchUser(args, false);
  },
  runuser(args) {
    return switchUser(args, true);
  },
  script(args) {
    // util-linux: `script [options] [file]`, `-c` runs a string; BSD/macOS: `script [options] file command args`.
    const shortWithValue = "cEIOBTmotF";
    const longWithValue = ["--command", "--echo", "--log-in", "--log-out", "--log-io", "--log-timing", "--logging-format", "--output-limit"];
    const { index, options } = scanOptions(args, shortWithValue, longWithValue);
    const after = args.slice(index + 1);
    const script =
      optionField(options, ["-c", "--command"]) ??
      optionField(scanOptions(after, shortWithValue, longWithValue).options, ["-c", "--command"]);
    if (script !== undefined) return { inner: [], script, spawns: true };
    return { inner: after, spawns: true };
  },
  flock(args) {
    // `flock [options] lockfile command args`, `flock [options] lockfile -c string`, or `flock [options] fd`.
    const longWithValue = ["--timeout", "--wait", "--conflict-exit-code", "--command"];
    const { index, options } = scanOptions(args, "wEc", longWithValue);
    const after = args.slice(index + 1);
    const script =
      optionField(options, ["-c", "--command"]) ?? optionField(scanOptions(after, "c", ["--command"]).options, ["-c", "--command"]);
    if (script !== undefined) return { inner: [], script, spawns: true };
    return { inner: after, spawns: true };
  },
  watch(args) {
    const { index, options } = scanOptions(args, "nq", ["--interval", "--equexit"]);
    const inner = args.slice(index);
    if (inner.length === 0) return undefined;
    // Without `-x`, watch joins its arguments and runs them with `sh -c`.
    if (options.some((o) => o.name === "-x" || o.name === "--exec")) return { inner, spawns: true };
    return { inner: [], script: joinFields(inner), spawns: true };
  },
};

/** How a shell was invoked: `bash -c '...'`, reading a script file, or reading stdin. */
function shellInvocation(args: readonly Field[]): { mode: "command"; script: Field | undefined } | { mode: "file" | "stdin" } {
  let command = false;
  let stdin = false;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!.value;
    if (arg === "--" || arg === "-") {
      i++;
      break;
    }
    if (arg.startsWith("--")) {
      if (arg === "--rcfile" || arg === "--init-file") i++;
      continue;
    }
    if (!/^[-+][A-Za-z]+$/.test(arg)) break;
    const letters = arg.slice(1);
    if (arg[0] === "-" && letters.includes("c")) command = true;
    if (arg[0] === "-" && letters.includes("s")) stdin = true;
    if (/[oO]/.test(letters)) i++;
  }
  if (command) return { mode: "command", script: args[i] };
  return { mode: stdin || i >= args.length ? "stdin" : "file" };
}

function unwrap(fields: Field[], scope: Scope, ctx: Ctx, call: Call): void {
  const head = fields[0];
  if (head === undefined) return;
  const program = programName(head.value);
  if (head.dynamic) return emit(fields, scope, ctx, call);
  const args = fields.slice(1);
  const via = [...call.via, program];

  if (SHELLS.has(program)) {
    const invocation = shellInvocation(args);
    const script =
      invocation.mode === "command"
        ? invocation.script
        : invocation.mode === "stdin" && (call.stdinText ?? call.pipedText) !== undefined
          ? { value: (call.stdinText ?? call.pipedText)!, dynamic: false, quoted: false }
          : undefined;
    // A script file or an unknown stdin (`curl ... | sh`) can't be seen into.
    if (script === undefined) {
      const unseen =
        (invocation.mode === "command" && call.dynamic) ||
        (invocation.mode === "stdin" && call.pipedFrom !== undefined && call.stdinText === undefined);
      return emit(fields, scope, ctx, call, unseen);
    }
    runScriptField(script, fields, { vars: new Map(), cwd: call.cwd }, ctx, call, via);
    return;
  }

  if (program === "eval") {
    // eval joins its arguments with spaces and runs the result in this shell.
    runScriptField(joinFields(args), fields, call.inShell ? scope : copyScope(scope), ctx, call, via);
    return;
  }

  if (program === "find") {
    emit(fields, scope, ctx, call);
    for (let i = 0; i < args.length; i++) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i]!.value)) continue;
      const end = args.findIndex((f, j) => j > i && (f.value === ";" || f.value === "+"));
      const inner = args.slice(i + 1, end === -1 ? undefined : end);
      unwrap(inner, scope, ctx, {
        ...call,
        via,
        dynamic: true,
        inShell: false,
        stdinText: undefined,
        pipedText: undefined,
        placeholder: "{}",
      });
      if (end === -1) break;
      i = end;
    }
    return;
  }

  if (call.inShell && (program === "cd" || program === "pushd" || program === "popd")) {
    scope.cwd = changeDirectory(program, args, scope.cwd, ctx.home);
    return emit(fields, scope, ctx, call);
  }

  const launcher = launchers[program];
  const launch = launcher?.(args, call);
  if (launch?.script !== undefined) {
    runScriptField(launch.script, fields, { vars: new Map(), cwd: call.cwd }, ctx, call, via);
    return;
  }
  if (launch === undefined || launch.inner.length === 0) return emit(fields, scope, ctx, call);
  unwrap(launch.inner, scope, ctx, {
    ...call,
    via,
    cwd: launch.cwd ?? call.cwd,
    dynamic: call.dynamic || launch.dynamic === true,
    inShell: call.inShell && !launch.spawns,
    placeholder: launch.placeholder ?? call.placeholder,
  });
}

/** The parts of a field that are only known at run time. A dynamic field always has some. */
function fieldSpans(field: Field): readonly Span[] {
  if (field.spans !== undefined && field.spans.length > 0) return field.spans;
  return field.dynamic ? [[0, field.value.length]] : [];
}

/**
 * Run a script given as a string (`bash -c`, `eval`, a shell's stdin). When
 * parts of it are only known at run time, analyse the script as written with
 * those parts marked dynamic, and also report the launching command itself,
 * so Guards can judge a script that is partly unseen (`sh -c "$(curl ...)"`).
 */
function runScriptField(script: Field, launcher: Field[], scope: Scope, ctx: Ctx, call: Call, via: readonly string[]): void {
  const spans = [...fieldSpans(script)];
  if (call.placeholder !== undefined && call.placeholder !== "") {
    for (let i = script.value.indexOf(call.placeholder); i !== -1; i = script.value.indexOf(call.placeholder, i + 1)) {
      spans.push([i, i + call.placeholder.length]);
    }
  }
  if (script.dynamic) emit(launcher, scope, ctx, call);
  runSource(script.value, scope, deeper(ctx, { via, taint: spans.length > 0 ? spans : undefined }));
}

function changeDirectory(
  program: string,
  args: readonly Field[],
  cwd: string | undefined,
  home: string | undefined,
): string | undefined {
  if (program === "popd") return undefined;
  const operands = args.filter((f) => !/^-[LPe@]+$/.test(f.value));
  const target = operands[0];
  if (target === undefined) return program === "cd" ? home : cwd;
  if (target.dynamic || target.value === "-" || cwd === undefined) return undefined;
  return resolve(cwd, target.value);
}
