import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  createRecoveryPoint,
  verifyRecoveryPoint,
  listRecoveryPoints
} from "../tools/nea/core/recovery-store.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nea-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("creates a recovery point with immutable content objects", async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/app.mjs"), "original");

  const point = await createRecoveryPoint(root, {
    paths: ["src/app.mjs"]
  });

  assert.equal(point.fileCount, 1);
  assert.equal(point.files[0].sha256, hash("original"));

  const object = path.join(
    root, ".nacc", "recovery", "objects", hash("original")
  );

  assert.equal(await fs.readFile(object, "utf8"), "original");
});

test("verifies a valid recovery point", async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "app.mjs"), "content");

  const point = await createRecoveryPoint(root, {
    paths: ["app.mjs"]
  });

  const report = await verifyRecoveryPoint(root, point.id);

  assert.equal(report.valid, true);
  assert.equal(report.restorable, true);
  assert.equal(report.verifiedCount, 1);
});

test("recovery point remains valid after source file changes", async t => {
  const root = await fixture(t);
  const source = path.join(root, "app.mjs");

  await fs.writeFile(source, "before");
  const point = await createRecoveryPoint(root, {
    paths: ["app.mjs"]
  });

  await fs.writeFile(source, "after");

  const report = await verifyRecoveryPoint(root, point.id);
  assert.equal(report.valid, true);

  const object = path.join(
    root, ".nacc", "recovery", "objects", hash("before")
  );
  assert.equal(await fs.readFile(object, "utf8"), "before");
});

test("rejects path traversal and protected directories", async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "app.mjs"), "content");

  for (const unsafe of [
    "../outside",
    "/etc/passwd",
    ".git/config",
    "node_modules/pkg/index.js",
    ".nacc/private"
  ]) {
    await assert.rejects(
      createRecoveryPoint(root, { paths: [unsafe] })
    );
  }
});

test("rejects symlink source files", async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "real.txt"), "content");
  await fs.symlink(
    path.join(root, "real.txt"),
    path.join(root, "link.txt")
  );

  await assert.rejects(
    createRecoveryPoint(root, { paths: ["link.txt"] })
  );
});

test("detects corrupted recovery objects", async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "app.mjs"), "original");

  const point = await createRecoveryPoint(root, {
    paths: ["app.mjs"]
  });

  const object = path.join(
    root, ".nacc", "recovery", "objects", hash("original")
  );

  await fs.writeFile(object, "tampered");

  const report = await verifyRecoveryPoint(root, point.id);

  assert.equal(report.valid, false);
  assert.equal(report.restorable, false);
  assert.equal(report.errors.length, 1);
});

test("rejects duplicate source paths", async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "app.mjs"), "content");

  await assert.rejects(
    createRecoveryPoint(root, {
      paths: ["app.mjs", "app.mjs"]
    }),
    /Duplicate/
  );
});

test("lists valid recovery manifests", async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "app.mjs"), "content");

  const point = await createRecoveryPoint(root, {
    paths: ["app.mjs"]
  });

  const list = await listRecoveryPoints(root);

  assert.equal(list.length, 1);
  assert.equal(list[0].id, point.id);
});

test("omits malformed manifests from listing", async t => {
  const root = await fixture(t);
  const dir = path.join(root, ".nacc", "recovery", "manifests");

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "recovery-1-00000000-0000-0000-0000-000000000000.json"),
    "{broken"
  );

  assert.deepEqual(await listRecoveryPoints(root), []);
});

test("rejects invalid recovery identifiers", async t => {
  const root = await fixture(t);

  await assert.rejects(
    verifyRecoveryPoint(root, "../manifest.json"),
    /Invalid recovery point identifier/
  );
});
