// AGPL-3.0 — unit tests for the checker input classifier (pure, no network).
import { describe, it, expect } from 'vitest';
import { classifyInput } from './url';

describe('classifyInput', () => {
  it('classifies @usernames and bare names', () => {
    expect(classifyInput('@durov')).toEqual({ kind: 'username', value: 'durov' });
    expect(classifyInput('durov')).toEqual({ kind: 'username', value: 'durov' });
  });

  it('classifies t.me links', () => {
    expect(classifyInput('https://t.me/durov').kind).toBe('username');
    expect(classifyInput('t.me/nft/PlushPepe/123').kind).toBe('gift');
  });

  it('never hijacks digit-suffixed usernames as gifts', () => {
    expect(classifyInput('user123').kind).toBe('username');
  });

  it('classifies bare gift "Name #123"', () => {
    const r = classifyInput('Plush Pepe #123');
    expect(r.kind).toBe('gift');
    expect(r.extra).toEqual({ number: '123' });
  });

  it('rejects empty input', () => {
    expect(classifyInput('').kind).toBe('unsupported');
    expect(classifyInput('   ').kind).toBe('unsupported');
  });

  it('marks anonymous-number collectibles out of scope', () => {
    const r = classifyInput('https://fragment.com/number/888123');
    expect(r.kind).toBe('unsupported');
    expect(r.reason).toBe('phone_collectible_unsupported');
  });
});
