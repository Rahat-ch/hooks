/**
 * Refuse to run on Node <20 with a clear message. Imported first by cli.ts so
 * it runs before anything else in the bundle; the bundle targets old syntax
 * so older Node can still parse it far enough to get here.
 */
const MINIMUM_MAJOR = 20;

const version = process.versions.node;
if (Number(version.split(".")[0]) < MINIMUM_MAJOR) {
  process.stderr.write(
    `hardhooks requires Node.js ${MINIMUM_MAJOR} or later, but ${process.execPath} is Node.js ${version}. ` +
      `hardhooks Hooks are not running. Install Node.js ${MINIMUM_MAJOR}+ (https://nodejs.org) and make sure it is first on PATH.\n`,
  );
  // On PreToolUse, exit 2 is a blocking error, so Guards still fail closed
  // (ADR-0004). Elsewhere exit 1: a visible, non-blocking error (exit 2 on
  // Stop would trap the Host in a loop).
  const [command, event] = process.argv.slice(2);
  process.exit(command === "run" && event === "PreToolUse" ? 2 : 1);
}

export {};
