import test from "node:test";
import assert from "node:assert/strict";

import {
  createUniversalEngineRegistry
} from "../tools/nea/core/engine-registry.mjs";

function engine(overrides = {}) {
  return {
    id: "sample-engine",
    name: "Sample Engine",
    version: "1.0.0",
    domain: "testing",
    capabilities: ["inspect", "verify"],
    inputContract: "nea.input.v1",
    outputContract: "nea.output.v1",
    metadata: { dependencies: [] },
    ...overrides
  };
}

function legacyRegistry(items) {
  return { list: () => items };
}

test("creates an empty universal registry", () => {
  const registry = createUniversalEngineRegistry();
  assert.equal(registry.size, 0);
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.contractVersion, "1.0.0");
});

test("registers and retrieves an engine", () => {
  const registry = createUniversalEngineRegistry();
  const registered = registry.register(engine());

  assert.equal(registered.id, "sample-engine");
  assert.equal(registry.get("sample-engine").name, "Sample Engine");
  assert.equal(registry.size, 1);
});

test("rejects duplicate engine IDs", () => {
  const registry = createUniversalEngineRegistry();
  registry.register(engine());

  assert.throws(
    () => registry.register(engine()),
    /already registered/
  );
});

test("lists engines in deterministic ID order", () => {
  const registry = createUniversalEngineRegistry();

  registry.register(engine({ id: "zeta-engine" }));
  registry.register(engine({ id: "alpha-engine" }));

  assert.deepEqual(
    registry.list().map(item => item.id),
    ["alpha-engine", "zeta-engine"]
  );
});

test("excludes disabled engines by default", () => {
  const registry = createUniversalEngineRegistry();

  registry.register(engine({
    id: "disabled-engine",
    enabled: false
  }));

  assert.equal(registry.list().length, 0);
  assert.equal(registry.list({ includeDisabled: true }).length, 1);
});

test("finds engines by capability", () => {
  const registry = createUniversalEngineRegistry();

  registry.register(engine());
  registry.register(engine({
    id: "build-engine",
    capabilities: ["build"]
  }));

  assert.deepEqual(
    registry.findByCapability("inspect").map(item => item.id),
    ["sample-engine"]
  );
});

test("finds engines by domain", () => {
  const registry = createUniversalEngineRegistry();

  registry.register(engine());
  registry.register(engine({
    id: "security-engine",
    domain: "security"
  }));

  assert.deepEqual(
    registry.findByDomain("security").map(item => item.id),
    ["security-engine"]
  );
});

test("imports existing legacy registry metadata", () => {
  const registry = createUniversalEngineRegistry();

  const imported = registry.registerLegacyEngines(
    legacyRegistry([{
      id: "inventory-engine",
      name: "NIMPI Inventory Engine",
      version: "1.0.0",
      description: "Project inventory",
      domain: "project-inventory",
      capabilities: ["file-inventory", "git-status"],
      permissions: ["project:read"],
      dependencies: [],
      enabled: true
    }])
  );

  assert.equal(imported.length, 1);
  assert.equal(registry.size, 1);
  assert.equal(registry.get("inventory-engine").metadata.source,
    "legacy-engine-registry");
  assert.deepEqual(
    registry.get("inventory-engine").metadata.permissions,
    ["project:read"]
  );
});

test("does not partially import a batch containing duplicate IDs", () => {
  const registry = createUniversalEngineRegistry();

  assert.throws(
    () => registry.registerLegacyEngines(
      legacyRegistry([
        {
          id: "same-engine",
          name: "First",
          version: "1.0.0",
          domain: "test",
          capabilities: [],
          permissions: [],
          dependencies: []
        },
        {
          id: "same-engine",
          name: "Second",
          version: "1.0.0",
          domain: "test",
          capabilities: [],
          permissions: [],
          dependencies: []
        }
      ])
    ),
    /Duplicate engine/
  );

  assert.equal(registry.size, 0);
});

test("rejects importing an existing engine ID", () => {
  const registry = createUniversalEngineRegistry();
  registry.register(engine({ id: "inventory-engine" }));

  assert.throws(
    () => registry.registerLegacyEngines(
      legacyRegistry([{
        id: "inventory-engine",
        name: "Inventory",
        version: "1.0.0",
        domain: "inventory",
        capabilities: [],
        permissions: [],
        dependencies: []
      }])
    ),
    /Duplicate engine/
  );
});

test("validates dependency ordering", () => {
  const registry = createUniversalEngineRegistry();

  registry.register(engine({
    id: "dependent-engine",
    metadata: { dependencies: ["base-engine"] }
  }));
  registry.register(engine({ id: "base-engine" }));

  const result = registry.validateDependencies();

  assert.equal(result.valid, true);
  assert.deepEqual(result.executionOrder, [
    "base-engine",
    "dependent-engine"
  ]);
});

test("detects unknown dependencies", () => {
  const registry = createUniversalEngineRegistry();

  registry.register(engine({
    metadata: { dependencies: ["missing-engine"] }
  }));

  const result = registry.validateDependencies();

  assert.equal(result.valid, false);
  assert.match(result.errors[0], /unknown dependency/);
  assert.deepEqual(result.executionOrder, []);
});

test("detects dependency cycles", () => {
  const registry = createUniversalEngineRegistry();

  registry.register(engine({
    id: "engine-a",
    metadata: { dependencies: ["engine-b"] }
  }));
  registry.register(engine({
    id: "engine-b",
    metadata: { dependencies: ["engine-a"] }
  }));

  const result = registry.validateDependencies();

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes("cycle")));
});

test("rejects invalid legacy registry interfaces", () => {
  const registry = createUniversalEngineRegistry();

  assert.throws(
    () => registry.registerLegacyEngines({}),
    /compatible legacy registry/
  );
});
