/**
 * block-destructive-shell (Guard, fails closed): stops shell commands that can
 * destroy the machine, the home directory or the project.
 *
 * - Blocks recursive deletes of `/`, `~` (or a directory containing it), the
 *   project or a directory containing it, and paths outside the project
 *   (except `allowedPaths`, temp directories under `standard`); `mkfs` and
 *   friends; writes to raw devices (`dd of=/dev/disk0`, `> /dev/sda`); and
 *   downloads run as code (`curl … | sh`).
 * - Asks before recursively deleting what git tracks (or untracked work, or
 *   anything in a project without git, or `.git`), and before deletes whose
 *   targets are only known at run time.
 * - Allows deleting gitignored output inside the project (`node_modules`).
 * - Only commands that execute count: a commit message, an `echo` string or a
 *   heredoc written to a file never triggers it.
 * - Blocks input it can't analyse (ADR-0004).
 */
import { block, type Decision } from "../../decision";
import * as s from "../../config/schema";
import type { Environment } from "../../environment";
import { analyzeShell } from "../../shell";
import { defineHook } from "../hook";
import { deleteFindings, type Finding } from "./deletes";
import { deviceFindings } from "./devices";
import { downloadFindings } from "./downloads";
import { Repo } from "./repo";

export interface BlockDestructiveShellOptions {
  allowedPaths: string[];
}

/**
 * Expand `~`, `$VAR` and `${VAR}` in a configured path. undefined when a
 * variable is unset, so a missing `$TMPDIR` drops the entry.
 */
function expandConfiguredPath(path: string, env: Environment): string | undefined {
  let missing = false;
  const expanded = path
    .replace(/^~(?=$|[\\/])/, env.home)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced?: string, bare?: string) => {
      const value = env.env[(braced ?? bare)!];
      if (value === undefined || value === "") missing = true;
      return value ?? "";
    });
  return missing ? undefined : expanded;
}

function decide(findings: readonly Finding[]): Decision | undefined {
  const strongest = findings.some((f) => f.decision === "block") ? "block" : findings.length > 0 ? "ask" : undefined;
  if (strongest === undefined) return undefined;
  const reason = [...new Set(findings.filter((f) => f.decision === strongest).map((f) => f.reason))].join("\n");
  return strongest === "block" ? block(reason) : { kind: "ask", reason };
}

export const blockDestructiveShell = defineHook<BlockDestructiveShellOptions>({
  name: "block-destructive-shell",
  description:
    "Blocks recursive deletes of root, home or outside the project, disk formatting, raw device writes and piping downloads into a shell.",
  events: ["PreToolUse"],
  tools: ["shell"],
  failMode: "closed",
  optionsSchema: s.object({
    allowedPaths: s.array(s.string(), {
      description:
        "Directories outside the project whose contents may be deleted recursively, e.g. scratch directories. " +
        "`~`, `$VAR` and `${VAR}` are expanded; an entry whose variable is unset is skipped. " +
        "A directory containing the project or the home directory is ignored.",
    }),
  }),
  defaults: {
    standard: { enabled: true, options: { allowedPaths: ["/tmp", "/var/tmp", "$TMPDIR", "$TEMP"] } },
    strict: { enabled: true, options: { allowedPaths: [] } },
  },
  async run(event, options, env) {
    const command = event.tool?.command;
    if (command === undefined) return undefined;
    const analysis = analyzeShell(command, { cwd: event.cwd, home: env.home });
    if (!analysis.ok) {
      return block(
        `This command couldn't be analysed (${analysis.error}), so block-destructive-shell blocked it to be safe. ` +
          "Fix the syntax or split it into simpler commands.",
      );
    }
    const findings = [
      ...analysis.commands.flatMap((c) => [...deviceFindings(c), ...downloadFindings(c)]),
      ...(await deleteFindings(analysis.commands, {
        platform: env.platform,
        home: env.home,
        cwd: event.cwd,
        allowedPaths: options.allowedPaths.flatMap((path) => expandConfiguredPath(path, env) ?? []),
        repo: new Repo(env),
        vars: env.env,
        source: command,
      })),
    ];
    return decide(findings);
  },
});
