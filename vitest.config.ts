import { defineConfig } from "vitest/config";

// Every test spawns the real bundled CLI (ADR-0006). globalSetup builds it once
// per run, for both projects.
export default defineConfig({
  test: {
    globalSetup: ["test/e2e/helpers/global-setup.ts"],
    // Tests are independent sandboxes and mostly wait on child processes, so
    // the tests of a file run concurrently (`describe.sequential` opts a block
    // out). vitest 4 honours this only here at the root, not in a project.
    sequence: { concurrent: true },
    projects: [
      {
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          exclude: ["test/e2e/timing/**"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Timed runs, after every e2e test has finished, so the suite's load doesn't skew them.
        test: {
          name: "timing",
          include: ["test/e2e/timing/**/*.test.ts"],
          sequence: { groupOrder: 1 },
          testTimeout: 30_000,
        },
      },
    ],
  },
});
