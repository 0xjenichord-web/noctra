import {
  createEngineDescriptor,
  NEA_CONTRACT_VERSION
} from "./contracts.mjs";

const INPUT_CONTRACT = "nea.execution-request.v1";
const OUTPUT_CONTRACT = "nea.execution-result.v1";

function requireLegacyRegistry(registry) {
  if (!registry || typeof registry.list !== "function") {
    throw new TypeError("A compatible legacy registry is required");
  }
}

function normalizeLegacyEngine(engine) {
  const permissions = engine.permissions ?? [];
  const executionMode = permissions.some(permission =>
    ["audit:write", "project:write"].includes(permission)
  ) ? "controlled-write" : "read-only";

  return createEngineDescriptor({
    id: engine.id,
    name: engine.name,
    version: engine.version,
    domain: engine.domain,
    capabilities: engine.capabilities,
    inputContract: INPUT_CONTRACT,
    outputContract: OUTPUT_CONTRACT,
    executionMode,
    enabled: engine.enabled !== false,
    metadata: {
      source: "legacy-engine-registry",
      description: engine.description ?? "",
      permissions: [...(engine.permissions ?? [])],
      dependencies: [...(engine.dependencies ?? [])]
    }
  });
}

export function createUniversalEngineRegistry() {
  const engines = new Map();

  function register(input) {
    const descriptor = createEngineDescriptor(input);

    if (engines.has(descriptor.id)) {
      throw new Error("NEA engine already registered: " + descriptor.id);
    }

    engines.set(descriptor.id, descriptor);
    return descriptor;
  }

  function get(id) {
    return engines.get(id) ?? null;
  }

  function list(options = {}) {
    const includeDisabled = options.includeDisabled === true;

    return [...engines.values()]
      .filter(engine => includeDisabled || engine.enabled)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  function findByCapability(capability) {
    if (typeof capability !== "string" || !capability.trim()) {
      throw new TypeError("Capability must be a non-empty string");
    }

    return list({ includeDisabled: true }).filter(
      engine => engine.capabilities.includes(capability)
    );
  }

  function findByDomain(domain) {
    if (typeof domain !== "string" || !domain.trim()) {
      throw new TypeError("Domain must be a non-empty string");
    }

    return list({ includeDisabled: true }).filter(
      engine => engine.domain === domain
    );
  }

  function registerLegacyEngines(legacyRegistry) {
    requireLegacyRegistry(legacyRegistry);

    const legacyEngines = legacyRegistry.list();
    if (!Array.isArray(legacyEngines)) {
      throw new TypeError("Legacy registry list() must return an array");
    }

    // Validate the complete batch before registering anything.
    const descriptors = legacyEngines.map(normalizeLegacyEngine);
    const batchIds = new Set();

    for (const descriptor of descriptors) {
      if (engines.has(descriptor.id) || batchIds.has(descriptor.id)) {
        throw new Error(
          "Duplicate engine in NEA legacy import: " + descriptor.id
        );
      }
      batchIds.add(descriptor.id);
    }

    for (const descriptor of descriptors) {
      engines.set(descriptor.id, descriptor);
    }

    return descriptors;
  }

  function validateDependencies() {
    const errors = [];
    const state = new Map();
    const ordered = [];
    const stack = [];

    function visit(id) {
      if (state.get(id) === "done") return;

      if (state.get(id) === "visiting") {
        const start = stack.indexOf(id);
        errors.push(
          "Dependency cycle: " +
          [...stack.slice(start), id].join(" -> ")
        );
        return;
      }

      const engine = engines.get(id);
      if (!engine) return;

      state.set(id, "visiting");
      stack.push(id);

      const dependencies = engine.metadata.dependencies ?? [];

      for (const dependency of dependencies) {
        if (!engines.has(dependency)) {
          errors.push(
            "Engine " + id + " has unknown dependency: " + dependency
          );
          continue;
        }

        visit(dependency);
      }

      stack.pop();
      state.set(id, "done");
      ordered.push(id);
    }

    for (const id of [...engines.keys()].sort()) {
      visit(id);
    }

    return Object.freeze({
      valid: errors.length === 0,
      errors: Object.freeze(errors),
      executionOrder: Object.freeze(
        errors.length === 0 ? ordered : []
      )
    });
  }

  return Object.freeze({
    register,
    get,
    list,
    findByCapability,
    findByDomain,
    registerLegacyEngines,
    validateDependencies,
    get size() {
      return engines.size;
    },
    contractVersion: NEA_CONTRACT_VERSION
  });
}

export { INPUT_CONTRACT, OUTPUT_CONTRACT };
