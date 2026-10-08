/**
 * The walker behind `analyzeShell`: visits every node of an unbash AST,
 * expands words, unwraps launcher programs and emits simple commands.
 */
import { resolve } from "node:path";
import { parse, type Command, type ParsedScript, type Redirection as AstRedirection, type Statement } from "unbash";
import type { AnalyzeOptions, Redirection, ShellAnalysis, SimpleCommand } from "./index";
import { expandWord, pureEnv, type ExpansionEnv, type Field } from "./words";

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
}

const noIo: Io = { redirections: [], pipedText: undefined, pipedFrom: undefined };

export function analyze(source: string, options: AnalyzeOptions): ShellAnalysis {
  const ctx: Ctx = { out: [], home: options.home, depth: 0, executes: true, via: [] };
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
    walkStatements(script.commands, copyScope(scope), deeper(ctx, { executes: false }));
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
  return undefined;
}

export function programName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).replace(/\.exe$/i, "").toLowerCase();
}

function emit(fields: readonly Field[], scope: Scope, ctx: Ctx, call: Call): void {
  const program = fields[0] === undefined ? "" : programName(fields[0].value);
  ctx.out.push({
    program,
    argv: fields.map((f) => f.value),
    redirections: call.redirections,
    executes: ctx.executes,
    cwd: call.cwd,
    dynamic: call.dynamic || fields.some((f) => f.dynamic),
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

/** GNU-style option scan that stops at the first operand, as launcher programs do. */
function scanOptions(
  args: readonly Field[],
  shortWithValue: string,
  longWithValue: readonly string[] = [],
): { index: number; options: { name: string; value: string | undefined }[] } {
  const options: { name: string; value: string | undefined }[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!.value;
    if (arg === "--") return { index: i + 1, options };
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) options.push({ name: arg.slice(0, eq), value: arg.slice(eq + 1) });
      else if (longWithValue.includes(arg)) options.push({ name: arg, value: args[++i]?.value });
      else options.push({ name: arg, value: undefined });
      i++;
      continue;
    }
    if (!arg.startsWith("-") || arg.length === 1) break;
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j]!;
      if (shortWithValue.includes(letter)) {
        const rest = arg.slice(j + 1);
        options.push({ name: `-${letter}`, value: rest !== "" ? rest : args[++i]?.value });
        break;
      }
      options.push({ name: `-${letter}`, value: undefined });
    }
    i++;
  }
  return { index: i, options };
}

const isAssignment = (field: Field) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(field.value);

/** Result of peeling one launcher off a command: the command it launches. */
interface Launch {
  inner: Field[];
  cwd?: string | undefined;
  dynamic?: boolean;
  /** The launcher runs `inner` in a new process, so `cd` there doesn't affect this shell. */
  spawns: boolean;
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
    const splitString = options.filter((o) => o.name === "-S" || o.name === "--split-string").pop()?.value;
    if (splitString !== undefined) {
      const words = splitString.split(/\s+/).filter(Boolean);
      inner = [...words.map((value) => ({ value, dynamic: false, quoted: false })), ...inner];
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
    const { index } = scanOptions(args, "ILnPsdEa", [
      "--arg-file",
      "--delimiter",
      "--max-args",
      "--max-procs",
      "--max-chars",
      "--process-slot-var",
    ]);
    const inner = args.slice(index);
    return {
      inner: inner.length > 0 ? inner : [{ value: "echo", dynamic: false, quoted: false }],
      dynamic: true,
      spawns: true,
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
        ? invocation.script?.dynamic
          ? undefined
          : invocation.script?.value
        : invocation.mode === "stdin"
          ? (call.stdinText ?? call.pipedText)
          : undefined;
    // A script file, an unknown stdin (`curl ... | sh`) or a dynamic `-c` string can't be seen into.
    if (script === undefined) return emit(fields, scope, ctx, call);
    runSource(script, { vars: new Map(), cwd: call.cwd }, deeper(ctx, { via }));
    return;
  }

  if (program === "eval") {
    if (args.some((f) => f.dynamic)) return emit(fields, scope, ctx, call);
    runSource(args.map((f) => f.value).join(" "), call.inShell ? scope : copyScope(scope), deeper(ctx, { via }));
    return;
  }

  if (program === "find") {
    emit(fields, scope, ctx, call);
    for (let i = 0; i < args.length; i++) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i]!.value)) continue;
      const end = args.findIndex((f, j) => j > i && (f.value === ";" || f.value === "+"));
      const inner = args.slice(i + 1, end === -1 ? undefined : end);
      unwrap(inner, scope, ctx, { ...call, via, dynamic: true, inShell: false, stdinText: undefined, pipedText: undefined });
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
  if (launch === undefined || launch.inner.length === 0) return emit(fields, scope, ctx, call);
  unwrap(launch.inner, scope, ctx, {
    ...call,
    via,
    cwd: launch.cwd ?? call.cwd,
    dynamic: call.dynamic || launch.dynamic === true,
    inShell: call.inShell && !launch.spawns,
  });
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
