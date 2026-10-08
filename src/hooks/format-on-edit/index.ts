/**
 * format-on-edit (fails open): after the Host edits or writes a file, format
 * just that file with the project's own formatter. Never installs anything,
 * never blocks, adds no context; any failure means the file is left as is.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Environment } from "../../environment";
import { defineHook } from "../hook";

/** A formatter invocation: program, arguments, and the directory to run it in. */
interface Invocation {
  command: string;
  args: string[];
  cwd: string;
}

/** A program to run, possibly behind a prefix (e.g. `node <script>`). */
interface Program {
  command: string;
  prefix: string[];
}

interface Formatter {
  /** File extensions (lower case, with the dot) it formats. */
  extensions: ReadonlySet<string>;
  /** Whether `dir` holds this formatter's project config. */
  configuredIn(dir: string): boolean;
  /** How to format `file`, run from `configDir` (where its config was found). */
  invocation(file: string, where: Where, configDir: string): Omit<Invocation, "cwd">;
}

/** Where to look for project-local binaries. */
interface Where {
  /** The edited file's directory and its ancestors, nearest first. */
  dirs: readonly string[];
  platform: NodeJS.Platform;
}

const exists = (path: string) => existsSync(path);

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const anyExists = (dir: string, names: readonly string[]) => names.some((name) => exists(join(dir, name)));

/** Whether `dir/pyproject.toml` has a `[tool.<name>]` table (or a subtable of it). */
function pyprojectHasTool(dir: string, name: string): boolean {
  const text = readText(join(dir, "pyproject.toml"));
  return text !== undefined && new RegExp(`^\\s*\\[tool\\.${name}[\\].]`, "m").test(text);
}

/** The file's directory and its ancestors, up to and including the nearest one with `.git` (or the filesystem root). */
function searchDirs(file: string): string[] {
  const dirs: string[] = [];
  let dir = dirname(file);
  for (;;) {
    dirs.push(dir);
    if (exists(join(dir, ".git"))) return dirs;
    const parent = dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
}

/**
 * A Node formatter from the nearest `node_modules/<pkg>`, run as `node <its bin script>`,
 * else `bin` from PATH. Going through the package's `bin` rather than
 * `node_modules/.bin` avoids Windows `.cmd` shims, which cannot be spawned
 * without a shell.
 */
function nodeTool({ dirs }: Where, pkg: string, bin: string): Program {
  for (const dir of dirs) {
    const pkgDir = join(dir, "node_modules", pkg);
    const manifest = readJson(join(pkgDir, "package.json"));
    if (manifest === undefined) continue;
    const bins = manifest.bin;
    const script = typeof bins === "string" ? bins : (bins as Record<string, unknown> | undefined)?.[bin];
    if (typeof script === "string") return { command: "node", prefix: [join(pkgDir, script)] };
  }
  return { command: bin, prefix: [] };
}

/** A Python formatter from the nearest project virtualenv (`.venv` or `venv`), else from PATH. */
function pythonTool({ dirs, platform }: Where, bin: string): Program {
  const relative = platform === "win32" ? join("Scripts", `${bin}.exe`) : join("bin", bin);
  for (const dir of dirs) {
    for (const venv of [".venv", "venv"]) {
      const path = join(dir, venv, relative);
      if (exists(path)) return { command: path, prefix: [] };
    }
  }
  return { command: bin, prefix: [] };
}

/** The `edition` in the nearest Cargo.toml, which rustfmt (unlike cargo fmt) does not read itself. */
function rustEdition({ dirs }: Where): string | undefined {
  for (const dir of dirs) {
    const manifest = readText(join(dir, "Cargo.toml"));
    if (manifest !== undefined) return /^\s*edition\s*=\s*["'](\d{4})["']/m.exec(manifest)?.[1];
  }
  return undefined;
}

const exts = (list: string) => new Set(list.split(" ").map((ext) => `.${ext}`));
const scriptExts = "js jsx mjs cjs ts tsx mts cts";

const prettierConfigs = [
  ".prettierrc",
  ...["json", "yaml", "yml", "json5", "js", "cjs", "mjs", "ts", "cts", "mts", "toml"].map((ext) => `.prettierrc.${ext}`),
  ...["js", "cjs", "mjs", "ts", "cts", "mts"].map((ext) => `prettier.config.${ext}`),
];

const run = (program: Program, ...args: string[]) => ({ command: program.command, args: [...program.prefix, ...args] });

/**
 * Checked in this order within each directory, nearest directory first, so the
 * config nearest the file wins and ties go to the earlier formatter.
 */
const formatters: readonly Formatter[] = [
  {
    extensions: exts(`${scriptExts} json json5 jsonc css scss less html htm vue md markdown mdx yaml yml graphql gql hbs handlebars`),
    configuredIn: (dir) => anyExists(dir, prettierConfigs) || readJson(join(dir, "package.json"))?.prettier !== undefined,
    invocation: (file, where) => run(nodeTool(where, "prettier", "prettier"), "--write", "--ignore-unknown", file),
  },
  {
    extensions: exts(`${scriptExts} json jsonc css graphql gql`),
    configuredIn: (dir) => anyExists(dir, ["biome.json", "biome.jsonc"]),
    invocation: (file, where) => run(nodeTool(where, "@biomejs/biome", "biome"), "format", "--write", file),
  },
  {
    extensions: exts("py pyi"),
    configuredIn: (dir) => anyExists(dir, ["ruff.toml", ".ruff.toml"]) || pyprojectHasTool(dir, "ruff"),
    invocation: (file, where) => run(pythonTool(where, "ruff"), "format", "--force-exclude", file),
  },
  {
    extensions: exts("py pyi"),
    configuredIn: (dir) => pyprojectHasTool(dir, "black"),
    invocation: (file, where) => run(pythonTool(where, "black"), "--quiet", file),
  },
  {
    extensions: exts("go"),
    configuredIn: (dir) => anyExists(dir, ["go.mod"]),
    invocation: (file) => ({ command: "gofmt", args: ["-w", file] }),
  },
  {
    extensions: exts("rs"),
    configuredIn: (dir) => anyExists(dir, ["rustfmt.toml", ".rustfmt.toml", "Cargo.toml"]),
    invocation: (file, where) => {
      const edition = rustEdition(where);
      return { command: "rustfmt", args: [...(edition ? ["--edition", edition] : []), file] };
    },
  },
  {
    // dprint decides by its plugins; these are the file types its common plugins cover.
    extensions: exts(`${scriptExts} json jsonc json5 md markdown mdx toml css scss less sass html htm vue svelte astro yaml yml graphql gql`),
    configuredIn: (dir) => anyExists(dir, ["dprint.json", ".dprint.json", "dprint.jsonc", ".dprint.jsonc"]),
    // dprint takes file patterns, so pass a forward-slash path relative to the config directory.
    invocation: (file, where, configDir) =>
      run(nodeTool(where, "dprint", "dprint"), "fmt", relative(configDir, file).split(sep).join("/")),
  },
];

function detect(file: string, platform: NodeJS.Platform): Invocation | undefined {
  const ext = extname(file).toLowerCase();
  const candidates = formatters.filter((formatter) => formatter.extensions.has(ext));
  if (candidates.length === 0) return undefined;
  const dirs = searchDirs(file);
  for (const dir of dirs) {
    const formatter = candidates.find((candidate) => candidate.configuredIn(dir));
    if (formatter !== undefined) return { ...formatter.invocation(file, { dirs, platform }, dir), cwd: dir };
  }
  return undefined;
}

export const formatOnEdit = defineHook({
  name: "format-on-edit",
  description: "Formats each file the Host edits or writes with the project's own formatter.",
  events: ["PostToolUse"],
  tools: ["edit", "write"],
  failMode: "open",
  defaults: {
    standard: { enabled: true, options: {} },
    strict: { enabled: true, options: {} },
  },
  async run(event, _options, env: Environment) {
    const filePath = event.tool?.filePath;
    if (filePath === undefined) return undefined;
    const file = resolve(event.cwd, filePath);
    if (!exists(file)) return undefined;
    const invocation = detect(file, env.platform);
    if (invocation === undefined) return undefined;
    await env.processRunner.run(invocation.command, invocation.args, { cwd: invocation.cwd, timeoutMs: 10_000 });
    return undefined;
  },
});
