// Registry of destination countries the International Gifting Price Checker
// supports. Each entry maps a Kapruka country code (kapruka.com/online/<code>)
// to the competitor-site adapter used to price-check against.
//
// To add a new country: write a <site>-scraper.js exposing
// fetchCatalog()/fetchProduct(url) (see fnp-scraper.js for the shape), then
// add an entry here. Everything else — the Kapruka-side scrape, DB-backed
// pairing cache, auto-matching, and dashboard UI — is already country-agnostic.

import { fetchFnpCatalog, fetchFnpProduct } from './fnp-scraper.js';

export const COUNTRIES = {
  UAE: {
    label: 'UAE',
    competitorName: 'fnp.ae',
    competitorUrlPattern: /^https?:\/\/(www\.)?fnp\.ae\//i,
    fetchCatalog: fetchFnpCatalog,
    fetchProduct: fetchFnpProduct,
  },
};

export function getCountry(code) {
  const country = COUNTRIES[String(code || '').toUpperCase()];
  if (!country) throw new Error(`Unsupported country "${code}". Supported: ${Object.keys(COUNTRIES).join(', ')}`);
  return country;
}
