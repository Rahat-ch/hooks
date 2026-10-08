/**
 * check's state under `<stateDir>/check/`:
 *
 *   blocks/<sha256(session id, Event)>.json  { "count": n }  consecutive Stop blocks this session
 *   passes/<sha256(project dir, command)>.json  { "fingerprint": "..." }  working tree at the last pass
 *
 * State is best-effort: unreadable state reads as none, and a failed write is
 * ignored, so a broken state dir never changes whether a failing check blocks.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const key = (...parts: readonly string[]) => createHash("sha256").update(parts.join("\0")).digest("hex");

function read(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function write(path: string, value: object): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  } catch {
    // Best-effort.
  }
}

function remove(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort.
  }
}

export class CheckState {
  constructor(private readonly dir: string) {}

  private blocksFile(session: string, event: string): string {
    return join(this.dir, "blocks", `${key(session, event)}.json`);
  }

  private passFile(cwd: string, command: string): string {
    return join(this.dir, "passes", `${key(cwd, command)}.json`);
  }

  consecutiveBlocks(session: string, event: string): number {
    const count = read(this.blocksFile(session, event))?.count;
    return typeof count === "number" ? count : 0;
  }

  setConsecutiveBlocks(session: string, event: string, count: number): void {
    if (count === 0) remove(this.blocksFile(session, event));
    else write(this.blocksFile(session, event), { count });
  }

  lastPass(cwd: string, command: string): string | undefined {
    const fingerprint = read(this.passFile(cwd, command))?.fingerprint;
    return typeof fingerprint === "string" ? fingerprint : undefined;
  }

  recordPass(cwd: string, command: string, fingerprint: string | undefined): void {
    if (fingerprint === undefined) remove(this.passFile(cwd, command));
    else write(this.passFile(cwd, command), { fingerprint });
  }
}
