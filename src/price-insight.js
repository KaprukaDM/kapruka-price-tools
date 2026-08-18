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

const PRICE_INSIGHT_FN = {
  name: 'report_price_insight',
  description: 'Recommend the ideal price Kapruka should set for this product, based on scraped competitor prices.',
  parameters: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['overpriced', 'competitive', 'underpriced'],
        description:
          '"overpriced": Kapruka is meaningfully higher than the market and should come down. ' +
          '"competitive": Kapruka is at or near the market rate already -- no change needed. ' +
          '"underpriced": Kapruka is meaningfully lower than every competitor -- there may be room ' +
          'to raise the price without losing the price advantage.',
      },
      idealPriceLkr: {
        type: 'integer',
        description:
          'A specific recommended LKR price, not a range. Usually just under the cheapest credible ' +
          'competitor price (undercut slightly to stay the best deal), unless the competitor price looks ' +
          'unsustainable (a clearance/liquidation price) in which case anchor closer to the median instead.',
      },
      reasoning: { type: 'string', description: 'One or two sentences, plain language, for a non-technical team member.' },
    },
    required: ['verdict', 'idealPriceLkr', 'reasoning'],
    additionalProperties: false,
  },
};

/**
 * kaprukaRef: { name, price, url }
 * competitors: [{ site, price, matchRate }] -- only rows with a real price and 'ok'/'low_confidence' status
 *   should be passed in; low-confidence matches are still useful context but the prompt is told which is which.
 * Returns null if there's nothing to compare (no competitor prices) -- caller should skip the whole feature
 * rather than call this with an empty list.
 */
export async function recommendPrice(kaprukaRef, competitors) {
  if (!kaprukaRef?.price || !competitors.length) return null;
  const lines = competitors
    .map((c) => `- ${c.site}: LKR ${c.price}${c.matchRate != null ? ` (match confidence ${c.matchRate}%)` : ''}`)
    .join('\n');
  const content =
    `Kapruka product: "${kaprukaRef.name}"\nKapruka's current price: LKR ${kaprukaRef.price}\n\n` +
    `Competitor prices found for this same product:\n${lines}\n\n` +
    `Recommend the ideal price Kapruka should set. Call report_price_insight.`;
  try {
    const res = await getClient().chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content }],
      tools: [{ type: 'function', function: PRICE_INSIGHT_FN }],
      tool_choice: { type: 'function', function: { name: 'report_price_insight' } },
    });
    const call = res.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return null;
    const parsed = JSON.parse(call.function.arguments);
    return {
      verdict: parsed.verdict,
      idealPriceLkr: Number.isFinite(parsed.idealPriceLkr) ? parsed.idealPriceLkr : null,
      reasoning: parsed.reasoning || '',
    };
  } catch {
    return null; // best-effort -- a failed insight call shouldn't break the rest of the search
  }
}
