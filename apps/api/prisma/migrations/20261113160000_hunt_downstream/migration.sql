-- AlterEnum
ALTER TYPE "HuntEndReason" ADD VALUE 'downstream';

-- AlterTable
ALTER TABLE "Hunt" ADD COLUMN     "culpritService" TEXT,
ADD COLUMN     "stopDetail" TEXT;

-- Hand-written. A success from before this change was always about the hunted Service.
UPDATE "Hunt" SET "culpritService" = (SELECT "name" FROM "Service" WHERE "Service"."id" = "Hunt"."serviceId")
WHERE "status" = 'succeeded' AND "culpritService" IS NULL;

-- A success now also names the Service of the culprit deploy, and only a success has one.
ALTER TABLE "Hunt" DROP CONSTRAINT "hunt_success_is_diagnosed";
ALTER TABLE "Hunt" ADD CONSTRAINT "hunt_success_is_diagnosed" CHECK (
  ("status" <> 'succeeded' OR ("endReason" IS NOT DISTINCT FROM 'diagnosed' AND "culpritDeploy" IS NOT NULL AND "culpritSha" IS NOT NULL AND "culpritService" IS NOT NULL AND "summary" IS NOT NULL))
  AND ("endReason" IS DISTINCT FROM 'diagnosed' OR "status" = 'succeeded')
  AND ("culpritSha" IS NULL OR "status" = 'succeeded')
  AND ("culpritService" IS NULL OR "status" = 'succeeded')
);
ALTER TABLE "Hunt" ADD CONSTRAINT "hunt_culprit_service_name" CHECK ("culpritService" IS NULL OR "culpritService" IN ('gate', 'orders', 'payments', 'ledger'));
ALTER TABLE "Hunt" ADD CONSTRAINT "hunt_stop_detail_length" CHECK ("stopDetail" IS NULL OR char_length("stopDetail") BETWEEN 1 AND 200);
