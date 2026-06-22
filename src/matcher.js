// Match-scoring layer (OpenAI). Given the user's query product and one scraped
// candidate, ask the model to (a) judge whether they are the same product
// (0-100 match rate) and (b) pick the price for the queried variant from the
// captured prices.
//
// Uses a forced function call for structured output — validated args, no prose
// parsing.

import OpenAI from 'openai';

const MODEL = process.env.MATCH_MODEL || 'gpt-4o-mini';

let client = null;
function getClient() {
  if (!client) client = new OpenAI(); // reads OPENAI_API_KEY from env
  return client;
}

const REPORT_FN = {
  name: 'report_match',
  description:
    'Report whether the candidate product is the same as the queried product, ' +
    'and which captured price corresponds to the queried variant.',
  parameters: {
    type: 'object',
    properties: {
      matchRate: {
        type: 'integer',
        description:
          'Confidence 0-100 that the candidate is the SAME product the user asked for ' +
          '(same model and, if the query specifies one, the same variant).',
      },
      isSameProduct: { type: 'boolean' },
      chosenPriceValue: {
        type: ['number', 'null'],
        description:
          'The current price the customer pays for the queried variant, taken from the ' +
          'candidate.prices list. Prefer a sale/discounted price over the original. ' +
          'Null if no price clearly applies.',
      },
      chosenPriceCurrency: {
        type: ['string', 'null'],
        description: 'Currency code for chosenPriceValue, e.g. LKR, USD. Null if unknown.',
      },
      priceContext: {
        type: 'string',
        description:
          'Short human label for the chosen price, e.g. "128GB, discounted from Rs.99,900" ' +
          'or "no variant info". Empty string if not applicable.',
      },
      reasoning: {
        type: 'string',
        description: 'One or two sentences justifying the match rate and price choice.',
      },
    },
    required: [
      'matchRate',
      'isSameProduct',
      'chosenPriceValue',
      'chosenPriceCurrency',
      'priceContext',
      'reasoning',
    ],
    additionalProperties: false,
  },
};

const IDENTITY_FN = {
  name: 'report_identity',
  description: 'Report whether the candidate page is the same product MODEL the user asked for.',
  parameters: {
    type: 'object',
    properties: {
      matchRate: {
        type: 'integer',
        description:
          'Confidence 0-100 that the candidate page is the same product MODEL as the query ' +
          '(ignore storage/variant and price here — only the model identity). A store homepage, ' +
          'category/tag listing, accessory, or a different model is a low score.',
      },
      isSameModel: { type: 'boolean' },
      reasoning: { type: 'string' },
    },
    required: ['matchRate', 'isSameModel', 'reasoning'],
    additionalProperties: false,
  },
};

/**
 * Confirm the candidate page is the right product model (variant/price handled
 * deterministically by the per-site scraper). Returns { matchRate, isSameModel, reasoning }.
 */
export async function scoreIdentity(query, { title, url, site }) {
  const sellerLine = site ? `\nThis page is sold by the retailer "${site}".` : '';
  const content =
    `Decide whether this candidate page is the SAME product the user wants.\n\n` +
    `== USER QUERY ==\nName: ${query.name}\nDescription: ${query.description || '(none)'}\n\n` +
    `== CANDIDATE ==\nTitle: ${title || '(no title)'}\nURL: ${url}${sellerLine}\n\n` +
    `Rules:\n` +
    `- Match on the CORE product (e.g. "Pineapple Gateau", "iPhone 15"). Ignore storage/colour/size/price.\n` +
    `- Retailers don't repeat their own name in product titles. If the query includes a brand or store name that matches the retailer/site, do NOT penalise its absence from the title.\n` +
    `- Model qualifiers are part of the model identity: Lite, Pro, Pro Max, Max, Plus, "+", Mini, Note, Ultra, Air, SE, Neo, Prime, 5G, FE. If the query and candidate DIFFER on any such qualifier — one has it and the other doesn't, or they have different ones — they are DIFFERENT products: score below 25 and isSameModel=false. (e.g. "Redmi 9" vs "Redmi 9 Lite" = different; "Redmi 9" vs "Redmi Note 9" = different.) This is symmetric.\n` +
    `- Score HIGH only when the core product AND its qualifiers match. Score LOW for a different product/qualifier, an accessory, or a homepage/category/listing page.\n` +
    `Call report_identity.`;
  try {
    const res = await getClient().chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content }],
      tools: [{ type: 'function', function: IDENTITY_FN }],
      tool_choice: { type: 'function', function: { name: 'report_identity' } },
    });
    const call = res.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return { matchRate: 0, isSameModel: false, reasoning: 'no identity report' };
    return JSON.parse(call.function.arguments);
  } catch (err) {
    return { matchRate: 0, isSameModel: false, reasoning: err.message, error: err.message };
  }
}

/**
 * Score one candidate against the query.
 * @param {{name: string, description: string}} query
 * @param {object} candidate  output of scrapeProduct()
 * @returns {Promise<object>} the report_match args, plus { error } on failure
 */
export async function scoreMatch(query, candidate) {
  const userContent = [
    'Decide whether the CANDIDATE product is the same item the USER is asking for, ',
    'and select the correct current price.\n\n',
    '== USER QUERY ==\n',
    `Name: ${query.name}\n`,
    `Description: ${query.description || '(none)'}\n\n`,
    '== CANDIDATE (scraped from a retailer page) ==\n',
    `Title: ${candidate.title || '(no title)'}\n`,
    `Source currency detected: ${candidate.currency || 'unknown'}\n`,
    `Captured prices (pick from these only): ${JSON.stringify(candidate.prices)}\n`,
    `URL: ${candidate.url}\n\n`,
    'Rules:\n',
    '- The candidate Title must be the SPECIFIC product. If the Title looks like a store ',
    'homepage, a category/tag/search/brand listing, or a generic page (e.g. "Online Store", ',
    '"... Archives", a shop name with no product), it is NOT a match: return matchRate < 30 ',
    'and chosenPriceValue null.\n',
    '- matchRate reflects same model AND same variant when the query specifies one ',
    '(e.g. storage, colour). A different variant is a partial match, not a full one.\n',
    '- Model qualifiers (Lite, Pro, Pro Max, Max, Plus, "+", Mini, Note, Ultra, Air, SE, Neo, ',
    'Prime, 5G, FE) are part of the model. If the query and candidate differ on any such ',
    'qualifier, they are DIFFERENT products: matchRate below 25, isSameProduct false ',
    '(e.g. "Redmi 9" vs "Redmi 9 Lite"). This is symmetric.\n',
    '- For the price, choose the FULL CURRENT SELLING PRICE of the item. Do NOT just pick the ',
    'lowest number: very low values are usually monthly installments, deposits/advances, ',
    'trade-in values, or accessory prices — these are NOT the product price. Among the captured ',
    'prices, pick the one that represents buying the whole item now (a genuine discounted price ',
    'is fine, an installment/deposit is not).\n',
    '- If every captured price looks like an installment/deposit/accessory, or none clearly ',
    'represents the full item, return chosenPriceValue null.\n',
    '- Only choose a price from the captured prices list. Do not invent prices or currencies.\n',
    'Call report_match with your answer.',
  ].join('');

  try {
    const res = await getClient().chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: userContent }],
      tools: [{ type: 'function', function: REPORT_FN }],
      tool_choice: { type: 'function', function: { name: 'report_match' } },
    });
    const call = res.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) {
      return { error: 'model did not return a match report', matchRate: 0 };
    }
    return JSON.parse(call.function.arguments);
  } catch (err) {
    return { error: err.message, matchRate: 0 };
  }
}
