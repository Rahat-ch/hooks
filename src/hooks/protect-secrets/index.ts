/**
 * protect-secrets (Guard, fails closed): keeps the Host from reading or
 * writing secrets (`.env` files, private keys, cloud credentials, ...).
 *
 * - Which paths are secret is decided by `src/secrets/` (built-in patterns,
 *   `.claudeignore`/`.cursorignore`/`.aiignore` at the project root, and the
 *   `protect`/`allow` options); the block reason names the matched pattern.
 * - File tools (read, edit, write) are checked by their path; search tools by
 *   their path and their file glob (Grep's `glob`). A search not targeting a
 *   protected path is allowed.
 * - Shell commands are checked through `analyzeShell` (see `./shell.ts`):
 *   any executing command whose operand or redirection names a protected path
 *   is blocked, except metadata-only programs such as `ls` and `stat`.
 * - Guards hardhooks' own trust state too (see `./own-state.ts`): writes
 *   into the state dir or the user config are blocked, and `hardhooks trust`
 *   run by the agent asks the user.
 * - Blocks input it can't analyse, and blocks when an ignore file exists but
 *   can't be read (ADR-0004).
 */
import { block, type Decision } from "../../decision";
import * as s from "../../config/schema";
import { resolvePath } from "../../paths";
import { defaultIgnoreFiles, secretsMatcher, type SecretMatch } from "../../secrets";
import { projectRoot } from "../../project";
import { analyzeShell } from "../../shell";
import { defineHook } from "../hook";
import { ownStateShellFinding, ownStateWrite, type OwnStateFinding } from "./own-state";
import { shellFinding } from "./shell";

function decision(finding: OwnStateFinding): Decision {
  return finding.decision === "block" ? block(finding.reason) : { kind: "ask", reason: finding.reason };
}

export interface ProtectSecretsOptions {
  protect: string[];
  allow: string[];
  ignoreFiles: string[];
}

/** Where a matched pattern comes from, for a reason: "built-in", "your `protect` option" or an ignore file's name. */
export function describeSource(match: SecretMatch): string {
  return match.source === "built-in" ? "built-in" : match.source === "protect" ? "your `protect` option" : match.source;
}

function reasonFor(path: string, match: SecretMatch): string {
  return (
    `\`${path}\` matches the protected pattern \`${match.pattern}\` (${describeSource(match)}), so it may not be read or written. ` +
    "Secrets must not enter the conversation or be overwritten. If this file holds no secrets, " +
    "ask the user to add it to `hooks.protect-secrets.allow` in .hardhooks.json."
  );
}

const defaults: ProtectSecretsOptions = { protect: [], allow: [], ignoreFiles: [...defaultIgnoreFiles] };

export const protectSecrets = defineHook<ProtectSecretsOptions>({
  name: "protect-secrets",
  description:
    "Blocks reading and writing secrets (.env files, private keys, cloud credentials) via file tools and shell.",
  events: ["PreToolUse"],
  tools: ["read", "edit", "write", "search", "shell"],
  failMode: "closed",
  optionsSchema: s.object({
    protect: s.array(s.string(), {
      description: "Extra protected patterns, gitignore syntax, relative to the project root (`~/` for home).",
    }),
    allow: s.array(s.string(), {
      description: "Exceptions, gitignore syntax. A path matching one is never protected, even by a built-in pattern.",
    }),
    ignoreFiles: s.array(s.string(), {
      description: "Ignore files at the project root whose patterns are also protected. Set [] to ignore them.",
    }),
  }),
  defaults: {
    standard: { enabled: true, options: defaults },
    strict: { enabled: true, options: defaults },
  },
  run(event, options, env) {
    const tool = event.tool;
    if (tool === undefined) return undefined;
    // The project root is where ignore files live and relative patterns are anchored.
    const matcher = secretsMatcher({ projectDir: projectRoot(event.cwd), home: env.home, ...options });
    if (tool.kind === "shell") {
      if (tool.command === undefined) return undefined;
      const analysis = analyzeShell(tool.command, { cwd: event.cwd, home: env.home });
      if (!analysis.ok) {
        return block(
          `This command couldn't be analysed (${analysis.error}), so protect-secrets blocked it to be safe. ` +
            "Fix the syntax or split it into simpler commands.",
        );
      }
      const finding = shellFinding(analysis.commands, event.cwd, matcher);
      if (finding) return block(reasonFor(finding.operand, finding.match));
      const own = ownStateShellFinding(analysis.commands, event.cwd, env);
      return own && decision(own);
    }
    if (tool.filePath !== undefined) {
      const match = matcher.match(tool.filePath, event.cwd);
      if (match) return block(reasonFor(tool.filePath, match));
      const own = tool.kind === "edit" || tool.kind === "write" ? ownStateWrite(tool.filePath, event.cwd, env) : undefined;
      if (own) return decision(own);
    }
    // A content search's file filter (`glob` on Claude Code's Grep) selecting secrets reads them too.
    const glob = tool.kind === "search" ? tool.input.glob : undefined;
    if (typeof glob === "string") {
      const base = tool.filePath === undefined ? event.cwd : resolvePath(tool.filePath, event.cwd, env.home);
      const match = matcher.matchGlob(glob, base);
      if (match) return block(reasonFor(glob, match));
    }
    return undefined;
  },
});
