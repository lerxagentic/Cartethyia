import { describe, expect, test } from "bun:test";
import { quotaRefreshSweep } from "../../src/workers/quota-refresh-worker";

const accountId = "00000000-0000-4000-8000-000000000101";

/** Minimal cache/DB seams used by the sweep; no provider network is involved. */
function harness() {
  const receivedCredentials: string[] = [];
  let resolutions = 0;
  const redis = {
    async mget(..._keys: string[]) { return _keys.map(() => null); },
    async set(..._args: unknown[]) { return "OK"; },
    async get() { return null; },
  };
  const db = {
    update() {
      return { set: () => ({ where: async () => undefined }) };
    },
  };
  return {
    receivedCredentials,
    deps: {
      db,
      redis,
      providerRegistry: {
        async resolveRefresher() { return { refresh: async () => ({ access: "unused", expiresAt: new Date() }) }; },
        async resolveQuotaCollector() {
          return async (credential: string) => {
            receivedCredentials.push(credential);
            return { source: "kiro", plan: "test", windows: [], error: null };
          };
        },
      },
      async resolveCredential() { return `access-${++resolutions}`; },
      async listTargets() {
        return [{ accountId, providerId: "kiro", tenantId: "tenant", credentialKind: "oauth", authState: {} }];
      },
      minAgeMs: 0,
      maxPerPass: 1,
      maxCheckinsPerPass: 0,
    },
  };
}

describe("quota refresh credential freshness", () => {
  test("resolves an OAuth access token again on the next sweep", async () => {
    const { deps, receivedCredentials } = harness();

    await quotaRefreshSweep(deps as never);
    await quotaRefreshSweep(deps as never);

    expect(receivedCredentials).toEqual(["access-1", "access-2"]);
  });
});
