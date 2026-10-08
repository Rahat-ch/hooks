/**
 * `hardhooks trust` (ADR-0005): show what trusting the project
 * would let hardhooks run, ask, and record it; or revoke it, or report it.
 * The CLI command only parses flags and calls `trust`.
 */
import { hookSettings, type ResolvedConfig } from "../config";
import { formatConfigError, loadConfig } from "../config/load";
import type { Environment } from "../environment";
import type { Hook } from "../hooks/hook";
import { hooks } from "../hooks/registry";
import { grantTrust, revokeTrust, trustStatus, type TrustInput, type TrustStatus } from "./index";

export type TrustAction = "grant" | "revoke" | "status";
/** `prompt` shows what will be trusted and asks; `yes` (`--yes`) trusts without asking. */
export type TrustMode = "prompt" | "yes";

export interface TrustRequest {
  env: Environment;
  action: TrustAction;
  mode: TrustMode;
  /** Whether stdin is a terminal a person can answer the prompt on. */
  interactive: boolean;
  /** Ask the user a yes/no question; resolves true for yes. */
  confirm(question: string): Promise<boolean>;
  stdout(text: string): void;
  stderr(text: string): void;
}

/**
 * Environment variables a Host sets in the shell its agent runs commands in.
 * Granting with `--yes` there is refused, so an agent (perhaps steered by the
 * very repo it is working in) can't trust the project for the user.
 */
const agentShellVariables = ["CLAUDECODE"];

/** `hardhooks trust [--yes | --revoke | --status]`. Resolves to the exit code. */
export async function trust(request: TrustRequest): Promise<number> {
  const { env, stdout } = request;
  if (request.action === "revoke") {
    const root = trustStatus(env, env.cwd).root;
    stdout(revokeTrust(env, env.cwd) ? `No longer trusting ${root}.\n` : `${root} was not trusted.\n`);
    return 0;
  }

  const loaded = loadConfig(env, hooks);
  if (!loaded.ok) {
    for (const error of loaded.errors) request.stderr(`hardhooks: invalid config: ${formatConfigError(error)}\n`);
    request.stderr("hardhooks: fix the config, then re-run hardhooks trust.\n");
    return 1;
  }
  const status = trustStatus(env, env.cwd);
  const commands = projectCommands(env.cwd, hooks, loaded.config, status.repoConfig);

  if (request.action === "status") {
    stdout(`${describeState(status)}\n`);
    stdout(describeCommands(commands));
    return status.state === "trusted" ? 0 : 1;
  }

  if (status.state === "trusted") {
    stdout(`${status.root} is already trusted.\n`);
    return 0;
  }
  if (status.state === "changed") stdout(`${describeState(status)}\n\n`);
  stdout(describeCommands(commands));
  if (commands.length > 0) {
    stdout("They run with your permissions, and so does the project code they run (scripts, tests, formatter plugins).\n");
  }
  stdout("\nTrust covers these files; if any of them changes, hardhooks stops running the commands until you trust it again:\n");
  for (const line of describeInputs(status.inputs)) stdout(`  ${line}\n`);

  if (request.mode === "yes") {
    const variable = agentShellVariables.find((name) => env.env[name]);
    if (variable !== undefined) {
      request.stderr(
        `hardhooks: refusing --yes inside an agent's shell (${variable} is set): run \`hardhooks trust\` yourself in a terminal.\n`,
      );
      return 1;
    }
  } else {
    if (!request.interactive) {
      request.stderr("hardhooks: trusting needs a terminal to confirm in; run it in one, or pass --yes.\n");
      return 1;
    }
    if (!(await request.confirm(`Trust ${status.root}?`))) {
      stdout("Not trusted.\n");
      return 1;
    }
  }
  try {
    grantTrust(env, env.cwd);
  } catch (error) {
    request.stderr(`hardhooks: could not record trust: ${(error as Error).message}\n`);
    return 1;
  }
  stdout(`Trusted ${status.root}. Undo with \`hardhooks trust --revoke\`.\n`);
  return 0;
}

/**
 * For `hardhooks init` and `hardhooks test`: lines telling the user that the
 * project's commands won't run until they trust it, or none when it is
 * trusted or has no commands.
 */
export function untrustedNote(env: Environment, hooks: readonly Hook<any>[], config: ResolvedConfig): string[] {
  const status = trustStatus(env, env.cwd);
  if (status.state === "trusted") return [];
  const commands = projectCommands(env.cwd, hooks, config, status.repoConfig);
  if (commands.length === 0) return [];
  const why = status.state === "changed" ? `changed since you trusted it (${status.changed.join(", ")})` : "is not trusted";
  return [
    `Note: this project ${why}, so hardhooks won't run its commands:`,
    ...commands.map((command) => `  ${command}`),
    "To review and allow them, run `hardhooks trust`.",
  ];
}

/** "Hook: description" for every command the project would have hardhooks run, by enabled Hook. */
function projectCommands(cwd: string, hooks: readonly Hook<any>[], config: ResolvedConfig, repoConfig: string | undefined): string[] {
  const lines: string[] = [];
  for (const hook of [...hooks].sort((a, b) => a.name.localeCompare(b.name))) {
    const settings = hookSettings(hook, config);
    if (!settings.enabled) continue;
    for (const option of config.repoCommands?.[hook.name] ?? []) {
      const value = (settings.options as Record<string, unknown>)[option];
      lines.push(`${hook.name}: ${option} from ${repoConfig ?? ".hardhooks.json"}: ${formatCommand(value)}`);
    }
    for (const line of hook.projectCommands?.(cwd, settings.options) ?? []) lines.push(`${hook.name}: ${line}`);
  }
  return lines;
}

/** A command option's value as the user would type it: a command line, an argv, or a list of argvs. */
function formatCommand(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return JSON.stringify(value);
  if (value.every((part) => typeof part === "string")) return value.join(" ");
  return value.map(formatCommand).join("; ");
}

function describeCommands(commands: readonly string[]): string {
  if (commands.length === 0) return "No enabled Hook would run a command from this project right now.\n";
  return ["Trusting lets hardhooks run these commands from this project:", ...commands.map((c) => `  ${c}`)].join("\n") + "\n";
}

function describeState(status: TrustStatus): string {
  if (status.state === "trusted") return `${status.root} is trusted.`;
  if (status.state === "changed") return `${status.root} changed since you trusted it: ${status.changed.join(", ")}.`;
  return `${status.root} is not trusted.`;
}

function describeInputs(inputs: readonly TrustInput[]): string[] {
  const present = inputs.filter((input) => input.exists);
  if (present.length === 0) return ["(none of them exist yet)"];
  return present.map((input) => {
    if (input.coverage === "package.json fields") return `${input.file} (scripts, prettier)`;
    if (input.coverage === "presence") return `${input.file} (whether it exists)`;
    return input.file;
  });
}
