import { afterEach, describe, expect, test } from "bun:test";
import { decryptCredentialToString, setCredentialEncryptionKeyForTesting } from "../../src/security/crypto";
import { convert9RouterBackup } from "../../src/console/backup/nine-router";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";

function configRows(result: ReturnType<typeof convert9RouterBackup>) {
  return result.payload.sections.config as Record<string, Array<Record<string, unknown>>>;
}

afterEach(() => setCredentialEncryptionKeyForTesting(undefined));

describe("9Router Kiro OAuth backup conversion", () => {
  test("preserves an imported Kiro access token, refresh token, expiry, and dispatch auth state", () => {
    setCredentialEncryptionKeyForTesting(Buffer.alloc(32, 7));

    const result = convert9RouterBackup(
      {
        providerConnections: [
          {
            provider: "kiro",
            name: "Kiro imported account",
            accessToken: "access-token-for-test",
            refreshToken: "refresh-token-for-test",
            expiresAt: "2026-10-05T12:00:00.000Z",
            isActive: true,
            providerSpecificData: {
              authMethod: "imported",
              profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/TESTPROFILE",
            },
          },
        ],
      },
      TENANT_ID,
    );
    const config = configRows(result);
    const account = config.provider_accounts?.[0];
    const oauth = config.provider_oauth_states?.[0];

    expect(account).toMatchObject({
      provider_id: "kiro",
      tenant_id: TENANT_ID,
      credential_kind: "oauth",
      status: "active",
      auth_state: {
        authMethod: "imported",
        region: "us-east-1",
        profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/TESTPROFILE",
      },
    });
    expect(decryptCredentialToString(Buffer.from((account?.credential_ciphertext as { __bytes: string }).__bytes, "base64"))).toBe(
      "access-token-for-test",
    );
    expect(oauth).toMatchObject({
      provider_account_id: account?.id,
      expires_at: { __date: "2026-10-05T12:00:00.000Z" },
    });
    expect(decryptCredentialToString(Buffer.from((oauth?.refresh_ciphertext as { __bytes: string }).__bytes, "base64"))).toBe(
      "refresh-token-for-test",
    );
    expect(result.report.skipped).toEqual([]);
  });
});

describe("9Router full provider import", () => {
  test("maps codebuddy-intl, gcli, oc; imports dahl BYOK; honours providerAlias custom models", () => {
    setCredentialEncryptionKeyForTesting(Buffer.alloc(32, 7));

    const result = convert9RouterBackup(
      {
        providerConnections: [
          { provider: "codebuddy-intl", name: "cb account", apiKey: "cb-key", isActive: true },
          { provider: "dahl", name: "dahl account", apiKey: "dahl_abc", isActive: true },
          { provider: "grok-cli", name: "grok refresh account", accessToken: "xoxp-token", refreshToken: "grok-refresh", expiresAt: "2027-01-01T00:00:00Z", isActive: true },
        ],
        customModels: [{ providerAlias: "cbai", id: "glm-5.3", type: "llm", name: "glm-5.3" }],
      },
      TENANT_ID,
    );
    const config = configRows(result);

    const providerIds = (config.provider_accounts ?? []).map((r: Record<string, unknown>) => r.provider_id);
    expect(providerIds).toContain("cb");
    expect(providerIds).toContain("dahl");
    expect(providerIds).toContain("grok");
    // dahl BYOK provider node synthesized
    expect(config.providers?.[0]).toMatchObject({ id: "dahl", base_url: "https://inference.dahl.global" });
    // grok oauth state imported
    expect(config.provider_oauth_states).toHaveLength(1);
    // customModels honored through providerAlias
    const customModelIds = (config.models ?? []).map((r: Record<string, unknown>) => r.model_id);
    expect(customModelIds).toContain("glm-5.3");
  });
});
