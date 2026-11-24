import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const STORE = path.join(".nacc", "recovery");
const SCHEMA_VERSION = 1;
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^recovery-[0-9]+-[a-f0-9-]{36}$/;

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function validRelativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value)
  ) return false;

  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) {
    return false;
  }

  return ![".git", "node_modules", ".nacc"].includes(parts[0]);
}

function assertId(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new Error("Invalid recovery point identifier.");
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative));
}

async function ensureSafeParents(root, relativePath) {
  const parts = relativePath.split("/");
  let current = root;

  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unsafe parent directory: ${relativePath}`);
    }

    if (!inside(root, await fs.realpath(current))) {
      throw new Error(`Path escapes project root: ${relativePath}`);
    }
  }

  return path.join(root, ...parts);
}

async function readStableRegularFile(root, relativePath) {
  if (!validRelativePath(relativePath)) {
    throw new Error(`Unsafe recovery path: ${relativePath}`);
  }

  const target = await ensureSafeParents(root, relativePath);
  const before = await fs.lstat(target);

  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Recovery accepts regular files only: ${relativePath}`);
  }

  const handle = await fs.open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );

  try {
    const opened = await handle.stat();

    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`File changed while opening: ${relativePath}`);
    }

    const content = await handle.readFile();
    const after = await handle.stat();

    if (
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      content.length !== after.size
    ) {
      throw new Error(`File changed while reading: ${relativePath}`);
    }

    return content;
  } finally {
    await handle.close();
  }
}

async function writeObject(objectsDir, hash, content) {
  const target = path.join(objectsDir, hash);

  try {
    const handle = await fs.open(target, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.unlink(target).catch(() => {});
      throw error;
    }
    await handle.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;

    const existing = await fs.readFile(target);
    if (sha256(existing) !== hash) {
      throw new Error(`Existing recovery object is corrupt: ${hash}`);
    }
  }
}

function validateManifest(manifest, expectedId, root) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Invalid recovery manifest object.");
  }

  if (
    manifest.schemaVersion !== SCHEMA_VERSION ||
    manifest.id !== expectedId ||
    manifest.root !== root ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error("Invalid recovery manifest header.");
  }

  const seen = new Set();

  for (const file of manifest.files) {
    if (
      !file ||
      !validRelativePath(file.path) ||
      seen.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !HASH_RE.test(file.sha256) ||
      file.object !== file.sha256
    ) {
      throw new Error("Invalid recovery manifest file entry.");
    }
    seen.add(file.path);
  }

  return manifest;
}

async function resolveStore(rootPath, options = {}) {
  const root = await fs.realpath(rootPath);
  const store = options.recoveryDir
    ? path.resolve(options.recoveryDir)
    : path.join(root, STORE);

  if (!options.recoveryDir && !inside(root, store)) {
    throw new Error("Recovery store must be inside project root.");
  }

  return {
    root,
    store,
    objectsDir: path.join(store, "objects"),
    manifestsDir: path.join(store, "manifests")
  };
}

export async function createRecoveryPoint(rootPath, {
  paths,
  recoveryDir
} = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("At least one explicit file path is required.");
  }

  if (new Set(paths).size !== paths.length) {
    throw new Error("Duplicate recovery paths are not allowed.");
  }

  const locations = await resolveStore(rootPath, { recoveryDir });

  await fs.mkdir(locations.objectsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(locations.manifestsDir, { recursive: true, mode: 0o700 });

  const files = [];

  for (const relativePath of paths) {
    const content = await readStableRegularFile(
      locations.root,
      relativePath
    );
    const hash = sha256(content);

    await writeObject(locations.objectsDir, hash, content);

    files.push({
      path: relativePath,
      size: content.length,
      sha256: hash,
      object: hash
    });
  }

  const id = `recovery-${Date.now()}-${randomUUID()}`;
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    id,
    root: locations.root,
    createdAt: new Date().toISOString(),
    fileCount: files.length,
    files
  };

  const manifestPath = path.join(
    locations.manifestsDir,
    `${id}.json`
  );

  const handle = await fs.open(manifestPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(manifest, null, 2), "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(manifestPath).catch(() => {});
    throw error;
  }
  await handle.close();

  return {
    id,
    manifestPath,
    fileCount: files.length,
    files: files.map(({ path: filePath, size, sha256: hash }) => ({
      path: filePath,
      size,
      sha256: hash
    }))
  };
}

export async function verifyRecoveryPoint(rootPath, identifier, options = {}) {
  assertId(identifier);

  const locations = await resolveStore(rootPath, options);
  const manifestPath = path.join(
    locations.manifestsDir,
    `${identifier}.json`
  );

  const manifest = validateManifest(
    JSON.parse(await fs.readFile(manifestPath, "utf8")),
    identifier,
    locations.root
  );

  const verified = [];
  const errors = [];

  for (const file of manifest.files) {
    try {
      const objectPath = path.join(locations.objectsDir, file.object);
      const stat = await fs.lstat(objectPath);

      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Recovery object is not a regular file.");
      }

      const content = await fs.readFile(objectPath);

      if (content.length !== file.size || sha256(content) !== file.sha256) {
        throw new Error("Recovery object hash or size mismatch.");
      }

      verified.push(file.path);
    } catch (error) {
      errors.push({ path: file.path, error: error.message });
    }
  }

  return Object.freeze({
    id: identifier,
    valid: errors.length === 0 && verified.length === manifest.files.length,
    fileCount: manifest.files.length,
    verifiedCount: verified.length,
    verified: Object.freeze(verified),
    errors: Object.freeze(errors.map(Object.freeze)),
    restorable: errors.length === 0
  });
}

export async function listRecoveryPoints(rootPath, options = {}) {
  const locations = await resolveStore(rootPath, options);

  let names;
  try {
    names = await fs.readdir(locations.manifestsDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const results = [];

  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;

    const id = name.slice(0, -5);
    if (!ID_RE.test(id)) continue;

    try {
      const manifest = validateManifest(
        JSON.parse(await fs.readFile(
          path.join(locations.manifestsDir, name),
          "utf8"
        )),
        id,
        locations.root
      );

      results.push({
        id,
        createdAt: manifest.createdAt,
        fileCount: manifest.files.length
      });
    } catch {
      // Invalid manifests are omitted from the listing.
    }
  }

  return results;
}

export async function loadVerifiedRecoveryPoint(
  rootPath,
  identifier,
  options = {}
) {
  assertId(identifier);

  const locations = await resolveStore(rootPath, options);
  const manifestPath = path.join(
    locations.manifestsDir,
    `${identifier}.json`
  );

  const manifest = validateManifest(
    JSON.parse(await fs.readFile(manifestPath, "utf8")),
    identifier,
    locations.root
  );

  const files = [];

  for (const entry of manifest.files) {
    const objectPath = path.join(locations.objectsDir, entry.object);
    const stat = await fs.lstat(objectPath);

    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe recovery object: ${entry.object}`);
    }

    const content = await fs.readFile(objectPath);

    if (content.length !== entry.size || sha256(content) !== entry.sha256) {
      throw new Error(`Recovery object verification failed: ${entry.path}`);
    }

    files.push({
      path: entry.path,
      content,
      sha256: entry.sha256
    });
  }

  return {
    id: manifest.id,
    root: manifest.root,
    files
  };
}
