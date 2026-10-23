import assert from "node:assert/strict";
import test from "node:test";

import {
  BulkActionError,
  runBulkAction,
} from "../../src/lib/backend/bulkActionFramework.js";

const SECRET = "test-bulk-action-secret-with-32-chars";
const NOW = () => new Date("2026-10-23T12:00:00.000Z");

function createHarness(records) {
  const docs = new Map(records.map((record) => [record._id, { ...record }]));
  const executions = new Map();
  const applied = [];
  let writes = 0;
  const db = {
    collection(name) {
      assert.equal(name, "bulk_action_executions");
      return {
        async insertOne(record) {
          writes += 1;
          if (executions.has(record._id)) {
            const error = new Error("duplicate key");
            error.code = 11000;
            throw error;
          }
          executions.set(record._id, { ...record });
        },
        async updateOne(filter, update) {
          writes += 1;
          const record = executions.get(filter._id);
          if (record && record.status === filter.status) Object.assign(record, update.$set);
        },
      };
    },
  };
  const options = (overrides = {}) => ({
    db,
    actor: { sub: "creator-1" },
    action: "archive",
    recordIds: ["m1", "m2"],
    dryRun: true,
    authorizeActor: async () => true,
    resolveRecord: async (id) => docs.get(id) || null,
    isEligible: (record, actor) => record.owner === actor.sub
      ? { eligible: true }
      : { eligible: false, reason: "not_owner" },
    revisionOf: (record) => `${record.version}:${record.archived}`,
    applyRecord: async (record) => {
      applied.push(record._id);
      record.archived = true;
      record.version += 1;
    },
    now: NOW,
    tokenSecret: SECRET,
    ...overrides,
  });
  return { docs, executions, applied, get writes() { return writes; }, options };
}

test("dry run counts all eligible selections and performs no writes", async () => {
  const harness = createHarness([
    { _id: "m1", owner: "creator-1", version: 1, archived: false },
    { _id: "m2", owner: "creator-1", version: 4, archived: false },
  ]);

  const preview = await runBulkAction(harness.options());
  assert.equal(preview.dryRun, true);
  assert.equal(preview.eligibleCount, 2);
  assert.equal(preview.failureCount, 0);
  assert.equal(harness.writes, 0);
  assert.equal(harness.applied.length, 0);
  assert.ok(preview.confirmationToken);

  const execution = await runBulkAction(harness.options({
    dryRun: false,
    confirmationToken: preview.confirmationToken,
  }));
  assert.equal(execution.appliedCount, 2);
  assert.deepEqual(harness.applied, ["m1", "m2"]);
});

test("partially eligible selection applies only eligible records and reports each failure", async () => {
  const harness = createHarness([
    { _id: "m1", owner: "creator-1", version: 1, archived: false },
    { _id: "m2", owner: "another-creator", version: 1, archived: false },
  ]);
  const preview = await runBulkAction(harness.options());
  assert.equal(preview.eligibleCount, 1);
  assert.equal(preview.records[1].reason, "not_owner");

  const result = await runBulkAction(harness.options({
    dryRun: false,
    confirmationToken: preview.confirmationToken,
  }));
  assert.deepEqual(harness.applied, ["m1"]);
  assert.equal(result.records[0].status, "applied");
  assert.equal(result.records[1].reason, "not_owner");
});

test("changed records fail as stale and are not applied", async () => {
  const harness = createHarness([
    { _id: "m1", owner: "creator-1", version: 1, archived: false },
    { _id: "m2", owner: "creator-1", version: 1, archived: false },
  ]);
  const preview = await runBulkAction(harness.options());
  harness.docs.get("m2").version = 2;

  const result = await runBulkAction(harness.options({
    dryRun: false,
    confirmationToken: preview.confirmationToken,
  }));
  assert.equal(result.records[1].reason, "stale_selection");
  assert.deepEqual(harness.applied, ["m1"]);
});

test("unauthorized actors are rejected before record reads or writes", async () => {
  const harness = createHarness([
    { _id: "m1", owner: "creator-1", version: 1, archived: false },
  ]);
  let reads = 0;

  await assert.rejects(
    runBulkAction(harness.options({
      recordIds: ["m1"],
      authorizeActor: async () => false,
      resolveRecord: async () => {
        reads += 1;
        return null;
      },
    })),
    (error) => error instanceof BulkActionError && error.code === "UNAUTHORIZED",
  );
  assert.equal(reads, 0);
  assert.equal(harness.writes, 0);
});

test("a confirmation token cannot be executed twice", async () => {
  const harness = createHarness([
    { _id: "m1", owner: "creator-1", version: 1, archived: false },
  ]);
  const preview = await runBulkAction(harness.options({ recordIds: ["m1"] }));
  const execution = harness.options({
    recordIds: ["m1"],
    dryRun: false,
    confirmationToken: preview.confirmationToken,
  });
  await runBulkAction(execution);
  await assert.rejects(
    runBulkAction(execution),
    (error) => error instanceof BulkActionError && error.code === "DUPLICATE_EXECUTION",
  );
  assert.deepEqual(harness.applied, ["m1"]);
});
