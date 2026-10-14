export default {
  testRunner: "command",
  // A mutant is detected by its first failed assertion. Stop there so later
  // approval-round-trip tests do not spend their deadlines on the same fault.
  commandRunner: { command: "npm test -- --bail=1 --maxWorkers=2" },
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
  thresholds: { high: 90, low: 80, break: 80 },
  concurrency: 4,
};
