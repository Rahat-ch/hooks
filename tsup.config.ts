import { defineConfig } from "tsup";

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
});
