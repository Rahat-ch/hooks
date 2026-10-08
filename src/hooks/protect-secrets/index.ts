/**
 * protect-secrets (Guard, fails closed): keeps the Host from reading or
 * writing secrets (`.env` files, private keys, cloud credentials, ...).
 */
import { block } from "../../decision";
import * as s from "../../config/schema";
import { defaultIgnoreFiles, resolvePath, secretsMatcher, type SecretMatch } from "../../secrets";
import { analyzeShell } from "../../shell";
import { defineHook } from "../hook";
import { shellFinding } from "./shell";

export interface ProtectSecretsOptions {
  protect: string[];
  allow: string[];
  ignoreFiles: string[];
}

function describe(match: SecretMatch): string {
  return match.source === "built-in" ? "built-in" : match.source === "protect" ? "your `protect` option" : match.source;
}

function reasonFor(path: string, match: SecretMatch): string {
  return (
    `\`${path}\` matches the protected pattern \`${match.pattern}\` (${describe(match)}), so it may not be read or written. ` +
    "Secrets must not enter the conversation or be overwritten. If this file holds no secrets, " +
    "ask the user to add it to `hooks.protect-secrets.allow` in .hardhooks.json."
  );
}

const defaults: ProtectSecretsOptions = { protect: [], allow: [], ignoreFiles: [...defaultIgnoreFiles] };

export const protectSecrets = defineHook<ProtectSecretsOptions>({
  name: "protect-secrets",
  description: "Blocks reading and writing secrets (.env files, private keys, cloud credentials) via file tools and shell.",
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
    const matcher = secretsMatcher({ projectDir: event.cwd, home: env.home, ...options });
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
      return finding ? block(reasonFor(finding.operand, finding.match)) : undefined;
    }
    if (tool.filePath !== undefined) {
      const match = matcher.match(tool.filePath, event.cwd);
      if (match) return block(reasonFor(tool.filePath, match));
    }
    // A content search's file filter (`glob` on Claude Code's Grep) selecting secrets reads them too.
    const glob = tool.kind === "search" ? tool.input.glob : undefined;
    if (typeof glob === "string") {
      const match = matcher.matchGlob(glob, tool.filePath === undefined ? event.cwd : resolvePath(tool.filePath, event.cwd, env.home));
      if (match) return block(reasonFor(glob, match));
    }
    return undefined;
  },
});
