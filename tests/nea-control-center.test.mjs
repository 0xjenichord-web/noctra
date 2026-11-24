import test from "node:test";
import assert from "node:assert/strict";

import {
  createNimpiControlCenter
} from "../tools/nea/core/control-center.mjs";

function makeEngine(id, options = {}) {
  return Object.freeze({
    id,
    name: options.name ?? id,
    version: "1.0.0",
    domain: options.domain ?? "test",
    enabled: options.enabled ?? true,
    executionMode: "read-only",
    contractVersion: "1.0.0",
    inputContract: "input.v1",
    outputContract: "output.v1",
    capabilities: Object.freeze(options.capabilities ?? ["inspect"]),
    metadata: Object.freeze({
      dependencies: Object.freeze(options.dependencies ?? []),
      impact: Object.freeze({ paths: [] })
    })
  });
}

function makeHarness(overrides = {}) {
  const engines = [
    makeEngine("core-engine"),
    makeEngine("wallet-engine", {
      dependencies: ["core-engine"],
      capabilities: ["inspect", "wallet"]
    }),
    makeEngine("disabled-engine", { enabled: false })
  ];

  const byId = new Map(engines.map(engine => [engine.id, engine]));

  const calls = {
    orchestrator: 0,
    verification: 0,
    impact: 0,
    safety: 0
  };

  const registryOverrides = overrides.registry ?? {};

  const registry = {
    contractVersion: "1.0.0",
    list() {
      return registryOverrides.list
        ? registryOverrides.list()
        : [...engines];
    },
    get(id) {
      return registryOverrides.get
        ? registryOverrides.get(id)
        : byId.get(id) ?? null;
    },
    validateDependencies() {
      return registryOverrides.validateDependencies
        ? registryOverrides.validateDependencies()
        : {
            valid: true,
            errors: [],
            executionOrder: [
              "core-engine",
              "disabled-engine",
              "wallet-engine"
            ]
          };
    }
  };

  const orchestrator = {
    async execute() {
      calls.orchestrator++;
      return { status: "SUCCEEDED" };
    }
  };

  const verificationPipeline = {
    async execute() {
      calls.verification++;
      return { verification: { decision: "VERIFIED" } };
    }
  };

  const adaptiveImpactEngine = {
    async analyze(input) {
      calls.impact++;
      return {
        status: "MAPPED",
        received: input.changeReport
      };
    }
  };

  const safetyRecoveryCoordinator = {
    async assess(input) {
      calls.safety++;
      return {
        status: "READY",
        received: input
      };
    },
    async restore() {
      throw new Error("Restore must not run through Stage 7.1.");
    }
  };

  const center = createNimpiControlCenter({
    registry,
    orchestrator,
    verificationPipeline,
    adaptiveImpactEngine,
    safetyRecoveryCoordinator,
    ...overrides,
    registry
  });

  return { center, calls, engines };
}

test("creates a control center when all five subsystems are available", () => {
  const { center } = makeHarness();

  assert.equal(typeof center.getSystemStatus, "function");
  assert.equal(typeof center.listEngines, "function");
  assert.equal(typeof center.inspectEngine, "function");
  assert.equal(typeof center.inspectDependencies, "function");
  assert.equal(typeof center.analyzeChangeImpact, "function");
  assert.equal(typeof center.assessSafety, "function");
  assert.equal(Object.isFrozen(center), true);
});

test("requires every NEA subsystem", () => {
  assert.throws(
    () => createNimpiControlCenter(),
    /NEA registry/
  );

  const harness = makeHarness();

  assert.throws(
    () => createNimpiControlCenter({
      registry: {
        list() {},
        get() {},
        validateDependencies() {}
      }
    }),
    /NEA orchestrator/
  );

  assert.ok(harness.center);
});

test("system status reports all subsystems and safe capabilities", () => {
  const { center, calls } = makeHarness();

  const report = center.getSystemStatus();

  assert.equal(report.status, "READY");
  assert.deepEqual(report.engines, {
    total: 3,
    enabled: 2,
    disabled: 1
  });

  assert.equal(report.subsystems.registry, "AVAILABLE");
  assert.equal(report.subsystems.orchestrator, "AVAILABLE");
  assert.equal(report.subsystems.verificationPipeline, "AVAILABLE");
  assert.equal(report.subsystems.adaptiveImpactEngine, "AVAILABLE");
  assert.equal(report.subsystems.safetyRecoveryCoordinator, "AVAILABLE");

  assert.equal(report.capabilities.engineExecution, false);
  assert.equal(report.capabilities.controlledWrite, false);
  assert.equal(report.capabilities.restoreExecution, false);
  assert.equal(report.safety.enginesExecuted, false);

  assert.deepEqual(calls, {
    orchestrator: 0,
    verification: 0,
    impact: 0,
    safety: 0
  });
});

test("system status reports invalid dependency graph for review", () => {
  const { center } = makeHarness({
    registry: {
      validateDependencies() {
        return {
          valid: false,
          errors: ["Dependency cycle detected"],
          executionOrder: []
        };
      }
    }
  });

  const report = center.getSystemStatus();

  assert.equal(report.status, "REVIEW_REQUIRED");
  assert.equal(report.dependencyGraph.valid, false);
  assert.deepEqual(
    report.dependencyGraph.errors,
    ["Dependency cycle detected"]
  );
});

test("lists enabled engines by default", () => {
  const { center } = makeHarness();

  const engines = center.listEngines();

  assert.deepEqual(
    engines.map(engine => engine.id),
    ["core-engine", "wallet-engine"]
  );
});

test("can include disabled engines in inventory", () => {
  const { center } = makeHarness();

  const engines = center.listEngines({ includeDisabled: true });

  assert.equal(engines.length, 3);
  assert.equal(
    engines.find(engine => engine.id === "disabled-engine").enabled,
    false
  );
});

test("rejects invalid engine list options", () => {
  const { center } = makeHarness();

  assert.throws(
    () => center.listEngines(null),
    /plain object/
  );

  assert.throws(
    () => center.listEngines({ includeDisabled: "yes" }),
    /boolean/
  );
});

test("inspects engine metadata and dependency availability", () => {
  const { center } = makeHarness();

  const engine = center.inspectEngine("wallet-engine");

  assert.equal(engine.id, "wallet-engine");
  assert.deepEqual(engine.capabilities, ["inspect", "wallet"]);
  assert.deepEqual(engine.dependencies, [
    {
      id: "core-engine",
      exists: true,
      enabled: true
    }
  ]);
});

test("inspection freezes cloned metadata without freezing registry data", () => {
  const nested = {
    flags: {
      safe: true
    }
  };

  const engine = {
    ...makeEngine("metadata-engine"),
    metadata: {
      dependencies: [],
      impact: { paths: [] },
      custom: nested
    },
    inputContract: {
      fields: { address: "string" }
    },
    outputContract: {
      fields: { status: "string" }
    }
  };

  const { center } = makeHarness({
    registry: {
      get(id) {
        return id === "metadata-engine" ? engine : null;
      }
    }
  });

  const report = center.inspectEngine("metadata-engine");

  assert.equal(Object.isFrozen(report.metadata.custom), true);
  assert.equal(Object.isFrozen(report.metadata.custom.flags), true);
  assert.equal(Object.isFrozen(nested), false);
  assert.equal(Object.isFrozen(nested.flags), false);

  assert.equal(Object.isFrozen(report.inputContract.fields), true);
  assert.equal(Object.isFrozen(report.outputContract.fields), true);

  nested.flags.safe = false;

  assert.equal(nested.flags.safe, false);
  assert.equal(report.metadata.custom.flags.safe, true);
});

test("returns null for an unknown engine", () => {
  const { center } = makeHarness();

  assert.equal(center.inspectEngine("unknown-engine"), null);
});

test("rejects invalid engine identifiers", () => {
  const { center } = makeHarness();

  assert.throws(
    () => center.inspectEngine(" "),
    /non-empty string/
  );
});

test("inspects dependency order without executing engines", () => {
  const { center, calls } = makeHarness();

  const report = center.inspectDependencies();

  assert.equal(report.valid, true);
  assert.equal(report.status, "VALID");
  assert.deepEqual(report.executionOrder, [
    "core-engine",
    "disabled-engine",
    "wallet-engine"
  ]);

  assert.deepEqual(calls, {
    orchestrator: 0,
    verification: 0,
    impact: 0,
    safety: 0
  });
});

test("delegates change impact analysis exactly once", async () => {
  const { center, calls } = makeHarness();
  const changeReport = { status: "COMPLETE" };

  const result = await center.analyzeChangeImpact({
    changeReport,
    root: "/project"
  });

  assert.equal(result.status, "MAPPED");
  assert.equal(result.received, changeReport);
  assert.equal(calls.impact, 1);
});

test("rejects invalid change impact input before delegation", async () => {
  const { center, calls } = makeHarness();

  await assert.rejects(
    () => center.analyzeChangeImpact(null),
    /plain object/
  );

  await assert.rejects(
    () => center.analyzeChangeImpact({}),
    /changeReport is required/
  );

  assert.equal(calls.impact, 0);
});

test("delegates safety assessment exactly once", async () => {
  const { center, calls } = makeHarness();
  const input = { root: "/project", mode: "read-only" };

  const result = await center.assessSafety(input);

  assert.equal(result.status, "READY");
  assert.equal(result.received, input);
  assert.equal(calls.safety, 1);
});

test("rejects invalid safety input before delegation", async () => {
  const { center, calls } = makeHarness();

  await assert.rejects(
    () => center.assessSafety(null),
    /plain object/
  );

  assert.equal(calls.safety, 0);
});

test("control center inspection never executes or verifies engines", async () => {
  const { center, calls } = makeHarness();

  center.getSystemStatus();
  center.listEngines({ includeDisabled: true });
  center.inspectEngine("wallet-engine");
  center.inspectDependencies();

  await center.analyzeChangeImpact({
    changeReport: { status: "COMPLETE" }
  });

  await center.assessSafety({ root: "/project" });

  assert.deepEqual(calls, {
    orchestrator: 0,
    verification: 0,
    impact: 1,
    safety: 1
  });
});


test("Control Center routes tasks without executing engines or verification", () => {
  const { center, calls } = makeHarness();

  const result = center.routeTask({
    requiredCapabilities: ["wallet"]
  });

  assert.equal(result.status, "ROUTED");
  assert.equal(result.selectedEngineId, "wallet-engine");
  assert.deepEqual(
    result.executionOrder,
    ["core-engine", "wallet-engine"]
  );

  assert.deepEqual(calls, {
    orchestrator: 0,
    verification: 0,
    impact: 0,
    safety: 0
  });

  assert.equal(result.safety.enginesExecuted, false);
  assert.equal(result.safety.commandsExecuted, false);
  assert.equal(result.safety.projectFilesModified, false);
});

test("engine dashboard summarizes domains and capabilities", () => {
  const { center, calls } = makeHarness();

  const dashboard = center.getEngineDashboard();

  assert.equal(dashboard.status, "READY");
  assert.deepEqual(dashboard.overview, {
    totalEngines: 3,
    enabled: 2,
    disabled: 1,
    domainCount: 1,
    capabilityCount: 2,
    dependencyIssueCount: 0,
    dependencyErrorCount: 0,
    reviewRequired: 0
  });

  assert.deepEqual(dashboard.domains, [{
    domain: "test",
    total: 3,
    enabled: 2,
    disabled: 1,
    engineIds: [
      "core-engine",
      "disabled-engine",
      "wallet-engine"
    ]
  }]);

  assert.deepEqual(dashboard.capabilities, [
    {
      capability: "inspect",
      engineCount: 3,
      enabledEngineCount: 2,
      engineIds: [
        "core-engine",
        "disabled-engine",
        "wallet-engine"
      ]
    },
    {
      capability: "wallet",
      engineCount: 1,
      enabledEngineCount: 1,
      engineIds: ["wallet-engine"]
    }
  ]);

  assert.equal(dashboard.safety.readOnly, true);
  assert.equal(dashboard.safety.enginesExecuted, false);
  assert.deepEqual(calls, {
    orchestrator: 0,
    verification: 0,
    impact: 0,
    safety: 0
  });
});

test("engine dashboard exposes per-engine execution and dependency status", () => {
  const { center } = makeHarness({
    registry: {
      list() {
        return [
          makeEngine("core-engine"),
          makeEngine("wallet-engine", {
            dependencies: ["core-engine"],
            capabilities: ["inspect", "wallet"]
          }),
          makeEngine("disabled-engine", { enabled: false }),
          {
            ...makeEngine("write-engine"),
            executionMode: "controlled-write"
          }
        ];
      }
    }
  });

  const dashboard = center.getEngineDashboard();

  assert.equal(dashboard.engines.length, 4);

  const wallet = dashboard.engines.find(
    engine => engine.id === "wallet-engine"
  );

  assert.equal(wallet.status, "ENABLED");
  assert.equal(wallet.executionMode, "read-only");
  assert.deepEqual(wallet.dependencies, [{
    id: "core-engine",
    exists: true,
    enabled: true,
    status: "AVAILABLE"
  }]);
  assert.equal(wallet.reviewRequired, false);

  const disabled = dashboard.engines.find(
    engine => engine.id === "disabled-engine"
  );

  assert.equal(disabled.status, "DISABLED");

  assert.deepEqual(dashboard.executionModes, {
    readOnly: 3,
    controlledWrite: 1,
    unspecified: 0
  });

  assert.equal(Object.isFrozen(dashboard.engines), true);
  assert.equal(Object.isFrozen(wallet.dependencies), true);
});

test("engine dashboard requires a valid dependency graph even without error details", () => {
  const { center } = makeHarness({
    registry: {
      validateDependencies() {
        return {
          valid: false,
          errors: [],
          executionOrder: []
        };
      }
    }
  });

  const dashboard = center.getEngineDashboard();

  assert.equal(dashboard.status, "REVIEW_REQUIRED");
  assert.equal(dashboard.dependencies.valid, false);
  assert.equal(dashboard.overview.dependencyErrorCount, 0);
  assert.equal(dashboard.review.required, true);
  assert.deepEqual(
    dashboard.review.reasons,
    ["DEPENDENCY_GRAPH_INVALID"]
  );
});

test("engine dashboard flags missing and disabled dependencies", () => {
  const missingDependencyEngine = {
    ...makeEngine("review-engine", {
      dependencies: ["disabled-engine", "unknown-engine"]
    }),
    metadata: {
      dependencies: ["disabled-engine", "unknown-engine"]
    }
  };

  const { center } = makeHarness({
    registry: {
      list() {
        return [
          makeEngine("core-engine"),
          makeEngine("disabled-engine", { enabled: false }),
          missingDependencyEngine
        ];
      },
      validateDependencies() {
        return {
          valid: false,
          errors: ["Engine review-engine has unknown dependency: unknown-engine"],
          executionOrder: []
        };
      }
    }
  });

  const dashboard = center.getEngineDashboard();

  assert.equal(dashboard.status, "REVIEW_REQUIRED");
  assert.equal(dashboard.overview.dependencyIssueCount, 2);
  assert.equal(dashboard.overview.reviewRequired, 1);

  assert.deepEqual(dashboard.dependencies.issues, [
    {
      engineId: "review-engine",
      dependencyId: "disabled-engine",
      issue: "DISABLED_DEPENDENCY"
    },
    {
      engineId: "review-engine",
      dependencyId: "unknown-engine",
      issue: "MISSING_DEPENDENCY"
    }
  ]);

  assert.deepEqual(dashboard.review.engineIds, ["review-engine"]);
  assert.equal(dashboard.review.required, true);
});
