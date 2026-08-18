// AI "what should Kapruka's price actually be" step for the Price Checker.
// Runs automatically on every single-product search that has both a Kapruka
// price and at least one competitor price to compare against -- Checker-only
// by design, and cheap enough (one call per search a person actually makes)
// to just always run, with no manual trigger needed.

import OpenAI from 'openai';

const MODEL = process.env.MATCH_MODEL || 'gpt-4o-mini';
let client = null;
function getClient() {
  if (!client) client = new OpenAI();
  return client;
}

// Neither `verdict` nor `idealPriceLkr` is something the model decides --
// both are plain arithmetic over the scraped competitor prices, no judgment
// call involved. Asking the model for verdict once produced a verdict of
// "underpriced" alongside reasoning that said Kapruka's LKR 1000 was "lower"
// than a LKR 549 competitor -- backwards. Leaving idealPriceLkr to the model
// has the same failure mode: it's the model doing its own subtraction
// ("just under LKR 549") which it can get wrong the same way, and there's no
// need to trust an LLM with arithmetic real code can do exactly. Computing
// both ourselves and handing them to the model as established facts makes
// that whole failure class structurally impossible; the model's only job is
// to write a sentence explaining a number it didn't choose.
const PRICE_INSIGHT_FN = {
  name: 'report_price_insight',
  description: 'Explain, in plain language, the already-computed ideal price Kapruka should set for this product.',
  parameters: {
    type: 'object',
    properties: {
      reasoning: { type: 'string', description: 'One or two sentences, plain language, for a non-technical team member.' },
    },
    required: ['reasoning'],
    additionalProperties: false,
  },
};

// Within this fraction of the cheapest competitor counts as "already
// competitive" rather than meaningfully over/under -- same idea as
// matcher.js's SAME_PRICE_TOLERANCE, just a bit more generous since this is
// a human-facing judgment call, not an exact-match filter.
const COMPETITIVE_TOLERANCE = 0.02;
function computeVerdict(kaprukaPrice, competitors) {
  const cheapest = Math.min(...competitors.map((c) => c.price));
  const diff = kaprukaPrice - cheapest;
  if (Math.abs(diff) <= cheapest * COMPETITIVE_TOLERANCE) return 'competitive';
  return diff > 0 ? 'overpriced' : 'underpriced';
}

// A single competitor at a small fraction of the rest looks like a
// clearance/liquidation listing, not the real going market rate -- anchoring
// against it would recommend a price Kapruka can't sustain. When that
// happens anchor off the median of all competitor prices instead of the
// single cheapest one.
const OUTLIER_FRACTION_OF_MEDIAN = 0.5;
// Undercut the anchor by 1%, minimum LKR 1, so the recommendation is always
// strictly below a real competitor price rather than tying it.
const UNDERCUT_FRACTION = 0.01;

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Deterministic replacement for what used to be the model's own arithmetic.
// Returns { idealPriceLkr, anchor, isOutlier } -- anchor/isOutlier are only
// exposed so the prompt can tell the model which case applied.
function computeIdealPrice(competitors) {
  const prices = competitors.map((c) => c.price);
  const cheapest = Math.min(...prices);
  const mid = median(prices);
  const isOutlier = prices.length > 1 && cheapest < mid * OUTLIER_FRACTION_OF_MEDIAN;
  const anchor = isOutlier ? mid : cheapest;
  if (isOutlier) return { idealPriceLkr: Math.round(anchor), anchor, isOutlier };
  const margin = Math.max(1, Math.round(anchor * UNDERCUT_FRACTION));
  return { idealPriceLkr: Math.round(anchor) - margin, anchor, isOutlier };
}

/**
 * kaprukaRef: { name, price, url } | null -- null when Kapruka doesn't carry this product at all (a plain
 *   query with no database or live catalogue match). The insight still runs in that case: with no Kapruka
 *   price to compare against there's no over/underpriced verdict, but competitor prices alone are enough to
 *   suggest a launch price, which is exactly the "change from product to product, every search" behavior
 *   this feature is meant to have -- it shouldn't go silent just because Kapruka hasn't listed the item yet.
 * competitors: [{ site, price, matchRate }] -- only rows with a real price and 'ok'/'low_confidence' status
 *   should be passed in; low-confidence matches are still useful context but the prompt is told which is which.
 * Returns null if there's nothing to compare (no competitor prices) -- caller should skip the whole feature
 * rather than call this with an empty list.
 */
export async function recommendPrice(kaprukaRef, competitors) {
  if (!competitors.length) return null;
  // Both computed up front (not left to the model) and handed to it as
  // established facts, so its reasoning prose explains them instead of
  // potentially re-deriving and contradicting them.
  const hasKaprukaPrice = kaprukaRef?.price != null;
  const verdict = hasKaprukaPrice ? computeVerdict(kaprukaRef.price, competitors) : 'not_listed';
  const { idealPriceLkr, anchor, isOutlier } = computeIdealPrice(competitors);
  const lines = competitors
    .map((c) => `- ${c.site}: LKR ${c.price}${c.matchRate != null ? ` (match confidence ${c.matchRate}%)` : ''}`)
    .join('\n');
  const anchorNote = isOutlier
    ? `The cheapest listing (LKR ${Math.min(...competitors.map((c) => c.price))}) looks like an unsustainable ` +
      `clearance price compared to the rest, so the target is anchored to the market median of LKR ${anchor} instead.`
    : `The target undercuts the cheapest competitor price of LKR ${anchor} to stay the best deal.`;
  const kaprukaLine = hasKaprukaPrice
    ? `Kapruka product: "${kaprukaRef.name}"\nKapruka's current price: LKR ${kaprukaRef.price}\n\n`
    : `Kapruka does not currently sell this product -- there is no existing Kapruka price to compare against.\n\n`;
  const verdictLine = hasKaprukaPrice
    ? `Verdict (already determined, do not contradict it): Kapruka is "${verdict}" relative to the cheapest ` +
      `competitor price.\n\n`
    : `Verdict (already determined, do not contradict it): this product is "not_listed" on Kapruka -- write the ` +
      `reasoning as a suggested launch price if Kapruka were to start selling it.\n\n`;
  const content =
    kaprukaLine +
    `Competitor prices found for this same product:\n${lines}\n\n` +
    verdictLine +
    `Ideal price (already computed, do not propose a different number): LKR ${idealPriceLkr}. ${anchorNote}\n\n` +
    `Write the reasoning for this recommendation. Call report_price_insight.`;
  try {
    const res = await getClient().chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content }],
      tools: [{ type: 'function', function: PRICE_INSIGHT_FN }],
      tool_choice: { type: 'function', function: { name: 'report_price_insight' } },
    });
    const call = res.choices?.[0]?.message?.tool_calls?.[0];
    const reasoning = call ? JSON.parse(call.function.arguments).reasoning || '' : '';
    return { verdict, idealPriceLkr, reasoning };
  } catch {
    // Best-effort on the AI reasoning only -- the price itself is plain
    // arithmetic and doesn't need the model, so still return it.
    return { verdict, idealPriceLkr, reasoning: '' };
  }
}
