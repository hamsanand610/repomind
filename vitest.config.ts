import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts so unit tests don't load the Cloudflare
// plugin. The integration project starts the real local runtime itself.
export default defineConfig({
  // Components are rendered to static HTML in unit tests (React's automatic JSX runtime, as in tsconfig.app.json).
  esbuild: { jsx: "automatic" },
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
