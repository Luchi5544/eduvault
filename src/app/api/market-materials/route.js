// Resolves: Implement the endpoint to retrieve and paginate the list of available educational materials.

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { parsePagination } from "@/lib/api/validation";
import { applyMarketplaceRelevanceRanking, applyOwnershipRanking, buildMarketplaceDiscoveryQuery, buildMarketplaceFacetPipeline, buildMarketplaceSort, decodeMarketplaceCursor, encodeMarketplaceCursor, buildMarketplaceCursorClause } from "@/lib/backend/marketplaceDiscovery";
import { buildMaterialSearchDocument, buildPublicMaterialQuery, getMaterialSearchVersion } from "@/lib/backend/materialSearchProjection";
import { getOwnedMaterialIds } from "@/lib/entitlement";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { cacheDel, cacheGet, cacheSet, catalogCacheKey } from "@/lib/cache/redis";

import { sanitizeMaterialPublic } from "@/lib/storage/protectedStorage";

export const runtime = "nodejs";

function sanitizeMaterial(doc) {
  if (!doc) return doc;
  const publicSafe = sanitizeMaterialPublic(doc);
  const { storageKey, fileUrl, metadataUrl, ...safe } = publicSafe;
  const averageScore = Number(safe.averageScore ?? safe.rating ?? 0) || 0;
  const feedbackCount = Number(safe.feedbackCount ?? safe.reviewsCount ?? 0) || 0;

  return {
    ...safe,
    averageScore,
    rating: averageScore,
    feedbackCount,
    reviewsCount: feedbackCount,
    userAddress: safe.userAddress ?? safe.ownerAddress ?? null,
  };
}

function sourceIdQuery(value) {
  const id = String(value ?? "");
  return ObjectId.isValid(id)
    ? { $or: [{ _id: new ObjectId(id) }, { materialId: id }] }
    : { $or: [{ _id: id }, { materialId: id }] };
}

async function isCurrentPublicCatalogCache(db, cached, query) {
  if (!Array.isArray(cached?.items)) return false;
  if (!Number.isSafeInteger(cached.total) || cached.total !== await db.collection("materials").countDocuments(query)) {
    return false;
  }
  if (cached.items.length === 0) return true;

  const currentMaterials = await Promise.all(cached.items.map(async (item) => {
    const id = item?.materialId ?? item?._id;
    if (!id) return null;
    return db.collection("materials").findOne({
      $and: [sourceIdQuery(id), buildPublicMaterialQuery()],
    });
  }));

  return currentMaterials.every((material, index) => {
    const cachedItem = cached.items[index];
    if (!material || !Number.isSafeInteger(Number(cachedItem?.projectionVersion))) return false;
    return Number(cachedItem.projectionVersion) === getMaterialSearchVersion(material);
  });
}

// GET /api/market-materials
// Returns all public materials across users, newest first
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "market-materials", rateLimit: { limit: 120, windowMs: 60_000 } },
    async () => {
  try {
    const db = await getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    // 1️⃣ Handle single material fetch
    if (id) {
      if (!ObjectId.isValid(id)) {
        return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
      }
      
      const item = await db.collection("materials").findOne({
        $and: [{ _id: new ObjectId(id) }, buildPublicMaterialQuery()],
      });

      if (!item) {
        return NextResponse.json({ error: "Material not found" }, { status: 404 });
      }

      return NextResponse.json(sanitizeMaterial(buildMaterialSearchDocument(item)));
    }

    // 2️⃣ Handle list fetch
    const pagination = parsePagination(url.searchParams);
    const { pageSize, paginationType } = pagination;

    // Entitlement-aware ranking (#707): when the viewing wallet is supplied,
    // results are personalized (owned materials marked/reranked), so the
    // shared anonymous-browse cache is bypassed for this request.
    const buyerAddress = (url.searchParams.get("buyerAddress") || "").trim() || null;

    const query = buildMarketplaceDiscoveryQuery(url.searchParams);
    const searchTerm = url.searchParams.get("search") || "";
    const sortBy = url.searchParams.get("sortBy") || (searchTerm ? "relevance" : "newest");
    const sort = buildMarketplaceSort(sortBy);
    const facetsRequested = ["1", "true"].includes(url.searchParams.get("includeFacets"));
    const facetQuery = facetsRequested ? buildMarketplaceDiscoveryQuery(url.searchParams) : null;
    const cacheKey = await catalogCacheKey(url.searchParams.toString());
    const canUseCatalogCache = !buyerAddress && paginationType === "offset" && !facetsRequested;
    const cached = canUseCatalogCache ? await cacheGet(cacheKey) : null;
    if (cached) {
      if (await isCurrentPublicCatalogCache(db, cached, query)) {
        return NextResponse.json(cached, { status: 200 });
      }
      await cacheDel(cacheKey);
    }

    let items;
    let hasNextPage = false;
    let nextCursor = null;
    let totalPages = null;
    let total = null;
    let facets = null;

    if (paginationType === "cursor") {
      // Cursor-based pagination
      const { cursor } = pagination;
      
      // Add cursor filter to query if provided
      if (cursor) {
        try {
          const cursorData = decodeMarketplaceCursor(cursor, sort);
          query.$and = query.$and || [];
          query.$and.push(buildMarketplaceCursorClause(cursorData, sort));
        } catch {
          return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
        }
      }

      // Fetch pageSize + 1 to determine if there's a next page
      items = await db
        .collection("materials")
        .find(query)
        .sort(sort)
        .limit(pageSize + 1)
        .toArray();

      // Check if there's a next page
      hasNextPage = items.length > pageSize;
      if (hasNextPage) {
        items = items.slice(0, pageSize); // Remove the extra item
      }

      // Generate next cursor if there are more items
      if (hasNextPage && items.length > 0) {
        const lastItem = items[items.length - 1];
        nextCursor = encodeMarketplaceCursor(lastItem, sort);
      }
    } else {
      // Legacy offset-based pagination
      const { page } = pagination;
      
      total = await db.collection("materials").countDocuments(query);
      items = await db
        .collection("materials")
        .find(query)
        .sort(sort)
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray();

      totalPages = Math.max(1, Math.ceil(total / pageSize));
    }

    let normalized = items
      .map((item) => buildMaterialSearchDocument(item))
      .filter(Boolean)
      .map(sanitizeMaterial);

    if (searchTerm || sortBy === "relevance") {
      normalized = applyMarketplaceRelevanceRanking(normalized, searchTerm);
    }

    if (facetsRequested) {
      const facetRows = await db
        .collection("materials")
        .aggregate(buildMarketplaceFacetPipeline(facetQuery))
        .toArray();
      facets = Object.fromEntries(Object.entries(facetRows[0] || {}).map(([field, values]) => [
        field,
        values.map(({ _id: value, count }) => ({ value, count })),
      ]));
    }

    // Entitlement-aware ranking (#707): mark and rerank this page's results
    // by whether the viewing wallet already owns each material. Best-effort
    // — a lookup failure just leaves the page unranked, never blocks it.
    if (buyerAddress) {
      const materialIds = normalized
        .map((item) => String(item.materialId ?? item._id ?? ""))
        .filter(Boolean);
      const ownedIds = await getOwnedMaterialIds({ db, buyerAddress, materialIds });
      normalized = applyOwnershipRanking(normalized, ownedIds);
    }

    const payload = paginationType === "cursor"
      ? {
          items: normalized,
          pageSize,
          hasNextPage,
          nextCursor,
          ...(facets ? { facets } : {}),
          paginationType: "cursor"
        }
      : {
          items: normalized,
          page: pagination.page,
          pageSize,
          total,
          totalPages,
          ...(facets ? { facets } : {}),
          paginationType: "offset"
        };

    if (canUseCatalogCache) {
      await cacheSet(cacheKey, payload, 600);
    }

    return NextResponse.json(payload, { status: 200 });
  } catch (err) {
    if (err.name === "ValidationError") throw err;
    auditLog({ event: "market_materials_failed", route: "market-materials", method: "GET", status: 500, reason: err.message });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
    }
  );
}
