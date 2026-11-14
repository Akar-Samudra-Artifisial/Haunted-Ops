-- Hand-written: Prisma cannot express these. They are in their own migration because the new enum values
-- of the previous one cannot be used in the transaction that adds them.

-- An open, merged or deployed Proposal has its pull request, its branch and the fix commit.
ALTER TABLE "Proposal" ADD CONSTRAINT "proposal_open_has_pr" CHECK (
  "status" NOT IN ('open', 'merged', 'deployed')
  OR ("prNumber" IS NOT NULL AND "prUrl" IS NOT NULL AND "headSha" IS NOT NULL AND "branch" IS NOT NULL AND "baseBranch" IS NOT NULL AND "kind" IS NOT NULL)
);

-- A merged or deployed Proposal has the merge commit and the merger.
ALTER TABLE "Proposal" ADD CONSTRAINT "proposal_merged_has_merge" CHECK (
  "status" NOT IN ('merged', 'deployed') OR ("mergeSha" IS NOT NULL AND "mergedBy" IS NOT NULL)
);

-- The link points at GitHub and nowhere else.
ALTER TABLE "Proposal" ADD CONSTRAINT "proposal_pr_url_github" CHECK (
  "prUrl" IS NULL OR "prUrl" ~ '^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/[0-9]+$'
);

-- A failed Proposal says why, with a fixed code; no other status has a fail reason.
ALTER TABLE "Proposal" ADD CONSTRAINT "proposal_failed_has_reason" CHECK (
  ("status" IN ('failed', 'checks_failed')) = ("failReason" IS NOT NULL)
);

-- An attempt is numbered from 1 and Credits are never negative.
ALTER TABLE "Proposal" ADD CONSTRAINT "proposal_attempt_positive" CHECK ("attempt" >= 1 AND "credits" >= 0);

-- At most one Proposal of a Hunt is moving at a time; a retry is a new attempt after the last one is final.
CREATE UNIQUE INDEX "proposal_one_active" ON "Proposal"("huntId") WHERE "status" IN ('drafting', 'open', 'merged');
