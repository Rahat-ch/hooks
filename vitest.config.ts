import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: ["test/smoke/**"],
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
