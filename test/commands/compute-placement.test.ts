import { describe, expect, it } from "vitest";
import { buildPlacementRequest } from "../../src/commands/compute-placement.js";
import { UserError } from "../../src/errors.js";

describe("buildPlacementRequest", () => {
  it("returns undefined when no placement flags are given", () => {
    expect(buildPlacementRequest({})).toBeUndefined();
  });

  it("requires --provider once any placement flag is used", () => {
    expect(() =>
      buildPlacementRequest({
        regionId: "11111111-1111-1111-1111-111111111111",
      }),
    ).toThrow(UserError);
  });

  it("rejects an unknown provider", () => {
    expect(() => buildPlacementRequest({ provider: "azure" })).toThrow(
      UserError,
    );
  });

  it("rejects an unknown fallback mode", () => {
    expect(() =>
      buildPlacementRequest({ provider: "miosa", fallback: "retry" }),
    ).toThrow(UserError);
  });

  it("rejects a non-UUID region id fast, client-side", () => {
    expect(() =>
      buildPlacementRequest({ provider: "aws", regionId: "not-a-uuid" }),
    ).toThrow(UserError);
  });

  it("builds a minimal miosa placement request", () => {
    expect(buildPlacementRequest({ provider: "miosa" })).toEqual({
      provider: "miosa",
    });
  });

  it("builds a full aws placement request with fallback", () => {
    const regionId = "11111111-1111-1111-1111-111111111111";
    const poolId = "22222222-2222-2222-2222-222222222222";
    expect(
      buildPlacementRequest({
        provider: "aws",
        regionId,
        poolId,
        fallback: "miosa",
      }),
    ).toEqual({
      provider: "aws",
      region_id: regionId,
      pool_id: poolId,
      fallback: "miosa",
    });
  });

  it("builds an opencomputers placement request with a host id", () => {
    const hostId = "33333333-3333-3333-3333-333333333333";
    expect(
      buildPlacementRequest({ provider: "opencomputers", hostId }),
    ).toEqual({
      provider: "opencomputers",
      host_id: hostId,
    });
  });

  // The CLI intentionally does not duplicate server business rules (e.g. aws/gcp
  // requiring region+pool, opencomputers being unimplemented) -- it only checks
  // shape. Confirm a request the server will reject for business reasons still
  // passes CLI-side validation and reaches the request body unchanged.
  it("does not duplicate server-side target compatibility rules", () => {
    expect(buildPlacementRequest({ provider: "aws" })).toEqual({
      provider: "aws",
    });
  });
});
