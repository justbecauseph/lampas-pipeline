import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    // The suites in tools/lampasctl/test use `bun:test` and Bun runtime APIs, so they run with
    // `bun test` (`vp run test`). Keep them out of the built-in Vitest runner (`vp test`).
    exclude: ["**/node_modules/**", "tools/lampasctl/test/**"],
    passWithNoTests: true,
  },
});
