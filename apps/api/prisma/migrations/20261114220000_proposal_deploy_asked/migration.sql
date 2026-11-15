-- When the deploy of a merged fix was asked for (fix-proposal-flow task 18.3): a restart between asking and the
-- Deploy Record appearing looks for the record instead of asking again.
ALTER TABLE "Proposal" ADD COLUMN "deployAskedAt" TIMESTAMP(3);
