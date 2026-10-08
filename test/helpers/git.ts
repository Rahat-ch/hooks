import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real git in a temp dir, isolated from the developer's own git config (no
 * signing, hooks or templates), with a fixed identity.
 */
export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_AUTHOR_NAME: "hardhooks test",
      GIT_AUTHOR_EMAIL: "test@hardhooks.invalid",
      GIT_COMMITTER_NAME: "hardhooks test",
      GIT_COMMITTER_EMAIL: "test@hardhooks.invalid",
    },
  });
}

/** `git init` with `main` as the initial branch. */
export function initRepo(dir: string): void {
  git(dir, "init", "--quiet", "--initial-branch=main");
}

/** Write a file (creating parent dirs) relative to `dir`. */
export function writeProjectFile(dir: string, path: string, content = `${path}\n`): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Write `files` (default: one file named after the message), stage everything and commit. */
export function commit(dir: string, message: string, files: Record<string, string> = {}): void {
  const entries = Object.entries(files);
  if (entries.length === 0) {
    entries.push([`${message.replace(/\W+/g, "-").toLowerCase().slice(0, 40)}.txt`, `${message}\n`]);
  }
  for (const [path, content] of entries) writeProjectFile(dir, path, content);
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--message", message);
}
