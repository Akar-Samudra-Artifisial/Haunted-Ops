-- Hand-written. GitHub answers `merged_by: null` for some merges (a deleted account, some app merges): the merge is
-- real, only the login is unknown. A merged or deployed Proposal still needs its merge commit; the login may be null.
ALTER TABLE "Proposal" DROP CONSTRAINT "proposal_merged_has_merge";
ALTER TABLE "Proposal" ADD CONSTRAINT "proposal_merged_has_merge" CHECK (
  "status" NOT IN ('merged', 'deployed') OR "mergeSha" IS NOT NULL
);
