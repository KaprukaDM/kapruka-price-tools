// Relevancy scoring via OpenAI vision: looks at each product's photo + title
// together and scores how relevant it actually is to the search term. Catches
// results that only surfaced because the term appears loosely in the title
// (unrelated gift hampers, cosmetics, etc.).

import OpenAI from 'openai';

const MODEL = process.env.RELEVANCY_MODEL || 'gpt-4o-mini';
const BATCH_SIZE = 10; // products per vision call

let client = null;
function getClient() {
  // maxRetries covers transient 429/5xx during a large bulk job (the SDK
  // backs off automatically) instead of a batch silently scoring 0.
  if (!client) client = new OpenAI({ maxRetries: 5 });
  return client;
}

const REPORT_RELEVANCY_FN = {
  name: 'report_relevancy',
  description:
    'Report how relevant each numbered product (photo + title) is to the search term.',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'The item number given in the prompt.' },
            relevancyScore: {
              type: 'integer',
              description:
                '0-100, using the full range — do not cluster items at the same round number. The ' +
                'product that literally IS the search term (standalone — e.g. a bag of plain almonds, ' +
                'or a USB flash drive for a "drive" search) scores highest. A close mix/bundle/variant ' +
                'that still centers on the term scores next. A manufactured product that merely uses ' +
                'the term as a flavor/feature (e.g. an almond cake) scores lower than that, and a minor/ ' +
                'secondary mention scores lower still. Lowest scores for items that only surfaced ' +
                'because the term appears loosely in the title/description (unrelated products, ' +
                'accessories, or gift hampers that merely mention the word).',
            },
            reasoning: { type: 'string', description: 'One short sentence.' },
          },
          required: ['index', 'relevancyScore', 'reasoning'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
};

async function scoreBatch(term, batch) {
  const content = [
    {
      type: 'text',
      text:
        `A shopper searched Kapruka.com for "${term}". Below are ${batch.length} product results, ` +
        'each with its photo and title. Score how relevant each one actually is to that search, ' +
        'looking at the photo as well as the title. The search term could be a food ingredient, an ' +
        'electronics category, a cosmetic, or anything else Kapruka sells — judge relevance to what ' +
        'a shopper actually means by the term, not just literal ingredient-list matching.\n\n' +
        'Use this rubric and spread scores across it — do not give everything the same number:\n' +
        `- 90-100: the product IS "${term}" — the exact, standalone item a shopper searching this ` +
        'term wants (e.g. a bag of plain almonds for "almond", a USB flash drive for "drive").\n' +
        `- 70-89: a close match — a mix, bundle, or variant that still centers on "${term}" (e.g. a ` +
        'mixed-nut snack where it is a featured ingredient, a different size/model/capacity of the ' +
        'same core item).\n' +
        `- 40-69: a manufactured or derived product where "${term}" is a headline flavor/feature, but ` +
        'the product itself is something else (e.g. an almond-flavored cake, a walnut coffee).\n' +
        `- 15-39: "${term}" is present only as a minor or secondary ingredient/feature, not the headline.\n` +
        '- 0-14: barely related — mentioned in passing, or an unrelated product/accessory/gift hamper ' +
        'that just happens to include the word.\n' +
        'Within each band, differentiate further based on pack size/capacity, purity, and how central ' +
        'the term is to the product. Call report_relevancy with one entry per item.',
    },
  ];
  batch.forEach((p, i) => {
    content.push({
      type: 'text',
      text: `Item ${i}: "${p.title || '(no title)'}"${p.price ? ` — ${p.currency || ''} ${p.price}` : ''}`,
    });
    // detail: 'low' fixes each image at a flat token cost instead of the much
    // pricier high-detail tiling — plenty for judging a small product thumbnail.
    if (p.image) content.push({ type: 'image_url', image_url: { url: p.image, detail: 'low' } });
  });

  try {
    const res = await getClient().chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content }],
      tools: [{ type: 'function', function: REPORT_RELEVANCY_FN }],
      tool_choice: { type: 'function', function: { name: 'report_relevancy' } },
    });
    const call = res.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return batch.map(() => ({ relevancyScore: 0, reasoning: 'no report returned' }));
    const { items } = JSON.parse(call.function.arguments);
    const byIndex = new Map(items.map((it) => [it.index, it]));
    return batch.map((_, i) => byIndex.get(i) || { relevancyScore: 0, reasoning: 'missing from report' });
  } catch (err) {
    return batch.map(() => ({ relevancyScore: 0, reasoning: `error: ${err.message}` }));
  }
}

export async function scoreRelevancy(term, products, { log = () => {} } = {}) {
  const batches = [];
  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    batches.push(products.slice(i, i + BATCH_SIZE));
  }
  log(`scoring ${products.length} products in ${batches.length} vision batch(es)...`);
  const scored = await Promise.all(batches.map((batch) => scoreBatch(term, batch)));

  const merged = products.map((p, i) => {
    const batchIdx = Math.floor(i / BATCH_SIZE);
    const withinIdx = i % BATCH_SIZE;
    const s = scored[batchIdx][withinIdx] || {};
    return { ...p, relevancyScore: s.relevancyScore ?? 0, reasoning: s.reasoning || '' };
  });

  merged.sort((a, b) => b.relevancyScore - a.relevancyScore);
  return merged;
}
