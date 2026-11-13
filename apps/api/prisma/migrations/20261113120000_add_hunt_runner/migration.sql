-- CreateEnum
CREATE TYPE "HuntTrigger" AS ENUM ('auto', 'operator');

-- CreateEnum
CREATE TYPE "HuntEndReason" AS ENUM ('diagnosed', 'invalid_diagnosis', 'no_diagnosis', 'foreign_tool', 'credit_cap', 'daily_cap', 'tool_limit', 'timeout', 'mcp_startup', 'cli_error', 'stream_error', 'busy', 'cooldown', 'disabled', 'incident_closed', 'shutdown', 'api_restart');

-- AlterTable
-- Rows from before this migration (none outside tests) get the Service of their Incident, the trigger
-- `auto` and the model `unknown`; the defaults are dropped again below, as Prisma has none.
ALTER TABLE "Hunt" ADD COLUMN     "serviceId" TEXT,
ADD COLUMN     "trigger" "HuntTrigger" NOT NULL DEFAULT 'auto',
ADD COLUMN     "endReason" "HuntEndReason",
ADD COLUMN     "invalidCheck" TEXT,
ADD COLUMN     "model" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "toolCalls" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "culpritDeploy" TEXT,
ADD COLUMN     "culpritSha" TEXT,
ADD COLUMN     "summary" TEXT,
ADD COLUMN     "fixHint" TEXT,
ADD COLUMN     "durationMs" INTEGER;

UPDATE "Hunt" SET "serviceId" = "Incident"."serviceId" FROM "Incident" WHERE "Incident"."id" = "Hunt"."incidentId";
-- A Hunt of the old shape never ran, so it cannot be a success.
UPDATE "Hunt" SET "status" = 'failed', "endReason" = 'api_restart', "finishedAt" = COALESCE("finishedAt", CURRENT_TIMESTAMP)
  WHERE "status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled') AND "endReason" IS NULL;

ALTER TABLE "Hunt" ALTER COLUMN "serviceId" SET NOT NULL;
ALTER TABLE "Hunt" ALTER COLUMN "trigger" DROP DEFAULT;
ALTER TABLE "Hunt" ALTER COLUMN "model" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Evidence" ADD COLUMN     "cited" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "HuntStep" (
    "id" TEXT NOT NULL,
    "huntId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "tool" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HuntStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HuntStep_huntId_index_key" ON "HuntStep"("huntId", "index");

-- CreateIndex
CREATE INDEX "hunt_latest_per_service" ON "Hunt"("serviceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "hunt_started_at" ON "Hunt"("startedAt");

-- AddForeignKey
ALTER TABLE "Hunt" ADD CONSTRAINT "Hunt_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HuntStep" ADD CONSTRAINT "HuntStep_huntId_fkey" FOREIGN KEY ("huntId") REFERENCES "Hunt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written (Prisma cannot express them). A Hunt is a success only with a full, valid-looking
-- diagnosis and the reason `diagnosed`, and a diagnosis exists only on a success; an ended Hunt
-- always has a reason and a running one has none.
ALTER TABLE "Hunt" ADD CONSTRAINT "hunt_success_is_diagnosed" CHECK (
  ("status" <> 'succeeded' OR ("endReason" IS NOT DISTINCT FROM 'diagnosed' AND "culpritDeploy" IS NOT NULL AND "culpritSha" IS NOT NULL AND "summary" IS NOT NULL))
  AND ("endReason" IS DISTINCT FROM 'diagnosed' OR "status" = 'succeeded')
  AND ("culpritSha" IS NULL OR "status" = 'succeeded')
);
ALTER TABLE "Hunt" ADD CONSTRAINT "hunt_reason_matches_status" CHECK (("status" IN ('queued', 'running')) = ("endReason" IS NULL));
ALTER TABLE "Hunt" ADD CONSTRAINT "hunt_culprit_sha_format" CHECK ("culpritSha" IS NULL OR "culpritSha" ~ '^[0-9a-f]{40}$');
ALTER TABLE "Hunt" ADD CONSTRAINT "hunt_credits_not_negative" CHECK ("credits" >= 0 AND "toolCalls" >= 0);
ALTER TABLE "HuntStep" ADD CONSTRAINT "huntstep_index_positive" CHECK ("index" >= 1);
ALTER TABLE "Evidence" ADD CONSTRAINT "evidence_ref_length" CHECK (char_length("ref") BETWEEN 1 AND 80);
