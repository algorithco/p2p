# P2-9 Follow-up Migration — DROP COLUMN buyer_id, seller_id

**Status:** Scheduled — do not execute in same deploy as P2-9 null-write change.

**Context:** `deals.buyer_id` / `deals.seller_id` are deprecated, now written as NULL in `dealService.createDealRecord()` (see `src/services/dealService.ts:145`). No code reads them (verified `grep -R 'buyer_id\|seller_id' --include='*.ts'` only writer). They remain as nullable columns to keep old rows readable and allow rollback.

**Follow-up (next deploy after P2-9 is stable in prod):**

```sql
-- Verify no non-null rows remain (should be 0 after deploy + time for old in-flight deals to close):
-- SELECT COUNT(*) FROM deals WHERE buyer_id IS NOT NULL OR seller_id IS NOT NULL;
ALTER TABLE deals DROP COLUMN IF EXISTS buyer_id;
ALTER TABLE deals DROP COLUMN IF EXISTS seller_id;
```

**Owner:** Backend
**Tracking:** Keep this file until migration is executed and verified, then delete.
**Decision date:** 2026-09-18 (P2-9 null-write landed, drop deferred per “don’t do both in same deploy” guideline)
