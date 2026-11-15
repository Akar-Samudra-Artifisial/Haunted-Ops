-- Internal detail of why the fixer stopped (fix-proposal-flow task 14). Never exposed by the API.
ALTER TABLE "Proposal" ADD COLUMN "aiFailDetail" TEXT;
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_aiFailDetail_length" CHECK ("aiFailDetail" IS NULL OR char_length("aiFailDetail") <= 300);
