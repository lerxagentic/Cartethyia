import { expect, test } from "bun:test";
import { quotaTargetForAccount } from "../../src/console/quota/account-quota-shared";

test("quota refresh target preserves provider OAuth auth state", () => {
  const authState = { profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/test", region: "us-east-1" };
  const target = quotaTargetForAccount({
    id: "00000000-0000-4000-8000-000000000001",
    providerId: "kiro",
    tenantId: "00000000-0000-4000-8000-000000000002",
    credentialKind: "oauth",
    authState,
  });

  expect(target).toEqual({
    accountId: "00000000-0000-4000-8000-000000000001",
    providerId: "kiro",
    tenantId: "00000000-0000-4000-8000-000000000002",
    credentialKind: "oauth",
    authState,
  });
});
