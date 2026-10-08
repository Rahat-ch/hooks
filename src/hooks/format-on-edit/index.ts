/**
 * format-on-edit (fails open): after the Host edits or writes a file, format
 * just that file with the project's own formatter. Never installs anything,
 * never blocks, adds no context; no formatter, a formatter error, a timeout
 * or a missing binary all leave the file as it is, silently (ADR-0004).
 *
 * Trust (ADR-0005): a detected formatter runs only in a trusted project
 * (`hardhooks trust`), even one from PATH. The project's config chose it, and
 * that config can itself run code: prettier and dprint load plugins named in
 * it, and `prettier.config.js` is a script. A `command` from the repo config
 * needs trust too; one from the user config doesn't. Untrusted, the file is
 * left as it is and the user is told once per session.
 *
 * Detection: walk up from the file's directory to the repository root (the
 * nearest directory with `.git`), and in each directory check, in order, the
 * formatters that handle the file's extension: prettier, biome, ruff, black,
 * gofmt, rustfmt, dprint. The first config found wins, so the config nearest
 * the file decides. The formatter runs from that config's directory.
 *
 * Binaries: Node formatters come from the nearest `node_modules/<package>`
 * (run as `node <package bin script>`), Python ones from the nearest `.venv`
 * or `venv`, falling back to PATH; gofmt and rustfmt always come from PATH.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import * as s from "../../config/schema";
import { defineHook } from "../hook";

/** A formatter invocation: program, arguments, and the directory to run it in. */
interface Invocation {
  command: string;
  args: string[];
  cwd: string;
  /** The detected formatter's name; undefined for the configured `command`. */
  detected?: string;
}

/** A program to run, possibly behind a prefix (e.g. `node <script>`). */
interface Program {
  command: string;
  prefix: string[];
}

interface Formatter {
  /** For the untrusted-project notice, e.g. "prettier". */
  name: string;
  /** File extensions (lower case, with the dot) it formats. */
  extensions: ReadonlySet<string>;
  /** The file in `dir` holding this formatter's project config, if any. */
  configuredIn(dir: string): string | undefined;
  /** How to format `file`, run from `configDir` (where its config was found). */
  invocation(file: string, where: Where, configDir: string): Omit<Invocation, "cwd">;
}

/** Where to look for project-local binaries. */
interface Where {
  /** The edited file's directory and its ancestors, nearest first. */
  dirs: readonly string[];
  platform: NodeJS.Platform;
}


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

const firstExisting = (dir: string, names: readonly string[]) => names.find((name) => existsSync(join(dir, name)));

/** "pyproject.toml" when `dir/pyproject.toml` has a `[tool.<name>]` table (or a subtable of it). */
function pyprojectTool(dir: string, name: string): string | undefined {
  const text = readText(join(dir, "pyproject.toml"));
  return text !== undefined && new RegExp(`^\\s*\\[tool\\.${name}[\\].]`, "m").test(text) ? "pyproject.toml" : undefined;
}

/** The file's directory and its ancestors, up to and including the nearest one with `.git` (or the filesystem root). */
function searchDirs(file: string): string[] {
  const dirs: string[] = [];
  let dir = dirname(file);
  for (;;) {
    dirs.push(dir);
    if (existsSync(join(dir, ".git"))) return dirs;
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
      if (existsSync(path)) return { command: path, prefix: [] };
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
    name: "prettier",
    extensions: exts(`${scriptExts} json json5 jsonc css scss less html htm vue md markdown mdx yaml yml graphql gql hbs handlebars`),
    configuredIn: (dir) =>
      firstExisting(dir, prettierConfigs) ??
      (readJson(join(dir, "package.json"))?.prettier !== undefined ? "package.json" : undefined),
    invocation: (file, where) => run(nodeTool(where, "prettier", "prettier"), "--write", "--ignore-unknown", file),
  },
  {
    name: "biome",
    extensions: exts(`${scriptExts} json jsonc css graphql gql`),
    configuredIn: (dir) => firstExisting(dir, ["biome.json", "biome.jsonc"]),
    invocation: (file, where) => run(nodeTool(where, "@biomejs/biome", "biome"), "format", "--write", file),
  },
  {
    name: "ruff",
    extensions: exts("py pyi"),
    configuredIn: (dir) => firstExisting(dir, ["ruff.toml", ".ruff.toml"]) ?? pyprojectTool(dir, "ruff"),
    invocation: (file, where) => run(pythonTool(where, "ruff"), "format", "--force-exclude", file),
  },
  {
    name: "black",
    extensions: exts("py pyi"),
    configuredIn: (dir) => pyprojectTool(dir, "black"),
    invocation: (file, where) => run(pythonTool(where, "black"), "--quiet", file),
  },
  {
    name: "gofmt",
    extensions: exts("go"),
    configuredIn: (dir) => firstExisting(dir, ["go.mod"]),
    invocation: (file) => ({ command: "gofmt", args: ["-w", file] }),
  },
  {
    name: "rustfmt",
    extensions: exts("rs"),
    configuredIn: (dir) => firstExisting(dir, ["rustfmt.toml", ".rustfmt.toml", "Cargo.toml"]),
    invocation: (file, where) => {
      const edition = rustEdition(where);
      return { command: "rustfmt", args: [...(edition ? ["--edition", edition] : []), file] };
    },
  },
  {
    name: "dprint",
    // dprint decides by its plugins; these are the file types its common plugins cover.
    extensions: exts(`${scriptExts} json jsonc json5 md markdown mdx toml css scss less sass html htm vue svelte astro yaml yml graphql gql`),
    configuredIn: (dir) => firstExisting(dir, ["dprint.json", ".dprint.json", "dprint.jsonc", ".dprint.jsonc"]),
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
    const formatter = candidates.find((candidate) => candidate.configuredIn(dir) !== undefined);
    if (formatter !== undefined) {
      return { ...formatter.invocation(file, { dirs, platform }, dir), cwd: dir, detected: formatter.name };
    }
  }
  return undefined;
}

/** The user's own `command`, with `{file}` replaced by (or else followed by) the edited file. */
function configured([command, ...args]: readonly string[], file: string, cwd: string): Invocation {
  const withFile = args.includes("{file}") ? args.map((arg) => (arg === "{file}" ? file : arg)) : [...args, file];
  return { command: command!, args: withFile, cwd };
}

export const formatOnEdit = defineHook({
  name: "format-on-edit",
  description: "Formats each file the Host edits or writes with the project's own formatter.",
  events: ["PostToolUse"],
  tools: ["edit", "write"],
  failMode: "open",
  optionsSchema: s.object({
    command: s.optional(
      s.array(s.string(), {
        description:
          'Format every edited file with this command instead of detecting a formatter, e.g. ["black", "--quiet", "{file}"]. ' +
          "Run without a shell from the project directory; `{file}` is replaced by the edited file's absolute path, which is appended when absent. " +
          "On Windows name an executable (.exe), not a .cmd/.bat shim. " +
          "From a repo config it runs only once the project is trusted (`hardhooks trust`), as does every detected formatter.",
      }),
    ),
    timeoutMs: s.number({
      integer: true,
      minimum: 1,
      description: "Give up on the formatter after this many milliseconds, leaving the file as it is.",
    }),
  }),
  commandOptions: ["command"],
  projectCommands(cwd, options) {
    if (options.command !== undefined && options.command.length > 0) return [];
    return formatters.flatMap((formatter) => {
      const config = formatter.configuredIn(cwd);
      return config === undefined ? [] : [`${formatter.name} (configured by ${config})`];
    });
  },
  defaults: {
    standard: { enabled: true, options: { timeoutMs: 10_000 } },
    strict: { enabled: true, options: { timeoutMs: 10_000 } },
  },
  async run(event, options, env, trust) {
    const filePath = event.tool?.filePath;
    if (filePath === undefined) return undefined;
    const file = resolve(event.cwd, filePath);
    if (!existsSync(file)) return undefined;
    const invocation =
      options.command !== undefined && options.command.length > 0
        ? configured(options.command, file, event.cwd)
        : detect(file, env.platform);
    if (invocation === undefined) return undefined;
    // Every detected formatter needs trust, even one on PATH: the project's config chose it and can load plugins.
    if (invocation.detected !== undefined && !trust.mayRun(invocation.detected)) return undefined;
    // Whatever happens (non-zero exit, timeout, not installed), the file is simply left as it is.
    await env.processRunner.run(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      timeoutMs: options.timeoutMs,
    });
    return undefined;
  },
});
