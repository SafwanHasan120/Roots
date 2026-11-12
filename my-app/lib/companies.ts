// Prestige tiers for ranking, and the company-filter groups built from them.
// O(1) lookup via Set. Keys are lowercased.
//
// Prestige scores are unchanged: tier 1 is still 1.0 and tier 2 is still 0.5.
// The tech / finance split only decides which filter pill a name belongs to.

import { normalizeCompanyName } from './companyNormalizer';

const TIER1_TECH = [
  'google',
  'alphabet',
  'meta',
  'facebook',
  'apple',
  'amazon',
  'microsoft',
  'netflix',
  'nvidia',
  'openai',
  'anthropic',
  'tesla',
  'spacex',
  'databricks',
  'stripe',
  'palantir',
];

const TIER1_FINANCE = [
  'jane street',
  'citadel',
  'citadel securities',
  'hudson river trading',
  'hrt',
  'two sigma',
  'jump trading',
  'optiver',
  'de shaw',
  'd. e. shaw',
];

const TIER2_TECH = [
  'uber',
  'lyft',
  'airbnb',
  'linkedin',
  'salesforce',
  'adobe',
  'oracle',
  'ibm',
  'intel',
  'amd',
  'qualcomm',
  'paypal',
  'block',
  'square',
  'coinbase',
  'robinhood',
  'snowflake',
  'datadog',
  'cloudflare',
  'snap',
  'snapchat',
  'pinterest',
  'doordash',
  'instacart',
  'dropbox',
  'twilio',
  'atlassian',
  'roblox',
  'samsung',
  'sony',
  'spotify',
  'reddit',
  'plaid',
  'figma',
  'notion',
];

const TIER2_FINANCE = [
  'bloomberg',
  'goldman sachs',
  'morgan stanley',
  'jpmorgan',
  'jp morgan',
  'capital one',
  'akuna capital',
  'imc',
  'imc trading',
  'drw',
  'sig',
  'susquehanna',
  'point72',
];

const TIER1_LIST = [...TIER1_TECH, ...TIER1_FINANCE];
const TIER2_LIST = [...TIER2_TECH, ...TIER2_FINANCE];

export const TIER1 = new Set(TIER1_LIST);
export const TIER2 = new Set(TIER2_LIST);

export const BIG_TECH = new Set([...TIER1_TECH, ...TIER2_TECH]);
export const FINANCE = new Set([...TIER1_FINANCE, ...TIER2_FINANCE]);

export type CompanyFocus = 'tech' | 'finance';

export function prestigeOf(company: string): number {
  const c = company.trim().toLowerCase();
  if (TIER1.has(c)) return 1.0;
  if (TIER2.has(c)) return 0.5;
  return 0.0;
}

/**
 * Which company filter a name belongs to.
 *
 * Checks the raw lowercased name and its canonical alias, so "Facebook" and
 * "JP Morgan" hit the same pills as "Meta" and "JPMorgan". Unknown companies
 * match neither pill.
 */
export function companyFocus(company: string): CompanyFocus | null {
  const raw = company.trim().toLowerCase();
  const normalized = normalizeCompanyName(company);
  const keys = raw === normalized ? [raw] : [raw, normalized];
  for (const key of keys) {
    if (FINANCE.has(key)) return 'finance';
    if (BIG_TECH.has(key)) return 'tech';
  }
  return null;
}
