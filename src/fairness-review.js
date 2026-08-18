// AI "is this overcharge actually a problem" reviewer for the Overpriced
// dashboard. A raw price diff alone doesn't say whether Kapruka's price is
// genuinely worth fixing -- the partner's price might be an unsustainable
// clearance/liquidation deal, a bundle that isn't really the same product,
// or the match itself might just be wrong (see compare/matcher.js -- name
// matching is heuristic, not guaranteed). This asks a model to weigh the
// product names/prices together and give a one-line verdict, same
// structured-output pattern as daraz.js's scoreMarketplaceIdentity().

import OpenAI from 'openai';

const MODEL = process.env.MATCH_MODEL || 'gpt-4o-mini';
let client = null;
function getClient() {
  if (!client) client = new OpenAI();
  return client;
}

const FAIRNESS_FN = {
  name: 'report_fairness_verdict',
  description: 'Judge whether a Kapruka product being priced higher than a competitor is a genuine pricing problem.',
  parameters: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['genuine_problem', 'explainable', 'uncertain_match'],
        description:
          '"genuine_problem": same product, no obvious reason for the gap -- worth Kapruka fixing. ' +
          '"explainable": the gap has a plausible reason (partner regular/list price is actually higher and ' +
          'this is a temporary clearance/liquidation price, a clear bundle/quantity difference, or a large ' +
          'percentage gap on a very cheap item where a small absolute difference is inflated). ' +
          '"uncertain_match": the two product names don\'t clearly describe the same item -- the price ' +
          'comparison itself may not be valid.',
      },
      reasoning: { type: 'string', description: 'One sentence, plain language, for a non-technical team member.' },
    },
    required: ['verdict', 'reasoning'],
    additionalProperties: false,
  },
};

/**
 * item: { name, kaprukaPrice, partnerProductName, partnerPrice, partnerRegularPrice, partner, pct }
 * Returns { verdict, reasoning } -- verdict falls back to 'uncertain_match' on any failure so a bad/
 * missing API call never silently claims "genuine_problem" without the model actually having said so.
 */
export async function reviewFairness(item) {
  const content =
    `Kapruka is selling a product at a higher price than a competitor. Judge whether this is worth flagging.\n\n` +
    `Kapruka product: "${item.name}"\nKapruka price: LKR ${item.kaprukaPrice}\n\n` +
    `Competitor (${item.partner || 'partner'}) product: "${item.partnerProductName || item.name}"\n` +
    `Competitor price: LKR ${item.partnerPrice}` +
    (item.partnerRegularPrice && item.partnerRegularPrice > item.partnerPrice
      ? ` (currently discounted from their own regular price of LKR ${item.partnerRegularPrice} -- likely a temporary sale, not their normal price)`
      : '') +
    `\nOvercharge: ${item.pct != null ? item.pct.toFixed(1) + '%' : 'unknown %'}\n\n` +
    `Call report_fairness_verdict.`;
  try {
    const res = await getClient().chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content }],
      tools: [{ type: 'function', function: FAIRNESS_FN }],
      tool_choice: { type: 'function', function: { name: 'report_fairness_verdict' } },
    });
    const call = res.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return { verdict: 'uncertain_match', reasoning: 'No verdict returned.' };
    const parsed = JSON.parse(call.function.arguments);
    return { verdict: parsed.verdict || 'uncertain_match', reasoning: parsed.reasoning || '' };
  } catch (err) {
    return { verdict: 'uncertain_match', reasoning: `Review failed: ${err.message}` };
  }
}
