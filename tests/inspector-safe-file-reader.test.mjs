import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

import {
  createSafeFileReader
} from "../tools/inspector/safe-file-reader.mjs";

async function createFixture() {
  const rootPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "noctra-inspector-")
  );

  return {
    rootPath,
    cleanup: () => fs.rm(rootPath, {
      recursive: true,
      force: true
    })
  };
}

test("reads a regular source file and returns its SHA-256", async () => {
  const fixture = await createFixture();

  try {
    const content = "export function hello() { return true; }\n";

    await fs.writeFile(
      path.join(fixture.rootPath, "sample.mjs"),
      content
    );

    const reader = await createSafeFileReader({
      rootPath: fixture.rootPath
    });

    const result = await reader.readFile("sample.mjs");

    assert.equal(result.content, content);
    assert.equal(
      result.sha256,
      createHash("sha256").update(content).digest("hex")
    );
    assert.equal(result.relativePath, "sample.mjs");
  } finally {
    await fixture.cleanup();
  }
});

test("rejects path traversal", async () => {
  const fixture = await createFixture();

  try {
    const reader = await createSafeFileReader({
      rootPath: fixture.rootPath
    });

    await assert.rejects(
      reader.readFile("../outside.mjs")
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects symbolic links", async () => {
  const fixture = await createFixture();

  try {
    const outside = path.join(
      os.tmpdir(),
      `noctra-outside-${process.pid}.mjs`
    );

    await fs.writeFile(outside, "secret");
    await fs.symlink(
      outside,
      path.join(fixture.rootPath, "linked.mjs")
    );

    const reader = await createSafeFileReader({
      rootPath: fixture.rootPath
    });

    await assert.rejects(
      reader.readFile("linked.mjs")
    );

    await fs.rm(outside, { force: true });
  } finally {
    await fixture.cleanup();
  }
});

test("rejects secret files", async () => {
  const fixture = await createFixture();

  try {
    await fs.writeFile(
      path.join(fixture.rootPath, ".env"),
      "SECRET=value"
    );

    const reader = await createSafeFileReader({
      rootPath: fixture.rootPath
    });

    await assert.rejects(
      reader.readFile(".env")
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects files exceeding the configured size limit", async () => {
  const fixture = await createFixture();

  try {
    await fs.writeFile(
      path.join(fixture.rootPath, "large.mjs"),
      "1234567890"
    );

    const reader = await createSafeFileReader({
      rootPath: fixture.rootPath,
      maxFileBytes: 5
    });

    await assert.rejects(
      reader.readFile("large.mjs")
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects directories instead of reading them as files", async () => {
  const fixture = await createFixture();

  try {
    await fs.mkdir(
      path.join(fixture.rootPath, "subdir")
    );

    const reader = await createSafeFileReader({
      rootPath: fixture.rootPath
    });

    await assert.rejects(
      reader.readFile("subdir")
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects symbolic links in parent directories", async () => {
  const fixture = await createFixture();

  try {
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "noctra-parent-")
    );

    await fs.writeFile(
      path.join(outside, "sample.mjs"),
      "secret"
    );

    await fs.symlink(
      outside,
      path.join(fixture.rootPath, "linked-dir")
    );

    const reader = await createSafeFileReader({
      rootPath: fixture.rootPath
    });

    await assert.rejects(
      reader.readFile("linked-dir/sample.mjs")
    );

    await fs.rm(outside, { recursive: true, force: true });
  } finally {
    await fixture.cleanup();
  }
});

test("rejects invalid UTF-8 source files", async () => {
  const fixture = await createFixture();

  try {
    await fs.writeFile(
      path.join(fixture.rootPath, "invalid.mjs"),
      Buffer.from([0xc3, 0x28])
    );

    const reader = await createSafeFileReader({
      rootPath: fixture.rootPath
    });

    await assert.rejects(
      reader.readFile("invalid.mjs"),
      /UTF-8/
    );
  } finally {
    await fixture.cleanup();
  }
});

test("does not modify source files while reading", async () => {
  const fixture = await createFixture();

  try {
    const file = path.join(fixture.rootPath, "readonly.mjs");
    const original = "export const value = 42;\n";

    await fs.writeFile(file, original);

    const reader = await createSafeFileReader({
      rootPath: fixture.rootPath
    });

    await reader.readFile("readonly.mjs");

    const after = await fs.readFile(file, "utf8");

    assert.equal(after, original);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects sensitive files inside nested directories", async () => {
  const fixture = await createFixture();

  try {
    await fs.mkdir(
      path.join(fixture.rootPath, "config")
    );

    await fs.writeFile(
      path.join(fixture.rootPath, "config", ".env.development"),
      "SECRET=value"
    );

    const reader = await createSafeFileReader({
      rootPath: fixture.rootPath
    });

    await assert.rejects(
      reader.readFile("config/.env.development")
    );
  } finally {
    await fixture.cleanup();
  }
});
