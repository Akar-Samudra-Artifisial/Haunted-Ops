-- CreateEnum
CREATE TYPE "HauntReasonKind" AS ENUM ('error_rate', 'p95', 'down');

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "reasonKind" "HauntReasonKind",
ADD COLUMN     "reasonValue" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "signal_at" ON "Signal"("at");

-- Hand-written (Prisma cannot express it): a reason has a kind and a value, or neither.
-- The partial unique index "incident_one_open_per_service" from the first migration is untouched.
ALTER TABLE "Service" ADD CONSTRAINT "service_reason_both_or_none"
  CHECK (("reasonKind" IS NULL) = ("reasonValue" IS NULL));
