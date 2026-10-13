export default {
  testRunner: "command",
  commandRunner: { command: "npm test" },
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  reporters: ["clear-text", "progress", "html", "json"],
  coverageAnalysis: "off",
  // Keep mutation runs bounded while retaining the auth, scope, confirmation,
  // configuration, allow-list, and redaction enforcement paths.
  mutate: [
    "src/config.ts",
    "src/confirmation.ts",
    "src/errors.ts",
    "src/identity.ts",
    "src/policy.ts",
    "src/scope.ts",
  ],
  thresholds: { high: 90, low: 75, break: 0 },
  concurrency: 4,
};
