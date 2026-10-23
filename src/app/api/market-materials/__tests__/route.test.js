import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "../route";

const { mockGetDb, mockCacheGet, mockCacheSet, mockCacheDel, mockGetOwnedMaterialIds } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockCacheGet: vi.fn(),
  mockCacheSet: vi.fn(),
  mockCacheDel: vi.fn(),
  mockGetOwnedMaterialIds: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({ getDb: mockGetDb }));
vi.mock("@/lib/cache/redis", () => ({
  cacheGet: mockCacheGet,
  cacheSet: mockCacheSet,
  cacheDel: mockCacheDel,
  catalogCacheKey: async (query) => `market-materials:v0:${query}`,
}));
vi.mock("@/lib/entitlement", () => ({ getOwnedMaterialIds: mockGetOwnedMaterialIds }));

const BUYER = "gbuyer123";

function makeMaterial(materialId, overrides = {}) {
  return {
    _id: materialId,
    materialId,
    title: `Material ${materialId}`,
    visibility: "public",
    price: 10,
    createdAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function matches(doc, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === "$and") return expected.every((clause) => matches(doc, clause));
    if (key === "$or") return expected.some((clause) => matches(doc, clause));
    const value = doc[key];
    if (expected instanceof RegExp) return expected.test(String(value ?? ""));
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const operatorKeys = Object.keys(expected).filter((operator) => operator.startsWith("$"));
      if (operatorKeys.length === 0) return String(value) === String(expected);
      if ("$ne" in expected && value === expected.$ne) return false;
      if ("$nin" in expected && expected.$nin.includes(value)) return false;
      if ("$exists" in expected && (value !== undefined) !== expected.$exists) return false;
      if ("$gte" in expected && !(value >= expected.$gte)) return false;
      if ("$lte" in expected && !(value <= expected.$lte)) return false;
      return true;
    }
    return value === expected;
  });
}

function fakeMaterialsCollection(docs) {
  return {
    find: (query = {}) => {
      let results = docs.filter((doc) => matches(doc, query));
      return {
        sort: () => ({
          limit: (limit) => ({ toArray: async () => results.slice(0, limit) }),
          skip: (skip) => ({
            limit: (limit) => ({ toArray: async () => results.slice(skip, skip + limit) }),
          }),
        }),
      };
    },
    findOne: async (query = {}) => docs.find((doc) => matches(doc, query)) || null,
    countDocuments: async (query = {}) => docs.filter((doc) => matches(doc, query)).length,
  };
}

function makeRequest(params = {}) {
  const search = new URLSearchParams(params);
  return new Request(`http://localhost:3000/api/market-materials?${search.toString()}`);
}

describe("GET /api/market-materials — entitlement-aware ranking (#707)", () => {
  const docs = [
    makeMaterial("m1", { version: 1 }),
    makeMaterial("m2", { version: 1 }),
    makeMaterial("m3", { version: 1 }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    mockCacheDel.mockResolvedValue(undefined);
    mockGetDb.mockResolvedValue({
      collection: (name) => name === "materials"
        ? fakeMaterialsCollection(docs)
        : { aggregate: () => ({ toArray: async () => [{}] }) },
    });
    mockGetOwnedMaterialIds.mockResolvedValue(new Set());
  });

  it("does not call getOwnedMaterialIds or mark items when no buyerAddress is given", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(mockGetOwnedMaterialIds).not.toHaveBeenCalled();
    expect(body.items.every((item) => item.owned === undefined)).toBe(true);
    // Anonymous browsing still benefits from the shared cache.
    expect(mockCacheSet).toHaveBeenCalledTimes(1);
  });

  it("serves a hot catalog query without touching MongoDB", async () => {
    mockCacheGet.mockResolvedValueOnce({
      items: [{ ...makeMaterial("m1"), projectionVersion: 1 }],
      total: 3,
      paginationType: "offset",
    });
    const res = await GET(makeRequest({ page: '1' }));
    expect(res.status).toBe(200);
    expect((await res.json()).items[0].materialId).toBe("m1");
    expect(mockGetDb).toHaveBeenCalledOnce();
    expect(mockCacheDel).not.toHaveBeenCalled();
  });

  it("rejects stale cached entries when the source material becomes private", async () => {
    const docsWithPrivate = [
      makeMaterial("m1", { visibility: "private", version: 2 }),
      ...docs.slice(1),
    ];
    mockGetDb.mockResolvedValue({
      collection: (name) => name === "materials"
        ? fakeMaterialsCollection(docsWithPrivate)
        : { aggregate: () => ({ toArray: async () => [{}] }) },
    });
    mockCacheGet.mockResolvedValueOnce({
      items: [{ ...makeMaterial("m1"), projectionVersion: 1 }],
      total: 3,
      paginationType: "offset",
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).items.map((item) => item.materialId)).toEqual(["m2", "m3"]);
    expect(mockCacheDel).toHaveBeenCalledOnce();
  });

  it("excludes restricted records from public search", async () => {
    const privateDocs = [
      ...docs,
      makeMaterial("private", { visibility: "private" }),
      makeMaterial("removed", { moderationStatus: "removed" }),
      makeMaterial("deleted", { isDeleted: true }),
    ];
    mockGetDb.mockResolvedValue({
      collection: (name) => name === "materials"
        ? fakeMaterialsCollection(privateDocs)
        : { aggregate: () => ({ toArray: async () => [{}] }) },
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).items.map((item) => item.materialId)).toEqual(["m1", "m2", "m3"]);
  });

  it("does not return a private material through direct lookup", async () => {
    const id = "507f1f77bcf86cd799439011";
    const privateMaterial = { ...makeMaterial(id, { visibility: "private" }), _id: { toString: () => id } };
    mockGetDb.mockResolvedValue({
      collection: () => fakeMaterialsCollection([privateMaterial]),
    });

    const res = await GET(makeRequest({ id }));
    expect(res.status).toBe(404);
  });

  it("marks owned materials and reranks them after not-owned ones", async () => {
    mockGetOwnedMaterialIds.mockResolvedValue(new Set(["m2"]));

    const res = await GET(makeRequest({ buyerAddress: BUYER }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(mockGetOwnedMaterialIds).toHaveBeenCalledWith(
      expect.objectContaining({ buyerAddress: BUYER, materialIds: ["m1", "m2", "m3"] })
    );
    expect(body.items.map((item) => item.materialId)).toEqual(["m1", "m3", "m2"]);
    expect(body.items.map((item) => item.owned)).toEqual([false, false, true]);
  });

  it("bypasses the shared cache for a personalized (buyerAddress) request", async () => {
    await GET(makeRequest({ buyerAddress: BUYER }));

    expect(mockCacheGet).not.toHaveBeenCalled();
    expect(mockCacheSet).not.toHaveBeenCalled();
  });

  it("still returns results if the ownership lookup fails to resolve owned ids", async () => {
    mockGetOwnedMaterialIds.mockResolvedValue(new Set());

    const res = await GET(makeRequest({ buyerAddress: BUYER }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(3);
    expect(body.items.every((item) => item.owned === false)).toBe(true);
  });
});
