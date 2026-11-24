import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  createRecoveryPoint,
  verifyRecoveryPoint
} from "../tools/nea/core/recovery-store.mjs";

import {
  createRestoreCoordinator
} from "../tools/nea/core/restore-coordinator.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nea-restore-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

const approval = {
  approved: true,
  reference: "test-human-approval"
};

test("restores file content after explicit approval", async t => {
  const root = await fixture(t);
  const target = path.join(root, "app.mjs");

  await fs.writeFile(target, "original");
  const point = await createRecoveryPoint(root, {
    paths: ["app.mjs"]
  });

  await fs.writeFile(target, "modified");

  const coordinator = createRestoreCoordinator();
  const result = await coordinator.restore({
    rootPath: root,
    recoveryPointId: point.id,
    authorization: approval
  });

  assert.equal(await fs.readFile(target, "utf8"), "original");
  assert.equal(result.status, "RESTORED");
  assert.equal(result.verified, true);
  assert.equal(result.recoveryPointId, point.id);
  assert.ok(result.preRestoreRecoveryPointId);
});

test("preserves pre-restore state as a separate recovery point", async t => {
  const root = await fixture(t);
  const target = path.join(root, "app.mjs");

  await fs.writeFile(target, "before");
  const point = await createRecoveryPoint(root, {
    paths: ["app.mjs"]
  });

  await fs.writeFile(target, "current");

  const result = await createRestoreCoordinator().restore({
    rootPath: root,
    recoveryPointId: point.id,
    authorization: approval
  });

  const beforeRestore = await verifyRecoveryPoint(
    root,
    result.preRestoreRecoveryPointId
  );

  assert.equal(beforeRestore.valid, true);

  const manifestPath = path.join(
    root,
    ".nacc",
    "recovery",
    "manifests",
    `${result.preRestoreRecoveryPointId}.json`
  );

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const object = path.join(
    root,
    ".nacc",
    "recovery",
    "objects",
    manifest.files[0].object
  );

  assert.equal(await fs.readFile(object, "utf8"), "current");
});

test("rejects restore without explicit authorization", async t => {
  const root = await fixture(t);
  const target = path.join(root, "app.mjs");

  await fs.writeFile(target, "original");
  const point = await createRecoveryPoint(root, {
    paths: ["app.mjs"]
  });

  await fs.writeFile(target, "modified");

  await assert.rejects(
    createRestoreCoordinator().restore({
      rootPath: root,
      recoveryPointId: point.id
    }),
    /authorization/
  );

  assert.equal(await fs.readFile(target, "utf8"), "modified");
});

test("rejects a corrupted recovery point without changing target", async t => {
  const root = await fixture(t);
  const target = path.join(root, "app.mjs");

  await fs.writeFile(target, "original");
  const point = await createRecoveryPoint(root, {
    paths: ["app.mjs"]
  });

  await fs.writeFile(target, "modified");

  const object = path.join(
    root,
    ".nacc",
    "recovery",
    "objects",
    hash("original")
  );

  await fs.writeFile(object, "corrupted");

  await assert.rejects(
    createRestoreCoordinator().restore({
      rootPath: root,
      recoveryPointId: point.id,
      authorization: approval
    }),
    /integrity verification/
  );

  assert.equal(await fs.readFile(target, "utf8"), "modified");
});

test("rejects symlink restore targets", async t => {
  const root = await fixture(t);
  const real = path.join(root, "real.mjs");
  const target = path.join(root, "app.mjs");

  await fs.writeFile(real, "original");
  await fs.writeFile(target, "safe");

  const recoveryDir = path.join(root, "external-recovery");
  await fs.mkdir(recoveryDir);

  const point = await createRecoveryPoint(root, {
    paths: ["app.mjs"],
    recoveryDir
  });

  const manifestPath = path.join(
    recoveryDir,
    "manifests",
    `${point.id}.json`
  );

  const manifest = JSON.parse(
    await fs.readFile(manifestPath, "utf8")
  );

  // Keep the valid content hash but point the manifest entry at app.mjs.
  manifest.files[0].path = "app.mjs";
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  await fs.unlink(target);
  await fs.symlink(real, target);

  await assert.rejects(
    createRestoreCoordinator().restore({
      rootPath: root,
      recoveryPointId: point.id,
      authorization: approval,
      recoveryDir
    }),
    /regular file/
  );

  assert.equal(await fs.readFile(real, "utf8"), "original");
});
test("rolls back original files when post-restore verification fails", async t => {
  const root = await fixture(t);
  const target = path.join(root, "app.mjs");

  await fs.writeFile(target, "original");

  const point = await createRecoveryPoint(root, {
    paths: ["app.mjs"]
  });

  await fs.writeFile(target, "current");

  const coordinator = createRestoreCoordinator({
    loadRecoveryPointFn: async verifiedRoot => ({
      root: verifiedRoot,
      files: [{
        path: "app.mjs",
        content: Buffer.from("tampered"),
        sha256: hash("original"),
        size: Buffer.byteLength("original")
      }]
    })
  });

  await assert.rejects(
    coordinator.restore({
      rootPath: root,
      recoveryPointId: point.id,
      authorization: approval
    }),
    /Post-restore verification failed/
  );

  assert.equal(
    await fs.readFile(target, "utf8"),
    "current",
    "original target content must be restored after verification failure"
  );
});

test("rejects unknown recovery point identifiers", async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "app.mjs"), "content");

  await assert.rejects(
    createRestoreCoordinator().restore({
      rootPath: root,
      recoveryPointId: "../invalid",
      authorization: approval
    })
  );
});
