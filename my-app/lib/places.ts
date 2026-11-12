// Parse listing locations into places, then match filters on those fields.
// The feed publishes "City, ST" text (no coordinates), and older rows join
// several cities with commas, so this scans for place patterns instead of
// treating every comma fragment as a filter.

export interface LocationPill {
  key: string;
  label: string;
  count: number;
}

interface Place {
  kind: 'remote' | 'city' | 'country';
  city?: string;
  region?: string;
  country?: 'US' | 'Canada';
}

const US_STATE_NAMES: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
};

const CA_PROVINCE_NAMES: Record<string, string> = {
  AB: 'Alberta',
  BC: 'British Columbia',
  MB: 'Manitoba',
  NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia',
  NT: 'Northwest Territories',
  NU: 'Nunavut',
  ON: 'Ontario',
  PE: 'Prince Edward Island',
  QC: 'Quebec',
  SK: 'Saskatchewan',
  YT: 'Yukon',
};

const US_STATE_RE = Object.keys(US_STATE_NAMES).join('|');
const CA_PROVINCE_RE = Object.keys(CA_PROVINCE_NAMES).join('|');

const REMOTE_RE =
  /^remote(?:\s+in\s+usa|\s*\([^)]*\)|(?:\s*[,–-]\s*)(?:united states|usa|us))?/i;
const WASHINGTON_DC_RE = /^washington,\s*d\.?\s*c\.?/i;
const CITY_PROVINCE_CANADA_RE = new RegExp(
  `^([^,]+?),\\s*(${CA_PROVINCE_RE}),\\s*canada\\b`,
  'i',
);
// "Toronto, ON" omits the country. Province codes don't overlap US states.
const CITY_PROVINCE_RE = new RegExp(`^([^,]+?),\\s*(${CA_PROVINCE_RE})\\b`, 'i');
const CITY_STATE_RE = new RegExp(`^([^,]+?),\\s*(${US_STATE_RE})\\b`, 'i');
const CITY_CANADA_RE = /^([^,]+?),\s*canada\b/i;
const UNITED_STATES_RE = /^(?:united states|u\.s\.a\.?|u\.s\.|usa|us)\b/i;
const CANADA_RE = /^canada\b/i;
const ALIAS_RE = /^(?:new york city|new york|nyc|sf|la)\b/i;

function foldAccents(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '');
}

function canonicalCity(raw: string): string {
  const folded = foldAccents(raw).replace(/\s+/g, ' ').trim();
  const key = folded.toLowerCase();
  if (key === 'new york city' || key === 'nyc' || key === 'new york') return 'New York';
  if (key === 'sf' || key === 'san francisco') return 'San Francisco';
  if (key === 'la' || key === 'los angeles') return 'Los Angeles';
  return folded;
}

function isSkippableCity(city: string): boolean {
  return /^(remote|united states|usa|u\.s\.a\.?|u\.s\.|us|canada|multiple locations(?: available)?)$/i.test(
    city.trim(),
  );
}

interface Match {
  place: Place;
  length: number;
}

function matchAtStart(text: string): Match | null {
  const remote = REMOTE_RE.exec(text);
  if (remote) return { place: { kind: 'remote' }, length: remote[0].length };

  const dc = WASHINGTON_DC_RE.exec(text);
  if (dc) {
    return {
      place: { kind: 'city', city: 'Washington', region: 'DC', country: 'US' },
      length: dc[0].length,
    };
  }

  const province = CITY_PROVINCE_CANADA_RE.exec(text);
  if (province && !isSkippableCity(province[1])) {
    return {
      place: {
        kind: 'city',
        city: canonicalCity(province[1]),
        region: province[2].toUpperCase(),
        country: 'Canada',
      },
      length: province[0].length,
    };
  }

  const state = CITY_STATE_RE.exec(text);
  if (state && !isSkippableCity(state[1])) {
    return {
      place: {
        kind: 'city',
        city: canonicalCity(state[1]),
        region: state[2].toUpperCase(),
        country: 'US',
      },
      length: state[0].length,
    };
  }

  const canada = CITY_CANADA_RE.exec(text);
  if (canada && !isSkippableCity(canada[1])) {
    return {
      place: {
        kind: 'city',
        city: canonicalCity(canada[1]),
        country: 'Canada',
      },
      length: canada[0].length,
    };
  }

  const provinceOnly = CITY_PROVINCE_RE.exec(text);
  if (provinceOnly && !isSkippableCity(provinceOnly[1])) {
    return {
      place: {
        kind: 'city',
        city: canonicalCity(provinceOnly[1]),
        region: provinceOnly[2].toUpperCase(),
        country: 'Canada',
      },
      length: provinceOnly[0].length,
    };
  }

  const united = UNITED_STATES_RE.exec(text);
  if (united) return { place: { kind: 'country', country: 'US' }, length: united[0].length };

  const country = CANADA_RE.exec(text);
  if (country) return { place: { kind: 'country', country: 'Canada' }, length: country[0].length };

  const alias = ALIAS_RE.exec(text);
  if (alias) {
    const token = alias[0].toLowerCase();
    if (token === 'sf') {
      return {
        place: { kind: 'city', city: 'San Francisco', region: 'CA', country: 'US' },
        length: alias[0].length,
      };
    }
    if (token === 'la') {
      return {
        place: { kind: 'city', city: 'Los Angeles', region: 'CA', country: 'US' },
        length: alias[0].length,
      };
    }
    return {
      place: { kind: 'city', city: 'New York', region: 'NY', country: 'US' },
      length: alias[0].length,
    };
  }

  return null;
}

export function parsePlaces(location: string): Place[] {
  if (!location || location.trim() === '—' || location.trim() === '-') return [];

  const places: Place[] = [];
  const segments = location.split(/\s+\|\s+|\s+\/\s+/);
  for (const segment of segments) {
    let rest = segment.trim();
    while (rest.length > 0) {
      rest = rest.replace(/^[\s,;]+/, '');
      // "CAN Kanata, ON" prefixes the city with the country.
      rest = rest.replace(/^(?:can|canada)\s+(?=\S)/i, '');
      if (!rest) break;
      const matched = matchAtStart(rest);
      if (!matched) {
        const skip = /^[^,;|]+/.exec(rest);
        rest = rest.slice(skip ? skip[0].length : 1);
        continue;
      }
      places.push(matched.place);
      rest = rest.slice(matched.length);
    }
  }
  return places;
}

interface PillSeed {
  key: string;
  label: string;
}

/** Pills this location should match. A listing counts once per key. */
export function pillsForLocation(location: string): PillSeed[] {
  const places = parsePlaces(location);
  const hasCity = places.some((place) => place.kind === 'city');
  const seen = new Set<string>();
  const pills: PillSeed[] = [];

  const add = (key: string, label: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    pills.push({ key, label });
  };

  for (const place of places) {
    if (place.kind === 'remote') {
      add('remote', 'Remote');
      continue;
    }
    if (place.kind === 'country') {
      if (place.country === 'US' && !hasCity) add('country:US', 'United States');
      if (place.country === 'Canada') add('country:Canada', 'Canada');
      continue;
    }
    if (!place.city) continue;
    if (place.country === 'US' && place.region) {
      add(`city:${place.city.toLowerCase()}|US-${place.region}`, `${place.city}, ${place.region}`);
      const state = US_STATE_NAMES[place.region];
      if (state) add(`region:US-${place.region}`, state);
    } else if (place.country === 'Canada') {
      add(`city:${place.city.toLowerCase()}|Canada`, `${place.city}, Canada`);
      add('country:Canada', 'Canada');
      if (place.region) {
        const province = CA_PROVINCE_NAMES[place.region];
        if (province) add(`region:CA-${place.region}`, province);
      }
    }
  }

  return pills;
}

export function locationMatches(location: string, pillKey: string): boolean {
  return pillsForLocation(location).some((pill) => pill.key === pillKey);
}

/** Top pills by how many listings match each one. */
export function topLocationPills(locations: string[], limit = 20): LocationPill[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const location of locations) {
    for (const pill of pillsForLocation(location)) {
      const current = counts.get(pill.key) ?? { label: pill.label, count: 0 };
      current.count += 1;
      counts.set(pill.key, current);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label))
    .slice(0, limit)
    .map(([key, value]) => ({ key, label: value.label, count: value.count }));
}
