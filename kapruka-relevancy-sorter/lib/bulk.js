// Runs AI relevancy sort across many find_online links as one background job,
// with a small concurrency pool (so 1000 links don't all hammer the OpenAI
// API at once), and rolls each link's product scores up into an overall
// weighted "job score" for the whole batch.

import { collectProducts, termFromUrl } from './kapruka.js';
import { scoreRelevancy } from './relevancy.js';

const CONCURRENCY = Number(process.env.BULK_CONCURRENCY || 3);
const HIGH_THRESHOLD = 70;
const LOW_THRESHOLD = 30;

const jobs = new Map(); // jobId -> job

function newJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

export function createJob(urls) {
  const id = newJobId();
  const job = {
    id,
    status: 'running', // running | done
    total: urls.length,
    completed: 0,
    overallScore: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    links: urls.map((url) => ({
      url,
      term: termFromUrl(url),
      status: 'pending', // pending | running | done | error
      productCount: 0,
      avgRelevancy: null,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      products: null, // full ranked list, only kept per-link (not sent on every poll)
      error: null,
    })),
  };
  jobs.set(id, job);
  runJob(job); // fire and forget; poll via getJob()
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

async function runOneLink(link) {
  link.status = 'running';
  try {
    const products = await collectProducts(link.url, { log: () => {} });
    const ranked = await scoreRelevancy(link.term, products, { log: () => {} });
    link.products = ranked;
    link.productCount = ranked.length;
    link.avgRelevancy = ranked.length
      ? round1(ranked.reduce((s, p) => s + (p.relevancyScore || 0), 0) / ranked.length)
      : 0;
    link.highCount = ranked.filter((p) => p.relevancyScore >= HIGH_THRESHOLD).length;
    link.mediumCount = ranked.filter(
      (p) => p.relevancyScore >= LOW_THRESHOLD && p.relevancyScore < HIGH_THRESHOLD
    ).length;
    link.lowCount = ranked.filter((p) => p.relevancyScore < LOW_THRESHOLD).length;
    link.status = 'done';
  } catch (err) {
    link.status = 'error';
    link.error = err.message;
  }
}

async function runJob(job) {
  let next = 0;
  async function worker() {
    while (next < job.links.length) {
      const link = job.links[next++];
      await runOneLink(link);
      job.completed += 1;
    }
  }
  const workerCount = Math.min(CONCURRENCY, job.links.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  // Overall job score = relevancy averaged across every scored product,
  // not every link — so a link with 60 products counts more than one with 5.
  const scoredLinks = job.links.filter((l) => l.status === 'done' && l.productCount > 0);
  const totalProducts = scoredLinks.reduce((s, l) => s + l.productCount, 0);
  const weightedSum = scoredLinks.reduce((s, l) => s + l.avgRelevancy * l.productCount, 0);
  job.overallScore = totalProducts ? round1(weightedSum / totalProducts) : null;
  job.status = 'done';
  job.finishedAt = new Date().toISOString();
}

// Lightweight view for polling — omits each link's full product list (which
// can be tens of thousands of records across a large job) to keep polls cheap.
export function jobSummary(job) {
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    overallScore: job.overallScore,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    links: job.links.map((l) => ({
      url: l.url,
      term: l.term,
      status: l.status,
      productCount: l.productCount,
      avgRelevancy: l.avgRelevancy,
      highCount: l.highCount,
      mediumCount: l.mediumCount,
      lowCount: l.lowCount,
      error: l.error,
    })),
  };
}
