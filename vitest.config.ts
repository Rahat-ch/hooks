import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: ["test/smoke/**", "test/e2e/**"],
        },
      },
      {
        // Every test spawns the real bundled CLI (ADR-0006). globalSetup builds it once per run.
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          globalSetup: ["test/e2e/helpers/global-setup.ts"],
          // Tests are independent sandboxes and mostly wait on child processes.
          sequence: { concurrent: true },
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Spawns the built bundle; run `npm run build` first (or `npm run test:smoke`).
        test: {
          name: "smoke",
          include: ["test/smoke/**/*.test.ts"],
          testTimeout: 20_000,
        },
      },
    ],
  },
});
