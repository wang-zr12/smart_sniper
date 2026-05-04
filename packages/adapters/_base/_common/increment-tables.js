/**
 * Bid increment tables. Each row is [lowCents, highCents, incrementCents].
 * Tables are illustrative — verify against the live site before turning on
 * production bidding.
 */
export const INCREMENT_TABLES = Object.freeze({
  ebay_v1: Object.freeze([
    [0,       99,                          5],
    [100,     499,                         25],
    [500,     999,                         50],
    [1000,    2499,                        100],
    [2500,    4999,                        250],
    [5000,    9999,                        500],
    [10000,   24999,                       1000],
    [25000,   49999,                       2500],
    [50000,   99999,                       5000],
    [100000,  Number.POSITIVE_INFINITY,    10000]
  ]),
  shopgoodwill_v2: Object.freeze([
    [0,       499,                         50],
    [500,     2499,                        100],
    [2500,    9999,                        500],
    [10000,   Number.POSITIVE_INFINITY,    1000]
  ])
});

export function lookupIncrement(tableName, currentPriceCents) {
  const table = INCREMENT_TABLES[tableName];
  if (!table) return null;
  for (const row of table) {
    const [low, high, inc] = row;
    if (currentPriceCents >= low && currentPriceCents <= high) return inc;
  }
  return null;
}
