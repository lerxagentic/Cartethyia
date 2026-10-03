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
