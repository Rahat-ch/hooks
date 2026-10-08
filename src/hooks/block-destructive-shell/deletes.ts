/**
 * Recursive deletes: which paths a command removes, and how bad that is.
 *
 * - The filesystem root, the home directory (or a directory containing it),
 *   the project itself or a directory containing it: block.
 * - Anything else outside the project: block, unless it is inside one of the
 *   configured `allowedPaths` (temp directories under `standard`).
 * - Inside the project: ask when git tracks something there (or when it holds
 *   untracked work git would not recover, or there is no git at all, or it is
 *   `.git`); allow when it is only gitignored output such as `node_modules`.
 *
 * Targets that can't be known statically (`rm -rf "$DIR/"`, `xargs rm -rf`)
 * are judged by their worst case: if an unset variable would turn the target
 * into `/`, `~` or the project, block; otherwise ask, so the user sees the
 * real command before it runs. Blocking every dynamic delete would stop
 * routine scripts; allowing them would let `rm -rf $UNSET/` through.
 */
import { basename, join } from "node:path";
import { parseOptions, type SimpleCommand } from "../../shell";
import { globBase, isFilesystemRoot, isWithin, resolveOperand, samePath, toPosixRelative, type PathContext } from "./paths";
import type { Repo } from "./repo";

export interface Finding {
  readonly decision: "block" | "ask";
  readonly reason: string;
}

/** One path a recursive delete removes. */
interface Target {
  /** As written on the command line. */
  readonly operand: string;
  /** The command's directory. */
  readonly cwd: string;
  /** The operand contains parts only known at run time. */
  readonly dynamic: boolean;
}

export interface DeleteContext extends PathContext {
  readonly home: string;
  /** The Host's working directory. */
  readonly cwd: string;
  /** Directories outside the project whose contents may be deleted, already expanded. */
  readonly allowedPaths: readonly string[];
  readonly repo: Repo;
  /** The Host's environment variables, which the command inherits. */
  readonly vars: Readonly<Record<string, string | undefined>>;
  /** The whole command line, to spot variables it assigns itself. */
  readonly source: string;
}

const isLong = (name: string, full: string) => name === full || (name.length >= 3 && full.startsWith(name));

/** Unresolved shell syntax left in an argument by the analysis. */
const DYNAMIC_PART = /\$\{[^}]*\}|\$\((?:[^()]|\([^()]*\))*\)|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!-]|`[^`]*`|<\([^)]*\)|\{\}/g;
const looksDynamic = (operand: string) => new RegExp(DYNAMIC_PART.source).test(operand);

/** `find` predicates that don't narrow what `-delete` removes. */
const FIND_UNFILTERED = new Set(["-delete", "-depth", "-d", "-xdev", "-mount", "-print", "-print0", "-ignore_readdir_race"]);
const FIND_WITH_VALUE = new Set(["-mindepth", "-maxdepth"]);

/** Paths an executing command recursively deletes; undefined when it deletes nothing recursively. */
function recursiveTargets(command: SimpleCommand, fallbackCwd: string): Target[] | undefined {
  const cwd = command.cwd ?? fallbackCwd;
  const args = command.argv.slice(1);

  if (command.program === "rm") {
    const parsed = parseOptions(args);
    const recursive = parsed.options.some((o) => o.name === "-r" || o.name === "-R" || isLong(o.name, "--recursive"));
    if (!recursive) return undefined;
    const targets = parsed.operands.map((operand) => ({
      operand,
      cwd,
      dynamic: command.dynamic && looksDynamic(operand),
    }));
    // `xargs rm -rf` / `find -exec rm -rf {} +`: the real operands arrive at run time.
    if (command.dynamic && !targets.some((t) => t.dynamic)) targets.push({ operand: "", cwd, dynamic: true });
    return targets;
  }

  if (command.program === "find" && args.includes("-delete")) {
    let i = 0;
    while (i < args.length && /^-([HLP]|O\d*|D)$/.test(args[i]!)) i += args[i] === "-D" ? 2 : 1;
    const starts: string[] = [];
    while (i < args.length && !/^[-(!]/.test(args[i]!)) starts.push(args[i++]!);
    const expression = args.slice(i);
    for (let j = 0; j < expression.length; j++) {
      const token = expression[j]!;
      if (FIND_WITH_VALUE.has(token)) j++;
      // A filter (`-name '*.pyc'`) limits what is deleted; leave those to the user.
      else if (!FIND_UNFILTERED.has(token)) return undefined;
    }
    return (starts.length > 0 ? starts : ["."]).map((operand) => ({
      operand,
      cwd,
      dynamic: command.dynamic && looksDynamic(operand),
    }));
  }
  return undefined;
}

type Location =
  | { readonly kind: "root" | "home" | "project" | "outside"; readonly path: string }
  | { readonly kind: "allowed"; readonly path: string }
  | { readonly kind: "git-dir"; readonly path: string }
  | { readonly kind: "inside"; readonly path: string; readonly glob: boolean };

/** Where a resolved (possibly globbed) path falls relative to root, home and project. */
function locate(path: string, project: string, ctx: DeleteContext): Location {
  const { base, glob } = globBase(path);
  if (isFilesystemRoot(base)) return { kind: "root", path: base };
  if (isWithin(ctx.home, base, ctx)) return { kind: "home", path: base };
  if (isWithin(project, base, ctx)) {
    // `rm -rf *` in the project root deletes its contents: judge them as inside.
    if (glob && samePath(base, project, ctx)) return { kind: "inside", path, glob };
    return { kind: "project", path: base };
  }
  if (isWithin(base, project, ctx)) {
    if (isWithin(base, join(project, ".git"), ctx)) return { kind: "git-dir", path: base };
    return { kind: "inside", path, glob };
  }
  const allowed = ctx.allowedPaths.some(
    (dir) => isWithin(base, dir, ctx) && !samePath(base, dir, ctx) && !isWithin(project, dir, ctx) && !isWithin(ctx.home, dir, ctx),
  );
  return { kind: allowed ? "allowed" : "outside", path: base };
}

const catastrophic = (location: Location) =>
  location.kind === "root" || location.kind === "home" || location.kind === "project";

function blockReason(location: Location, operand: string): string {
  switch (location.kind) {
    case "root":
      return `\`${operand}\` recursively deletes the filesystem root (${location.path}). Never delete the root directory.`;
    case "home":
      return (
        `\`${operand}\` recursively deletes ${location.path} (your home directory, or a directory containing it) or everything in it. ` +
        "Delete specific paths inside the project instead."
      );
    case "project":
      return (
        `\`${operand}\` recursively deletes the whole project (${location.path}), including its git history. ` +
        "Delete specific paths inside the project instead."
      );
    default:
      return (
        `\`${operand}\` recursively deletes ${location.path}, which is outside the project. ` +
        "Only delete files inside the project, or ask the user to do it."
      );
  }
}

/**
 * Fill in variables the command inherits from the Host (`$TMPDIR`), when every
 * unknown part is such a variable and the command line never assigns it.
 */
function inherited(operand: string, ctx: DeleteContext): string | undefined {
  let unresolved = false;
  const value = operand.replace(DYNAMIC_PART, (part) => {
    const name = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(part)?.[1];
    const value = name === undefined ? undefined : ctx.vars[name];
    if (name === undefined || !value || new RegExp(`\\b${name}=`).test(ctx.source)) unresolved = true;
    return value ?? "";
  });
  return unresolved ? undefined : value;
}

async function judge(target: Target, project: string, gitRoot: string | undefined, ctx: DeleteContext): Promise<Finding | undefined> {
  const known = target.dynamic && target.operand !== "" ? inherited(target.operand, ctx) : undefined;
  if (known !== undefined) return judge({ ...target, operand: known, dynamic: false }, project, gitRoot, ctx);
  if (target.dynamic) {
    // Worst case: every unknown part expands to nothing.
    const worst = target.operand.replace(DYNAMIC_PART, "");
    const shown = target.operand === "" ? "arguments supplied at run time" : `\`${target.operand}\``;
    if (worst !== "") {
      const location = locate(resolveOperand(target.cwd, worst, ctx), project, ctx);
      if (catastrophic(location)) {
        return {
          decision: "block",
          reason:
            `${shown} could expand to ${location.path} (if a variable is empty or unset), so this could recursively delete ` +
            `${location.kind === "root" ? "the filesystem root" : location.kind === "home" ? "your home directory" : "the whole project"}. ` +
            "Use a literal path, or guard the variable (`${DIR:?}`).",
        };
      }
    }
    return {
      decision: "ask",
      reason: `This recursively deletes ${shown}, which can't be known until the command runs. Confirm what it will delete.`,
    };
  }

  const location = locate(resolveOperand(target.cwd, target.operand, ctx), project, ctx);
  switch (location.kind) {
    case "allowed":
      return undefined;
    case "git-dir":
      return {
        decision: "ask",
        reason: `\`${target.operand}\` deletes the repository's git data (${location.path}), including any unpushed history. Confirm this is intended.`,
      };
    case "inside":
      return judgeInside(target, location.path, location.glob, gitRoot, ctx);
    default:
      return { decision: "block", reason: blockReason(location, target.operand) };
  }
}

async function judgeInside(
  target: Target,
  path: string,
  glob: boolean,
  gitRoot: string | undefined,
  ctx: DeleteContext,
): Promise<Finding | undefined> {
  if (gitRoot === undefined) {
    return {
      decision: "ask",
      reason: `\`${target.operand}\` recursively deletes files in a project without git, so they can't be recovered. Confirm this is intended.`,
    };
  }
  const contents = await ctx.repo.contents(gitRoot, toPosixRelative(gitRoot, path), glob);
  if (contents === "ignored") return undefined;
  return {
    decision: "ask",
    reason:
      contents === "tracked"
        ? `\`${target.operand}\` recursively deletes files tracked by git (${basename(path) || path}); uncommitted changes to them would be lost. Confirm this is intended.`
        : `\`${target.operand}\` recursively deletes files git has never seen (not committed and not gitignored), so they can't be recovered. Confirm this is intended.`,
  };
}

/** Findings for every recursive delete among the commands. */
export async function deleteFindings(commands: readonly SimpleCommand[], ctx: DeleteContext): Promise<Finding[]> {
  const targets = commands.flatMap((command) => (command.executes ? (recursiveTargets(command, ctx.cwd) ?? []) : []));
  if (targets.length === 0) return [];
  const gitRoot = await ctx.repo.topLevel(ctx.cwd);
  const project = gitRoot ?? ctx.cwd;
  const findings: Finding[] = [];
  for (const target of targets) {
    const finding = await judge(target, project, gitRoot, ctx);
    if (finding !== undefined) findings.push(finding);
  }
  return findings;
}
