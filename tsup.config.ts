import { dirname, join } from "node:path";
import { defineConfig, type Options } from "tsup";
import { collectFixtureFiles } from "./src/testing/fixture-files";

type Plugin = NonNullable<Options["esbuildPlugins"]>[number];

/**
 * Inline the shipped fixtures (`src/hooks/<hook>/fixtures/*.json`) for
 * `hardhooks test`: replace `src/testing/shipped.ts`, which reads them from
 * disk when run from source, with the same files as data. The bundle then
 * needs nothing beside it at run time (npm install, the Claude Code plugin,
 * a copied bundle), and its fixtures always match its Hooks. They are read
 * lazily (`JSON.parse` of one string), so `hardhooks run` pays nothing.
 */
const inlineShippedFixtures: Plugin = {
  name: "inline-shipped-fixtures",
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]testing[\\/]shipped\.ts$/ }, (args) => {
      const hooksDir = join(dirname(args.path), "..", "hooks");
      const files = collectFixtureFiles(hooksDir);
      return {
        contents: `export function shippedFixtureFiles() { return JSON.parse(${JSON.stringify(JSON.stringify(files))}); }\n`,
        loader: "js",
        watchFiles: files.map((f) => join(hooksDir, f.hook, "fixtures", f.file)),
      };
    });
  },
};

// One self-contained ESM file run with `node` (ADR-0001). `unbash` is bundled
// in, so the published package has no runtime dependencies to install.
export default defineConfig({
  entry: { hardhooks: "src/cli.ts" },
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  platform: "node",
  // Old enough syntax that Node <20 can still parse the bundle and reach the
  // version check, which then prints a clear error.
  target: "node16",
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  sourcemap: false,
  minify: false,
  clean: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  esbuildPlugins: [inlineShippedFixtures],
});
