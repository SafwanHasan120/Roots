import { describe, expect, it } from 'vitest';
import { locationMatches, topLocationPills } from '../places';

describe('places', () => {
  it('does not treat California as a substring of Canada or other cities', () => {
    expect(locationMatches('Toronto, Canada', 'region:US-CA')).toBe(false);
    expect(locationMatches('Cambridge, MA', 'region:US-CA')).toBe(false);
    expect(locationMatches('San Jose, CA', 'region:US-CA')).toBe(true);
    expect(locationMatches('San Jose, CA', 'country:Canada')).toBe(false);
    expect(locationMatches('Toronto, Canada', 'country:Canada')).toBe(true);
  });

  it('does not treat Colorado as a substring of San Francisco', () => {
    expect(locationMatches('San Francisco, CA', 'region:US-CO')).toBe(false);
    expect(locationMatches('Denver, CO', 'region:US-CO')).toBe(true);
    expect(locationMatches('San Francisco, CA', 'city:san francisco|US-CA')).toBe(true);
  });

  it('does not treat Massachusetts as a substring of San Mateo', () => {
    expect(locationMatches('San Mateo, CA', 'region:US-MA')).toBe(false);
    expect(locationMatches('Boston, MA', 'region:US-MA')).toBe(true);
  });

  it('does not treat Virginia as a substring of Vancouver or Sunnyvale', () => {
    expect(locationMatches('Vancouver, Canada', 'region:US-VA')).toBe(false);
    expect(locationMatches('Sunnyvale, CA', 'region:US-VA')).toBe(false);
    expect(locationMatches('Sunnyvale, CA', 'region:US-NY')).toBe(false);
    expect(locationMatches('McLean, VA', 'region:US-VA')).toBe(true);
  });

  it('folds NYC and New York City into New York, NY', () => {
    for (const location of ['NYC', 'New York City', 'New York City, NY', 'New York, NY']) {
      expect(locationMatches(location, 'city:new york|US-NY')).toBe(true);
      expect(locationMatches(location, 'region:US-NY')).toBe(true);
    }
    expect(locationMatches('SF', 'city:san francisco|US-CA')).toBe(true);
    expect(locationMatches('LA', 'city:los angeles|US-CA')).toBe(true);
  });

  it('folds remote variants into Remote and leaves city rows out', () => {
    expect(locationMatches('Remote', 'remote')).toBe(true);
    expect(locationMatches('Remote (US)', 'remote')).toBe(true);
    expect(locationMatches('Remote in USA', 'remote')).toBe(true);
    expect(locationMatches('San Jose, CA', 'remote')).toBe(false);
  });

  it('keeps United States for country-only rows', () => {
    expect(locationMatches('United States', 'country:US')).toBe(true);
    expect(locationMatches('US', 'country:US')).toBe(true);
    expect(locationMatches('San Jose, CA', 'country:US')).toBe(false);
    expect(locationMatches('United States', 'remote')).toBe(false);
  });

  it('parses comma-joined and pipe-joined multi-city rows', () => {
    for (const location of [
      'New York, NY, San Francisco, CA',
      'New York, NY | San Francisco, CA',
    ]) {
      expect(locationMatches(location, 'city:new york|US-NY')).toBe(true);
      expect(locationMatches(location, 'city:san francisco|US-CA')).toBe(true);
      expect(locationMatches(location, 'region:US-NY')).toBe(true);
      expect(locationMatches(location, 'region:US-CA')).toBe(true);
    }
  });

  it('parses Toronto, ON, Canada as one Canadian city', () => {
    const location = 'Toronto, ON, Canada';
    expect(locationMatches(location, 'city:toronto|Canada')).toBe(true);
    expect(locationMatches(location, 'country:Canada')).toBe(true);
    expect(locationMatches(location, 'region:CA-ON')).toBe(true);
    expect(locationMatches(location, 'city:san francisco|US-CA')).toBe(false);
    expect(locationMatches('Toronto, Canada', 'city:toronto|Canada')).toBe(true);
    expect(locationMatches('Toronto, ON', 'city:toronto|Canada')).toBe(true);
    expect(locationMatches('Toronto, ON', 'country:Canada')).toBe(true);
    expect(locationMatches('CAN Kanata, ON', 'city:kanata|Canada')).toBe(true);
    expect(locationMatches('Montréal, Canada', 'city:montreal|Canada')).toBe(true);
  });

  it('ranks pills by listings matched, with state names instead of codes', () => {
    const pills = topLocationPills([
      'San Jose, CA',
      'San Francisco, CA',
      'Toronto, Canada',
      'Toronto, ON, Canada',
      'NYC',
      'Remote (US)',
    ]);
    const california = pills.find((pill) => pill.key === 'region:US-CA');
    const canada = pills.find((pill) => pill.key === 'country:Canada');
    expect(california).toMatchObject({ label: 'California', count: 2 });
    expect(canada).toMatchObject({ label: 'Canada', count: 2 });
    expect(pills.find((pill) => pill.label === 'CA')).toBeUndefined();
    expect(pills.find((pill) => pill.key === 'remote')?.count).toBe(1);
    expect(pills.find((pill) => pill.key === 'city:toronto|Canada')?.count).toBe(2);
    expect(pills.find((pill) => pill.key === 'city:new york|US-NY')?.count).toBe(1);
  });
});
