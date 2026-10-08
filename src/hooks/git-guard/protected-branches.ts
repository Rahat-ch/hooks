/**
 * Protected branches: which branch a commit or push in a command line would
 * land on, and whether that branch is protected. Asks real git (through the
 * injected process runner) for the current and default branch, and follows
 * `git switch`/`git checkout` earlier in the same command line.
 */
import type { Environment } from "../../environment";
import { parseOptions } from "../../shell";

export interface ProtectionOptions {
  /** Branches that commits and pushes may not target. */
  readonly protectedBranches?: readonly string[] | undefined;
  /** Also protect the repository's default branch, detected from `origin/HEAD`. */
  readonly protectDefaultBranch?: boolean | undefined;
}

/** A git subcommand with its arguments, and the directory git runs in. */
export interface GitInvocation {
  readonly subcommand: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

const GIT_TIMEOUT_MS = 5_000;

export const pushOptionsWithValue = ["-o", "--push-option", "--repo", "--receive-pack", "--exec"];

export function protectionEnabled(options: ProtectionOptions): boolean {
  return (options.protectedBranches?.length ?? 0) > 0 || options.protectDefaultBranch === true;
}

/** Read-only git queries, cached per directory for one Event. */
class Repo {
  private readonly cache = new Map<string, Promise<string | undefined>>();
  constructor(private readonly env: Environment) {}

  /** stdout of a successful git query; undefined when git fails or isn't installed. Throws on timeout. */
  private query(cwd: string, args: string[]): Promise<string | undefined> {
    const key = `${cwd}\0${args.join("\0")}`;
    let result = this.cache.get(key);
    if (result === undefined) {
      result = this.env.processRunner
        .run("git", args, {
          cwd,
          env: { ...this.env.env, GIT_OPTIONAL_LOCKS: "0" },
          timeoutMs: GIT_TIMEOUT_MS,
        })
        .then((r) => {
          if (r.timedOut) throw new Error(`\`git ${args.join(" ")}\` timed out`);
          return r.exitCode === 0 ? r.stdout.trim() : undefined;
        });
      this.cache.set(key, result);
    }
    return result;
  }

  /** The checked-out branch; undefined when detached or not in a repo. */
  currentBranch(cwd: string) {
    return this.query(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  }

  async defaultBranch(cwd: string) {
    const head = await this.query(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    return head?.replace(/^origin\//, "");
  }

  async branchExists(cwd: string, name: string) {
    return (await this.query(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) !== undefined;
  }
}

/** The branch a push refspec's destination names, or "HEAD" for the current branch. */
function destination(refspec: string): string {
  const spec = refspec.replace(/^\+/, "");
  const colon = spec.indexOf(":");
  const dst = colon === -1 ? spec : spec.slice(colon + 1) || spec.slice(0, colon);
  return dst === "@" ? "HEAD" : dst.replace(/^refs\/heads\//, "");
}

/** Branches a push writes to: "HEAD" means the current branch, "*" means every branch. */
function pushTargets(args: readonly string[]): string[] {
  const parsed = parseOptions(args, { withValue: pushOptionsWithValue });
  const names = parsed.options.map((o) => o.name);
  if (names.some((n) => n === "--all" || n === "--branches" || n === "--mirror")) return ["*"];
  const refspecs = parsed.operands.slice(1);
  if (refspecs.length === 0) return names.includes("--tags") ? [] : ["HEAD"];
  return refspecs.map(destination);
}

/**
 * Commits and pushes in `invocations` (in command-line order) that would land
 * on a protected branch, as block reasons.
 */
export async function protectedBranchViolations(
  invocations: readonly GitInvocation[],
  options: ProtectionOptions,
  env: Environment,
): Promise<string[]> {
  const repo = new Repo(env);
  const listed = new Set(options.protectedBranches ?? []);
  const isProtected = async (branch: string, cwd: string) =>
    listed.has(branch) || (options.protectDefaultBranch === true && branch === (await repo.defaultBranch(cwd)));

  // Branch switches earlier in the command line, by directory. null: detached.
  const switched = new Map<string, string | null>();
  const branchAt = async (cwd: string) => {
    const known = switched.get(cwd);
    return known !== undefined ? (known ?? undefined) : repo.currentBranch(cwd);
  };

  const violations: string[] = [];
  for (const { subcommand, args, cwd } of invocations) {
    if (subcommand === "switch" || subcommand === "checkout") {
      const target = await switchTarget(subcommand, args, cwd, repo, listed);
      if (target !== undefined) switched.set(cwd, target);
      continue;
    }
    if (subcommand === "commit") {
      const branch = await branchAt(cwd);
      if (branch !== undefined && (await isProtected(branch, cwd))) {
        violations.push(
          `Committing directly to protected branch \`${branch}\` is blocked. ` +
            "Create a branch first (`git switch -c <name>`) and commit there.",
        );
      }
      continue;
    }
    if (subcommand === "push") {
      for (const target of pushTargets(args)) {
        if (target === "*") {
          violations.push("`git push --all`/`--mirror` would push to every protected branch too. Push branches by name.");
          continue;
        }
        const branch = target === "HEAD" ? await branchAt(cwd) : target;
        if (branch !== undefined && (await isProtected(branch, cwd))) {
          violations.push(
            `Pushing to protected branch \`${branch}\` is blocked. ` +
              "Push a feature branch and open a pull request instead.",
          );
        }
      }
    }
  }
  return violations;
}

/** The branch a `git switch`/`git checkout` moves to: a name, null for detached, undefined for no change or unknown. */
async function switchTarget(
  subcommand: string,
  args: readonly string[],
  cwd: string,
  repo: Repo,
  listed: ReadonlySet<string>,
): Promise<string | null | undefined> {
  const creates = ["-b", "-B", "-c", "-C", "--create", "--force-create", "--orphan"];
  const parsed = parseOptions(args, { withValue: creates });
  const created = parsed.options.filter((o) => creates.includes(o.name)).pop()?.value;
  if (created !== undefined) return created;
  if (parsed.options.some((o) => o.name === "--detach" || (subcommand === "switch" && o.name === "-d"))) return null;
  // `git checkout <tree-ish> -- <paths>` restores files and stays on the branch.
  if (args.includes("--") || parsed.operands.length !== 1) return undefined;
  const name = parsed.operands[0]!;
  if (name === "-") return undefined;
  // `git checkout <name>` may also restore a file; treat it as a branch switch when it is one.
  if (subcommand === "switch" || listed.has(name) || (await repo.branchExists(cwd, name))) return name;
  return undefined;
}
