-- AlterTable
ALTER TABLE "Hunt" ADD COLUMN     "diagnosedBy" TEXT,
ADD COLUMN     "linkedHuntId" TEXT;

-- Hand-written. A Hunt withdrawn because an upstream Hunt already found its cause says which Service
-- that Hunt was on, and only such a Hunt has the two columns.
ALTER TABLE "Hunt" ADD CONSTRAINT "hunt_diagnosed_by_matches_reason" CHECK (
  ("endReason" IS NOT DISTINCT FROM 'diagnosed_upstream') = ("diagnosedBy" IS NOT NULL)
  AND ("linkedHuntId" IS NULL OR "endReason" IS NOT DISTINCT FROM 'diagnosed_upstream')
  AND ("diagnosedBy" IS NULL OR "diagnosedBy" IN ('gate', 'orders', 'payments', 'ledger'))
);
