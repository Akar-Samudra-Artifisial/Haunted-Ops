-- AlterEnum
-- A new enum value cannot be used in the transaction that adds it, so the check that names it is in the next migration.
ALTER TYPE "HuntEndReason" ADD VALUE 'diagnosed_upstream';
