/**
 * Every LLM model a provider's catalog declares must publish BOTH a context
 * (input) and an output limit.
 *
 * The provider page renders one metadata line per model card as
 * `X ctx · Y out`. A row with a null output rendered `168k ctx · n/a out`
 * directly beside rows that all showed a number, which reads as a broken
 * catalog rather than as genuinely-unknown metadata. For a *static* catalog the
 * maintainers own both numbers, so an omission there is a defect, not a
 * discovery gap — the discovered rows are a separate concern because upstream
 * may simply not publish a value.
 *
 * This pins the rule for the hand-written catalogs so a new roster entry that
 * forgets its output ceiling fails here instead of shipping an `n/a` card.
 */
import { describe, expect, test } from "bun:test";
import { CODEBUDDY_MODELS } from "../../src/providers/integrations/buddy/codebuddy";
import { WORKBUDDY_MODELS } from "../../src/providers/integrations/buddy/workbuddy";
import { CODEBUDDY_CN_MODELS } from "../../src/providers/integrations/buddy/codebuddy-cn";

const CATALOGS: ReadonlyArray<readonly [string, readonly { modelId: string; serviceKind?: string; contextLimit: number | null; outputLimit: number | null }[]]> = [
  ["cb", CODEBUDDY_MODELS],
  ["workbuddy", WORKBUDDY_MODELS],
  ["cbcn", CODEBUDDY_CN_MODELS],
];

describe("static provider catalogs publish both limits", () => {
  for (const [providerId, models] of CATALOGS) {
    test(`${providerId}: every llm model has a context and an output limit`, () => {
      const llm = models.filter((model) => (model.serviceKind ?? "llm") === "llm");
      expect(llm.length).toBeGreaterThan(0);
      const missing = llm
        .filter((model) => model.contextLimit == null || model.outputLimit == null)
        .map((model) => `${model.modelId}(ctx=${model.contextLimit}, out=${model.outputLimit})`);
      expect(missing).toEqual([]);
    });
  }

  test("the `auto` alias carries an output ceiling, not just a context window", () => {
    // Regression: `auto` was declared with a null output, which rendered the
    // only `n/a out` card in an otherwise complete catalog.
    for (const [providerId, models] of CATALOGS) {
      const auto = models.find((model) => model.modelId === "auto");
      if (!auto) continue;
      expect(auto.outputLimit, `${providerId}/auto output limit`).toBeGreaterThan(0);
      expect(auto.contextLimit, `${providerId}/auto context limit`).toBeGreaterThan(0);
    }
  });
});
