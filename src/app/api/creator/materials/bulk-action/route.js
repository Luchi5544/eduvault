export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { requirePermission } from "@/lib/api/auth";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import {
  enqueueMaterialSearchDeletion,
  enqueueMaterialSearchProjection,
  getMaterialSearchVersion,
} from "@/lib/backend/materialSearchProjection";
import { invalidateCatalogCache } from "@/lib/cache/redis";
import { getDb } from "@/lib/mongodb";
import { runBulkAction, BulkActionError } from "@/lib/backend/bulkActionFramework";

function normalizedAddress(user) {
  return String(user?.walletAddress || user?.address || user?.walletAddressLower || "").trim().toLowerCase();
}

function materialRevision(material) {
  return JSON.stringify({
    version: material.version ?? null,
    searchVersion: material.searchVersion ?? null,
    updatedAt: material.updatedAt ? new Date(material.updatedAt).toISOString() : null,
    userAddress: material.userAddress ?? null,
    creatorId: material.creatorId ?? null,
    archived: material.archived === true,
    isDeleted: material.isDeleted === true,
    legalTombstone: material.legalTombstone === true,
  });
}

export async function POST(request) {
  return withApiHardening(
    request,
    { route: "creator-materials-bulk-action", rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
      const authorization = await requirePermission(request, "creator:manage");
      if (!authorization.ok) {
        return NextResponse.json({ error: "Creator access required" }, { status: authorization.status });
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      if (!["archive", "restore"].includes(body?.action)) {
        return NextResponse.json({ error: 'action must be "archive" or "restore".' }, { status: 400 });
      }

      try {
        const user = authorization.user;
        const db = await getDb();
        const ownerAddress = normalizedAddress(user);
        const result = await runBulkAction({
          db,
          actor: user,
          action: body.action,
          recordIds: body.recordIds,
          dryRun: body.dryRun,
          confirmationToken: body.confirmationToken,
          authorizeActor: (actor) => Boolean(actor.sub || actor.id) && Boolean(ownerAddress),
          resolveRecord: (id) => ObjectId.isValid(id)
            ? db.collection("materials").findOne({ _id: new ObjectId(id) })
            : null,
          isEligible: (material, actor, action) => {
            const creatorId = String(material.creatorId || "");
            const materialOwner = String(
              material.userAddress || material.ownerAddress || material.creatorAddress || "",
            ).trim().toLowerCase();
            const actorOwnsRecord =
              (ownerAddress && materialOwner === ownerAddress) ||
              (creatorId && creatorId === String(actor.sub || actor.id));
            if (!actorOwnsRecord) return { eligible: false, reason: "not_owner" };
            if (material.isDeleted === true) return { eligible: false, reason: "deleted" };
            if (
              material.legalTombstone === true ||
              material.legalRemovedAt !== undefined ||
              material.legalRemovalId !== undefined
            ) {
              return { eligible: false, reason: "legal_tombstone" };
            }
            if (action === "archive" && material.archived === true) {
              return { eligible: false, reason: "already_archived" };
            }
            if (action === "restore" && material.archived !== true) {
              return { eligible: false, reason: "not_archived" };
            }
            return { eligible: true };
          },
          revisionOf: materialRevision,
          applyRecord: async (material, actor, action) => {
            const now = new Date();
            const archived = action === "archive";
            const searchVersion = getMaterialSearchVersion(material) + 1;
            const update = {
              archived,
              archivedAt: archived ? now : null,
              updatedAt: now,
              updatedBy: ownerAddress,
              version: Number(material.version || 1) + 1,
              searchVersion,
              searchVisibility: archived ? "hidden" : "public",
            };
            const write = await db.collection("materials").updateOne(
              {
                _id: material._id,
                searchVersion: material.searchVersion ?? null,
                version: material.version ?? null,
                archived: material.archived ?? null,
              },
              { $set: update },
            );
            if (write.matchedCount !== 1) {
              const error = new Error("Material changed after eligibility was checked.");
              error.code = "stale_selection";
              throw error;
            }

            const updatedMaterial = { ...material, ...update };
            if (archived) {
              await enqueueMaterialSearchDeletion({
                db,
                material: updatedMaterial,
                reason: "bulk_material_archived",
                now,
              });
            } else {
              await enqueueMaterialSearchProjection({
                db,
                material: updatedMaterial,
                reason: "bulk_material_restored",
                now,
              });
            }
            await invalidateCatalogCache();
            auditLog({
              event: archived ? "bulk_material_archived" : "bulk_material_restored",
              route: "creator/materials/bulk-action",
              method: "POST",
              status: 200,
              actor: actor.sub || actor.id,
              materialId: String(material._id),
            });
            return { archived, materialId: String(material._id) };
          },
        });

        return NextResponse.json(result, { status: 200 });
      } catch (error) {
        if (error instanceof BulkActionError) {
          return NextResponse.json(
            { error: error.message, code: error.code },
            { status: error.status },
          );
        }
        auditLog({
          event: "bulk_material_action_failed",
          route: "creator/materials/bulk-action",
          method: "POST",
          status: 500,
          reason: error.message,
        });
        return NextResponse.json({ error: "Bulk action failed" }, { status: 500 });
      }
    },
  );
}
