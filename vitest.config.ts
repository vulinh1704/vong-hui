import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // cashscript/vitest registers toFailRequireWith() etc. on the global expect.
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    // every circle spend is evaluated in the BCH VM (~800-byte covenant): give long scenarios time
    testTimeout: 60_000,
  },
});
