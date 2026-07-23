import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applicationIdempotencyKey,
  createApplicationOperation,
  loadApplicationOperation,
  updateApplicationOperation,
} from "../src/app-operation.js";

describe("application operations", () => {
  it("uses a stable key so retries cannot create duplicate promotions", () => {
    expect(
      applicationIdempotencyKey("promote", "dep_1", "rel_1", "ver_1"),
    ).toBe(
      applicationIdempotencyKey("promote", "dep_1", "rel_1", "ver_1"),
    );
    expect(
      applicationIdempotencyKey("rollback", "dep_1", "rel_1", "ver_1"),
    ).not.toBe(
      applicationIdempotencyKey("promote", "dep_1", "rel_1", "ver_1"),
    );
  });

  it("persists interrupted state for recovery", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-operation-"));
    try {
      const created = createApplicationOperation(dir, {
        idempotency_key: "app_key",
        action: "promote",
        deployment_id: "dep_1",
        release_id: "rel_1",
        previous_version_id: "ver_0",
        target_version_id: "ver_1",
        state: "pending",
      });
      const completed = updateApplicationOperation(dir, created, {
        state: "succeeded",
        receipt_id: "rcpt_1",
      });
      expect(
        loadApplicationOperation(dir, created.operation_id),
      ).toMatchObject(completed);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
