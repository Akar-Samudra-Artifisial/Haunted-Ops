-- CreateEnum
CREATE TYPE "SignalKind" AS ENUM ('error_rate', 'p95_ms', 'up');

-- CreateEnum
CREATE TYPE "HuntStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('metric', 'error', 'log', 'deploy', 'commit');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('draft', 'open', 'approved', 'merged', 'rejected');

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roomX" INTEGER NOT NULL,
    "roomY" INTEGER NOT NULL,
    "hauntLevel" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" BIGSERIAL NOT NULL,
    "serviceId" TEXT NOT NULL,
    "kind" "SignalKind" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "peakLevel" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hunt" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "status" "HuntStatus" NOT NULL DEFAULT 'queued',
    "credits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hunt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "huntId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "kind" "EvidenceKind" NOT NULL,
    "ref" TEXT NOT NULL,
    "detail" TEXT NOT NULL,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "huntId" TEXT NOT NULL,
    "prUrl" TEXT,
    "status" "ProposalStatus" NOT NULL DEFAULT 'draft',
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Service_name_key" ON "Service"("name");

-- CreateIndex
CREATE INDEX "signal_latest_per_service" ON "Signal"("serviceId", "kind", "at" DESC);

-- CreateIndex
CREATE INDEX "Incident_serviceId_openedAt_idx" ON "Incident"("serviceId", "openedAt" DESC);

-- CreateIndex
CREATE INDEX "Hunt_incidentId_idx" ON "Hunt"("incidentId");

-- CreateIndex
CREATE UNIQUE INDEX "Evidence_huntId_order_key" ON "Evidence"("huntId", "order");

-- CreateIndex
CREATE INDEX "Proposal_huntId_idx" ON "Proposal"("huntId");

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hunt" ADD CONSTRAINT "Hunt_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_huntId_fkey" FOREIGN KEY ("huntId") REFERENCES "Hunt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_huntId_fkey" FOREIGN KEY ("huntId") REFERENCES "Hunt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written: Prisma cannot express a partial unique index.
-- At most one open Incident per Service.
CREATE UNIQUE INDEX "incident_one_open_per_service" ON "Incident"("serviceId") WHERE "closedAt" IS NULL;
