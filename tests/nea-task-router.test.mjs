import test from "node:test";
import assert from "node:assert/strict";

import {
  createTaskRouter
} from "../tools/nea/core/task-router.mjs";

function engine(id, options = {}) {
  return {
    id,
    name: id,
    version: "1.0.0",
    domain: options.domain ?? "wallet",
    enabled: options.enabled ?? true,
    executionMode: options.executionMode ?? "read-only",
    capabilities: options.capabilities ?? ["inspect"],
    metadata: {
      dependencies: options.dependencies ?? []
    }
  };
}

function makeRegistry(engines, graph = {}) {
  const byId = new Map(engines.map(item => [item.id, item]));

  return {
    list() {
      return [...engines];
    },
    get(id) {
      return byId.get(id) ?? null;
    },
    validateDependencies() {
      return {
        valid: graph.valid ?? true,
        errors: graph.errors ?? [],
        executionOrder: graph.executionOrder ??
          engines.map(item => item.id)
      };
    }
  };
}

test("routes a task to the only engine matching all capabilities", () => {
  const registry = makeRegistry([
    engine("wallet-engine", {
      capabilities: ["inspect", "wallet", "assets"]
    }),
    engine("other-engine", {
      capabilities: ["inspect", "wallet"]
    })
  ]);

  const router = createTaskRouter({ registry });
  const result = router.routeTask({
    requiredCapabilities: ["inspect", "wallet", "assets"]
  });

  assert.equal(result.status, "ROUTED");
  assert.equal(result.selectedEngineId, "wallet-engine");
  assert.deepEqual(result.executionOrder, ["wallet-engine"]);
});

test("reports partial capability scores without making partial candidates eligible", () => {
  const registry = makeRegistry([
    engine("complete-engine", {
      capabilities: ["wallet", "assets", "transactions"]
    }),
    engine("partial-engine", {
      capabilities: ["wallet", "assets"]
    })
  ]);

  const result = createTaskRouter({ registry }).routeTask({
    requiredCapabilities: ["wallet", "assets", "transactions"]
  });

  const complete = result.candidates.find(
    candidate => candidate.id === "complete-engine"
  );

  const partial = result.candidates.find(
    candidate => candidate.id === "partial-engine"
  );

  assert.equal(complete.matchScore, 100);
  assert.equal(complete.decision.eligible, true);
  assert.deepEqual(complete.missingCapabilities, []);

  assert.equal(partial.matchScore, 67);
  assert.deepEqual(
    partial.matchedCapabilities,
    ["wallet", "assets"]
  );
  assert.deepEqual(
    partial.missingCapabilities,
    ["transactions"]
  );
  assert.equal(partial.status, "BLOCKED");
  assert.equal(partial.decision.eligible, false);
  assert.ok(partial.reasons.includes("MISSING_REQUIRED_CAPABILITIES"));
  assert.equal(partial.decision.status, "BLOCKED");
  assert.deepEqual(partial.decision.blockers, partial.reasons);
  assert.ok(partial.decision.reasons.includes("MISSING_REQUIRED_CAPABILITIES"));
  assert.equal(partial.decision.authorizationRequired, false);

  assert.equal(complete.decision.status, "READY");
  assert.deepEqual(complete.decision.blockers, []);

  assert.equal(result.status, "ROUTED");
  assert.equal(result.selectedEngineId, "complete-engine");
  assert.deepEqual(result.executionOrder, ["complete-engine"]);
});

test("does not allow a perfect score to bypass disabled engine safety", () => {
  const registry = makeRegistry([
    engine("disabled-engine", {
      enabled: false,
      capabilities: ["wallet", "assets"]
    })
  ]);

  const result = createTaskRouter({ registry }).routeTask({
    requiredCapabilities: ["wallet", "assets"]
  });

  assert.equal(result.candidates[0].matchScore, 100);
  assert.equal(result.candidates[0].status, "BLOCKED");
  assert.equal(result.candidates[0].decision.eligible, false);
  assert.equal(result.candidates[0].decision.status, "BLOCKED");
  assert.ok(result.candidates[0].decision.blockers.includes("ENGINE_DISABLED"));
  assert.deepEqual(result.candidates[0].decision.blockers, result.candidates[0].reasons);
  assert.equal(result.candidates[0].decision.authorizationRequired, false);
  assert.equal(result.selectedEngineId, null);
  assert.deepEqual(result.executionOrder, []);
});

test("ranks ready candidates before preferred partial matches and sorts blocked candidates by score", () => {
  const registry = makeRegistry([
    engine("ready-engine", {
      capabilities: ["wallet", "assets", "transactions"]
    }),
    engine("preferred-partial", {
      capabilities: ["wallet", "assets"]
    }),
    engine("lower-partial", {
      capabilities: ["wallet"]
    })
  ]);

  const result = createTaskRouter({ registry }).routeTask({
    requiredCapabilities: ["wallet", "assets", "transactions"],
    preferredEngineId: "preferred-partial"
  });

  assert.deepEqual(
    result.candidates.map(candidate => candidate.id),
    ["ready-engine", "preferred-partial", "lower-partial"]
  );

  assert.deepEqual(
    result.candidates.map(candidate => candidate.ranking),
    [1, 2, 3]
  );

  assert.deepEqual(
    result.candidates.map(candidate => candidate.matchScore),
    [100, 67, 33]
  );

  assert.equal(result.candidates[0].status, "READY");
  assert.equal(result.candidates[1].status, "BLOCKED");
  assert.equal(result.candidates[2].status, "BLOCKED");

  assert.equal(result.selectedEngineId, "ready-engine");
  assert.equal(result.status, "ROUTED");
});

test("does not select an engine when multiple candidates are equally suitable", () => {
  const registry = makeRegistry([
    engine("engine-a", { capabilities: ["wallet"] }),
    engine("engine-b", { capabilities: ["wallet"] })
  ]);

  const result = createTaskRouter({ registry }).routeTask({
    requiredCapabilities: ["wallet"]
  });

  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(result.selectedEngineId, null);
  assert.equal(result.candidates.length, 2);
});

test("uses preferred engine as a deterministic priority", () => {
  const registry = makeRegistry([
    engine("engine-a", { capabilities: ["wallet"] }),
    engine("engine-b", { capabilities: ["wallet"] })
  ]);

  const result = createTaskRouter({ registry }).routeTask({
    requiredCapabilities: ["wallet"],
    preferredEngineId: "engine-b"
  });

  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(result.candidates[0].id, "engine-b");
  assert.equal(result.selectedEngineId, null);
});

test("filters candidates by domain", () => {
  const registry = makeRegistry([
    engine("wallet-engine", { domain: "wallet" }),
    engine("audit-engine", { domain: "audit" })
  ]);

  const result = createTaskRouter({ registry }).routeTask({
    domain: "audit"
  });

  assert.equal(result.status, "ROUTED");
  assert.equal(result.selectedEngineId, "audit-engine");
});

test("includes dependencies in dependency-first order", () => {
  const registry = makeRegistry([
    engine("core-engine"),
    engine("wallet-engine", {
      dependencies: ["core-engine"],
      capabilities: ["wallet"]
    })
  ]);

  const result = createTaskRouter({ registry }).routeTask({
    requiredCapabilities: ["wallet"]
  });

  assert.equal(result.status, "ROUTED");
  assert.deepEqual(
    result.executionOrder,
    ["core-engine", "wallet-engine"]
  );
});

test("blocks an engine whose dependency is disabled", () => {
  const registry = makeRegistry([
    engine("core-engine", { enabled: false }),
    engine("wallet-engine", {
      dependencies: ["core-engine"],
      capabilities: ["wallet"]
    })
  ]);

  const result = createTaskRouter({ registry }).routeTask({
    requiredCapabilities: ["wallet"]
  });

  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.equal(result.selectedEngineId, null);
  assert.ok(
    result.candidates[0].reasons.includes(
      "DISABLED_DEPENDENCY:core-engine"
    )
  );
  assert.equal(result.candidates[0].decision.status, "BLOCKED");
  assert.ok(
    result.candidates[0].decision.blockers.includes(
      "DISABLED_DEPENDENCY:core-engine"
    )
  );
});

test("requires explicit authorization for controlled-write routing", () => {
  const registry = makeRegistry([
    engine("write-engine", {
      executionMode: "controlled-write",
      capabilities: ["write"]
    })
  ]);

  const result = createTaskRouter({ registry }).routeTask({
    requiredCapabilities: ["write"]
  });

  assert.equal(result.status, "AUTHORIZATION_REQUIRED");
  assert.equal(result.selectedEngineId, null);
  assert.equal(result.candidates[0].decision.status, "AUTHORIZATION_REQUIRED");
  assert.equal(result.candidates[0].decision.authorizationRequired, true);
  assert.ok(
    result.candidates[0].decision.blockers.includes(
      "CONTROLLED_WRITE_REQUIRES_EXPLICIT_AUTHORIZATION"
    )
  );
});

test("accepts an explicit authorization reference without executing", () => {
  const registry = makeRegistry([
    engine("write-engine", {
      executionMode: "controlled-write",
      capabilities: ["write"]
    })
  ]);

  const result = createTaskRouter({ registry }).routeTask({
    requiredCapabilities: ["write"],
    authorization: {
      approved: true,
      reference: "test-approval-001"
    }
  });

  assert.equal(result.status, "ROUTED");
  assert.equal(result.selectedEngineId, "write-engine");
  assert.equal(result.candidates[0].decision.status, "READY");
  assert.equal(result.candidates[0].decision.authorizationRequired, false);
  assert.deepEqual(result.candidates[0].decision.blockers, []);
  assert.equal(result.authorization.executionPerformed, false);
  assert.equal(result.safety.enginesExecuted, false);
});

test("requires authorization when a read-only engine depends on controlled-write", () => {
  const registry = makeRegistry([
    engine("write-dependency", {
      executionMode: "controlled-write"
    }),
    engine("wallet-engine", {
      dependencies: ["write-dependency"],
      capabilities: ["wallet"]
    })
  ]);

  const result = createTaskRouter({ registry }).routeTask({
    requiredCapabilities: ["wallet"]
  });

  assert.equal(result.status, "AUTHORIZATION_REQUIRED");
  assert.equal(result.selectedEngineId, null);
  assert.deepEqual(
    result.executionOrder,
    []
  );
});

test("allows a dependency chain with controlled-write only after explicit authorization", () => {
  const registry = makeRegistry([
    engine("write-dependency", {
      executionMode: "controlled-write"
    }),
    engine("wallet-engine", {
      dependencies: ["write-dependency"],
      capabilities: ["wallet"]
    })
  ]);

  const result = createTaskRouter({ registry }).routeTask({
    requiredCapabilities: ["wallet"],
    authorization: {
      approved: true,
      reference: "dependency-chain-approval"
    }
  });

  assert.equal(result.status, "ROUTED");
  assert.equal(result.selectedEngineId, "wallet-engine");
  assert.deepEqual(
    result.executionOrder,
    ["write-dependency", "wallet-engine"]
  );
  assert.equal(result.safety.enginesExecuted, false);
});

test("requires review when the global dependency graph is invalid", () => {
  const registry = makeRegistry(
    [engine("wallet-engine", { capabilities: ["wallet"] })],
    { valid: false, errors: ["Dependency cycle"] }
  );

  const result = createTaskRouter({ registry }).routeTask({
    requiredCapabilities: ["wallet"]
  });

  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.equal(result.selectedEngineId, null);
  assert.equal(result.candidates[0].status, "REVIEW_REQUIRED");
});

test("does not mutate registry descriptors", () => {
  const source = engine("wallet-engine", {
    capabilities: ["wallet"]
  });
  const registry = makeRegistry([source]);

  createTaskRouter({ registry }).routeTask({
    requiredCapabilities: ["wallet"]
  });

  assert.deepEqual(source.capabilities, ["wallet"]);
  assert.deepEqual(source.metadata.dependencies, []);
});

test("returns deeply frozen routing reports", () => {
  const registry = makeRegistry([
    engine("wallet-engine", { capabilities: ["wallet"] })
  ]);

  const result = createTaskRouter({ registry }).routeTask({
    requiredCapabilities: ["wallet"]
  });

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.candidates), true);
  assert.equal(Object.isFrozen(result.candidates[0]), true);
  assert.equal(Object.isFrozen(result.executionOrder), true);
});

test("rejects invalid routing input", () => {
  const router = createTaskRouter({
    registry: makeRegistry([engine("wallet-engine")])
  });

  assert.throws(
    () => router.routeTask({}),
    /At least one routing criterion/
  );

  assert.throws(
    () => router.routeTask({ requiredCapabilities: "wallet" }),
    /array of non-empty strings/
  );

  assert.throws(
    () => router.routeTask({
      requiredCapabilities: ["wallet", "wallet"]
    }),
    /must not contain duplicates/
  );
});

test("rejects invalid registry interfaces", () => {
  assert.throws(
    () => createTaskRouter({ registry: {} }),
    /compatible NEA registry/
  );
});
