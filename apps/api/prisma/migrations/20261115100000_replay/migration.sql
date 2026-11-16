-- CreateTable
CREATE TABLE "Replay" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "recordedOn" DATE NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "body" JSONB NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Replay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "replay_recorded_on" ON "Replay"("recordedOn" DESC);
