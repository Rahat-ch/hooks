// A fake program for e2e tests: `node fake-program.cjs <spec.json> [args...]`.
// Records its call (argv, stdin, cwd, env) as one JSON line, then answers
// as the spec says: the first rule whose `match` matches the arguments
// joined with spaces, else the defaults. Written by ./fake-program.ts.
"use strict";
const fs = require("node:fs");

const [specPath, ...argv] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

let stdin = "";
try {
  stdin = fs.readFileSync(0, "utf8");
} catch {
  // No stdin (closed, or the null device on some platforms).
}

fs.appendFileSync(spec.record, JSON.stringify({ argv, stdin, cwd: process.cwd(), env: process.env, time: Date.now() }) + "\n");

const joined = argv.join(" ");
const rule = (spec.rules || []).find((r) => new RegExp(r.match, r.flags).test(joined));
const response = rule || spec.response;

setTimeout(() => {
  if (response.stdout) process.stdout.write(response.stdout);
  if (response.stderr) process.stderr.write(response.stderr);
  process.exitCode = response.exitCode || 0;
}, response.delayMs || 0);
