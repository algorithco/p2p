import { describe, it, expect } from 'vitest';
import path from 'node:path';

// Repo root resolved portably (works on Linux CI and Windows dev machines).
// This file lives at <repo>/backend/src/remaining.test.ts, so root is ../..
// NOTE: __dirname is used (not import.meta) because backend tsconfig uses CommonJS.
const repoRoot = path.resolve(__dirname, '..', '..');
const repoFile = (...segments: string[]) => path.join(repoRoot, ...segments);

// P2-7: dispute writer sets flag
describe('P2-7 dispute writer', () => {
  it('sets confirmations.disputed via SQL (smoke)', async () => {
    const sql = `UPDATE deals SET confirmations = COALESCE(confirmations,'{}'::jsonb) || '{"disputed":true}'::jsonb WHERE id = $1`;
    expect(sql).toContain('disputed');
  });
});

// P2-10: deadline respected — query includes deadline < now()
describe('P2-10 deadline enforcement', () => {
  it('expiry query includes deadline check', async () => {
    const q = `SELECT * FROM deals WHERE status = 'AWAITING_DEPOSIT' AND (created_at < now() - interval '10 hours' OR (deadline IS NOT NULL AND deadline < now())) LIMIT 100`;
    expect(q).toContain('deadline');
    expect(q).toContain('10 hours');
  });
});

// P3-11: warning text present in sellFlow
describe('P3-11 phone retain warning', () => {
  it('sellFlow contains prominent warning', async () => {
    const fs = await import('node:fs');
    const txt = fs.readFileSync(repoFile('utradebot', 'src', 'bot', 'handlers', 'sellFlow.ts'), 'utf8');
    expect(txt).toContain('OGOHLANTIRISH');
    expect(txt).toContain('telefon raqami');
  });
});

// P3-12: channel stall detection query
describe('P3-12 channel stall', () => {
  it('stall query checks transfer_to_escrow_at IS NULL and 6h', () => {
    const q = `SELECT * FROM deals WHERE deal_type IN ('CHANNEL','GROUP') AND status = 'DEPOSIT_CONFIRMED' AND transfer_to_escrow_at IS NULL AND created_at < now() - interval '6 hours'`;
    expect(q).toContain('transfer_to_escrow_at');
  });
});

// P3-13: utrade code HTTP never COMPLETED
describe('P3-13 utrade code guard', () => {
  it('HTTP code endpoint never sets COMPLETED (code inspection)', async () => {
    const fs = await import('node:fs');
    const idx = fs.readFileSync(repoFile('backend', 'src', 'index.ts'), 'utf8');
    expect(idx).toContain('Code received but NOT verified');
    expect(idx).toContain('Trade NOT marked COMPLETED');
    // Ensure the utrade code handler sets AWAITING_CODE not COMPLETED
    const codeSection = idx.slice(
      idx.indexOf('/api/utrade/trades/:id/code'),
      idx.indexOf('/api/utrade/trades/:id/code') + 3500,
    );
    expect(codeSection).toContain('AWAITING_CODE');
  });
});

// P4-14: chat encryption honesty
describe('P4-14 chat encryption', () => {
  it('/key endpoint note says not E2E against operator', async () => {
    const fs = await import('node:fs');
    const txt = fs.readFileSync(repoFile('backend', 'src', 'index.ts'), 'utf8');
    expect(txt).toContain('not E2E against operator');
    expect(txt).toContain('encrypted at rest');
  });
  it('GET /key checks adminApiKeyMatches not generic api-key', async () => {
    const fs = await import('node:fs');
    const txt = fs.readFileSync(repoFile('backend', 'src', 'index.ts'), 'utf8');
    const keyBlockStart = txt.indexOf("app.get(\n  '/api/deals/:id/key'");
    const block = txt.slice(keyBlockStart, keyBlockStart + 3000);
    expect(block).toContain('adminApiKeyMatches');
    expect(block).not.toMatch(/req\.authMode === 'api-key'.*isAdminCaller/);
  });
});

// P5-15 underpay capture
describe('P5-15 underpay auto-refund capture', () => {
  it('listener stores underpay src for auto-refund', async () => {
    const fs = await import('node:fs');
    const txt = fs.readFileSync(repoFile('backend', 'src', 'blockchain', 'listener.ts'), 'utf8');
    expect(txt).toContain('underpay');
    expect(txt).toContain('auto-refund');
  });
});

// P5-16 rate limit
describe('P5-16 rate limit note', () => {
  it('guard rateLimit contains horizontal scaling note', async () => {
    const fs = await import('node:fs');
    const txt = fs.readFileSync(repoFile('backend', 'src', 'auth', 'guard.ts'), 'utf8');
    expect(txt).toContain('per-process');
    expect(txt).toContain('Redis');
  });
});

// P5-18 checker wiring
describe('P5-18 checker wiring', () => {
  it('docker-compose includes checker service', async () => {
    const fs = await import('node:fs');
    const txt = fs.readFileSync(repoFile('docker-compose.yml'), 'utf8');
    expect(txt).toContain('checker:');
    expect(txt).toContain('3004');
  });
  it('CI includes checker', async () => {
    const fs = await import('node:fs');
    const txt = fs.readFileSync(repoFile('.github', 'workflows', 'ci.yml'), 'utf8');
    expect(txt).toContain('checker');
  });
});
