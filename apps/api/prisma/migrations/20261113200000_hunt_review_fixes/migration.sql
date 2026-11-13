-- AlterEnum
ALTER TYPE "HuntEndReason" ADD VALUE 'daily_limit';

-- AlterTable
ALTER TABLE "Hunt" ADD COLUMN     "creditsEstimated" BOOLEAN NOT NULL DEFAULT false;
