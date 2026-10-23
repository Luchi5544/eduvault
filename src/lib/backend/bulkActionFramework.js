import crypto from "node:crypto";

export const BULK_ACTION_MAX_RECORDS = 100;
export const BULK_ACTION_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
export const BULK_ACTION_EXECUTIONS_COLLECTION = "bulk_action_executions";

export class BulkActionError extends Error {
  constructor(message, code = "BULK_ACTION_INVALID", status = 400) {
    super(message);
    this.name = "BulkActionError";
    this.code = code;
    this.status = status;
  }
}

function actorIdOf(actor) {
  return String(actor?.sub || actor?.id || "");
}

function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function createConfirmationToken(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

function readConfirmationToken(token, secret, now) {
  if (typeof token !== "string") {
    throw new BulkActionError("A confirmationToken from the dry run is required.", "CONFIRMATION_REQUIRED", 400);
  }

  const [encoded, suppliedSignature, extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra !== undefined) {
    throw new BulkActionError("Confirmation token is invalid.", "INVALID_CONFIRMATION", 400);
  }
  const expectedSignature = sign(encoded, secret);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw new BulkActionError("Confirmation token is invalid.", "INVALID_CONFIRMATION", 400);
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new BulkActionError("Confirmation token is invalid.", "INVALID_CONFIRMATION", 400);
  }

  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= now.getTime()) {
    throw new BulkActionError("Confirmation token has expired. Run a new dry run.", "CONFIRMATION_EXPIRED", 409);
  }
  return payload;
}

function normalizeSelection(recordIds) {
  if (!Array.isArray(recordIds) || recordIds.length === 0) {
    throw new BulkActionError("recordIds must be a non-empty array.");
  }
  if (recordIds.length > BULK_ACTION_MAX_RECORDS) {
    throw new BulkActionError(`At most ${BULK_ACTION_MAX_RECORDS} records may be selected.`);
  }

  const ids = recordIds.map((id) => typeof id === "string" ? id.trim() : "");
  if (ids.some((id) => !id)) throw new BulkActionError("Every selected record must have a string id.");
  if (new Set(ids).size !== ids.length) throw new BulkActionError("Duplicate record ids are not allowed.");
  return ids;
}

function normalizeEligibility(value) {
  if (value === true) return { eligible: true };
  if (value === false || !value) return { eligible: false, reason: "not_eligible" };
  if (typeof value !== "object" || typeof value.eligible !== "boolean") {
    throw new TypeError("isEligible must return a boolean or an { eligible, reason } result.");
  }
  return value;
}

function summarize(records) {
  return {
    total: records.length,
    eligibleCount: records.filter((record) => record.status === "eligible").length,
    failureCount: records.filter((record) => record.status !== "eligible").length,
    records,
  };
}

export async function runBulkAction({
  db,
  actor,
  action,
  recordIds,
  dryRun,
  confirmationToken,
  authorizeActor,
  resolveRecord,
  isEligible,
  revisionOf,
  applyRecord,
  now = () => new Date(),
  tokenSecret = process.env.BULK_ACTION_TOKEN_SECRET,
} = {}) {
  if (!db) throw new BulkActionError("A database handle is required.", "DB_REQUIRED", 500);
  const actorId = actorIdOf(actor);
  if (!actorId) throw new BulkActionError("An authenticated actor is required.", "ACTOR_REQUIRED", 401);
  if (typeof action !== "string" || !action.trim()) throw new BulkActionError("action is required.");
  if (typeof dryRun !== "boolean") throw new BulkActionError("dryRun must be a boolean.");
  if (typeof authorizeActor !== "function" || typeof resolveRecord !== "function" ||
      typeof isEligible !== "function" || typeof revisionOf !== "function" ||
      typeof applyRecord !== "function") {
    throw new BulkActionError("Bulk action authorization and record handlers are required.", "HANDLERS_REQUIRED", 500);
  }
  if (typeof tokenSecret !== "string" || tokenSecret.length < 32) {
    throw new BulkActionError(
      "BULK_ACTION_TOKEN_SECRET must be configured with at least 32 characters.",
      "CONFIRMATION_SECRET_MISSING",
      500,
    );
  }

  const authorized = await authorizeActor(actor, action);
  if (!authorized) throw new BulkActionError("Actor is not authorized for this bulk action.", "UNAUTHORIZED", 403);

  const ids = normalizeSelection(recordIds);
  const currentTime = now();
  if (!(currentTime instanceof Date) || Number.isNaN(currentTime.getTime())) {
    throw new TypeError("now must return a valid Date.");
  }

  const previewPayload = dryRun ? null : readConfirmationToken(confirmationToken, tokenSecret, currentTime);
  if (previewPayload && (
    previewPayload.actorId !== actorId ||
    previewPayload.action !== action ||
    JSON.stringify(previewPayload.recordIds) !== JSON.stringify(ids)
  )) {
    throw new BulkActionError("Confirmation token does not match this actor, action, and selection.", "CONFIRMATION_MISMATCH", 409);
  }

  const originalEligible = new Map((previewPayload?.eligible || []).map((item) => [item.id, item.revision]));
  const results = [];
  for (const id of ids) {
    const record = await resolveRecord(id);
    if (!record) {
      results.push({ id, status: "failed", reason: "not_found" });
      continue;
    }

    const eligibility = normalizeEligibility(await isEligible(record, actor, action));
    if (!eligibility.eligible) {
      results.push({ id, status: "failed", reason: eligibility.reason || "not_eligible" });
      continue;
    }

    const revision = String(await revisionOf(record));
    if (dryRun) {
      results.push({ id, status: "eligible", revision });
      continue;
    }

    if (!originalEligible.has(id)) {
      results.push({ id, status: "failed", reason: "not_eligible_at_preview" });
      continue;
    }
    if (originalEligible.get(id) !== revision) {
      results.push({ id, status: "failed", reason: "stale_selection" });
      continue;
    }
    results.push({ id, status: "eligible", revision, record });
  }

  if (dryRun) {
    const summary = summarize(results);
    const eligible = results
      .filter((record) => record.status === "eligible")
      .map(({ id, revision }) => ({ id, revision }));
    const token = eligible.length
      ? createConfirmationToken({
          actorId,
          action,
          recordIds: ids,
          eligible,
          expiresAt: currentTime.getTime() + BULK_ACTION_CONFIRMATION_TTL_MS,
          nonce: crypto.randomBytes(24).toString("base64url"),
        }, tokenSecret)
      : null;
    return { dryRun: true, ...summary, confirmationToken: token, expiresAt: token ? new Date(currentTime.getTime() + BULK_ACTION_CONFIRMATION_TTL_MS).toISOString() : null };
  }

  if (!originalEligible.size) {
    throw new BulkActionError("The confirmation token contains no eligible records.", "EMPTY_CONFIRMATION", 409);
  }

  const nonce = previewPayload.nonce;
  if (typeof nonce !== "string" || !nonce) {
    throw new BulkActionError("Confirmation token is invalid.", "INVALID_CONFIRMATION", 400);
  }
  try {
    await db.collection(BULK_ACTION_EXECUTIONS_COLLECTION).insertOne({
      _id: nonce,
      actorId,
      action,
      recordIds: ids,
      status: "running",
      startedAt: currentTime,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new BulkActionError("This confirmation token has already been used.", "DUPLICATE_EXECUTION", 409);
    }
    throw error;
  }

  const completedResults = [];
  for (const result of results) {
    if (result.status !== "eligible") {
      completedResults.push(result);
      continue;
    }
    try {
      const applied = await applyRecord(result.record, actor, action);
      completedResults.push({ id: result.id, status: "applied", result: applied ?? null });
    } catch (error) {
      completedResults.push({
        id: result.id,
        status: "failed",
        reason: error?.code || "apply_failed",
        message: String(error?.message || "Action failed").slice(0, 300),
      });
    }
  }

  await db.collection(BULK_ACTION_EXECUTIONS_COLLECTION).updateOne(
    { _id: nonce, status: "running" },
    {
      $set: {
        status: "completed",
        completedAt: now(),
        results: completedResults,
      },
    },
  );

  return {
    dryRun: false,
    total: completedResults.length,
    appliedCount: completedResults.filter((record) => record.status === "applied").length,
    failureCount: completedResults.filter((record) => record.status !== "applied").length,
    records: completedResults,
  };
}
