-- CreateEnum
CREATE TYPE "ProposalKind" AS ENUM ('ai_patch', 'revert');

-- Replace the status enum. Old values map as: draft -> drafting, approved -> open, the others keep their name.
CREATE TYPE "ProposalStatus_new" AS ENUM ('drafting', 'checks_failed', 'open', 'merged', 'deployed', 'rejected', 'failed');
ALTER TABLE "Proposal" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Proposal" ALTER COLUMN "status" TYPE "ProposalStatus_new" USING (
  CASE "status"::text WHEN 'draft' THEN 'drafting' WHEN 'approved' THEN 'open' ELSE "status"::text END
)::"ProposalStatus_new";
DROP TYPE "ProposalStatus";
ALTER TYPE "ProposalStatus_new" RENAME TO "ProposalStatus";
ALTER TABLE "Proposal" ALTER COLUMN "status" SET DEFAULT 'drafting';

-- No one approves through the API any more: the merge on GitHub is the approval.
ALTER TABLE "Proposal" DROP COLUMN "approvedBy";

-- AlterTable
ALTER TABLE "Proposal"
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "kind" "ProposalKind",
  ADD COLUMN "failReason" TEXT,
  ADD COLUMN "aiFailReason" TEXT,
  ADD COLUMN "prNumber" INTEGER,
  ADD COLUMN "branch" TEXT,
  ADD COLUMN "baseBranch" TEXT,
  ADD COLUMN "baseSha" TEXT,
  ADD COLUMN "headSha" TEXT,
  ADD COLUMN "mergeSha" TEXT,
  ADD COLUMN "mergedBy" TEXT,
  ADD COLUMN "checks" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "patchFiles" INTEGER,
  ADD COLUMN "patchLines" INTEGER,
  ADD COLUMN "agentStarted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "credits" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "creditsEstimated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "etag" TEXT,
  ADD COLUMN "openedAt" TIMESTAMP(3),
  ADD COLUMN "mergedAt" TIMESTAMP(3),
  ADD COLUMN "deployedAt" TIMESTAMP(3),
  ADD COLUMN "finishedAt" TIMESTAMP(3);

-- Rows that existed before this flow have no pull request data, branch or fix commit. A row that is still moving
-- but cannot satisfy the constraints of the next migration is ended (a restart would have ended it too).
UPDATE "Proposal"
   SET "status" = 'failed', "failReason" = 'api_restart', "finishedAt" = CURRENT_TIMESTAMP
 WHERE "status" IN ('drafting', 'open', 'merged');
-- A final row keeps its status; a rejected one keeps its link only when it is a GitHub pull request URL.
UPDATE "Proposal" SET "prUrl" = NULL
 WHERE "prUrl" IS NOT NULL AND "prUrl" !~ '^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/[0-9]+$';

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_huntId_attempt_key" ON "Proposal"("huntId", "attempt");
CREATE INDEX "Proposal_status_idx" ON "Proposal"("status");
