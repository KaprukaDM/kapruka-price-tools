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

// `verdict` is deliberately NOT something the model decides (see below) --
// it's a plain numeric comparison (Kapruka's price vs. the cheapest
// competitor), no judgment call involved. Asking the model for it anyway
// risks exactly what showed up live: a verdict of "underpriced" alongside
// reasoning text that said Kapruka's price was "lower than the competitor"
// when Kapruka was actually LKR 1000 against a LKR 549 competitor -- higher,
// not lower. The recommended price itself (548, undercutting the
// competitor) was directionally correct; only the label and the prose
// describing it were backwards. Computing the verdict ourselves makes that
// specific failure mode structurally impossible, whatever the model says.
const PRICE_INSIGHT_FN = {
  name: 'report_price_insight',
  description: 'Recommend the ideal price Kapruka should set for this product, based on scraped competitor prices.',
  parameters: {
    type: 'object',
    properties: {
      idealPriceLkr: {
        type: 'integer',
        description:
          'A specific recommended LKR price, not a range. Usually just under the cheapest credible ' +
          'competitor price (undercut slightly to stay the best deal), unless the competitor price looks ' +
          'unsustainable (a clearance/liquidation price) in which case anchor closer to the median instead.',
      },
      reasoning: { type: 'string', description: 'One or two sentences, plain language, for a non-technical team member.' },
    },
    required: ['idealPriceLkr', 'reasoning'],
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

/**
 * kaprukaRef: { name, price, url }
 * competitors: [{ site, price, matchRate }] -- only rows with a real price and 'ok'/'low_confidence' status
 *   should be passed in; low-confidence matches are still useful context but the prompt is told which is which.
 * Returns null if there's nothing to compare (no competitor prices) -- caller should skip the whole feature
 * rather than call this with an empty list.
 */
export async function recommendPrice(kaprukaRef, competitors) {
  if (!kaprukaRef?.price || !competitors.length) return null;
  // Computed up front (not left to the model) and handed to it as an
  // established fact, so its own reasoning prose is written to match the
  // correct verdict instead of potentially re-deriving and contradicting it.
  const verdict = computeVerdict(kaprukaRef.price, competitors);
  const lines = competitors
    .map((c) => `- ${c.site}: LKR ${c.price}${c.matchRate != null ? ` (match confidence ${c.matchRate}%)` : ''}`)
    .join('\n');
  const content =
    `Kapruka product: "${kaprukaRef.name}"\nKapruka's current price: LKR ${kaprukaRef.price}\n\n` +
    `Competitor prices found for this same product:\n${lines}\n\n` +
    `Verdict (already determined, do not contradict it): Kapruka is "${verdict}" relative to the cheapest ` +
    `competitor price.\n\n` +
    `Recommend the ideal price Kapruka should set, with reasoning consistent with that verdict. Call report_price_insight.`;
  try {
    const res = await getClient().chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content }],
      tools: [{ type: 'function', function: PRICE_INSIGHT_FN }],
      tool_choice: { type: 'function', function: { name: 'report_price_insight' } },
    });
    const call = res.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return { verdict, idealPriceLkr: null, reasoning: '' };
    const parsed = JSON.parse(call.function.arguments);
    return {
      verdict,
      idealPriceLkr: Number.isFinite(parsed.idealPriceLkr) ? parsed.idealPriceLkr : null,
      reasoning: parsed.reasoning || '',
    };
  } catch {
    return null; // best-effort -- a failed insight call shouldn't break the rest of the search
  }
}
