-- CreateEnum
CREATE TYPE "EarningStatus" AS ENUM ('PENDING', 'ELIGIBLE', 'VOIDED');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';

-- CreateTable
CREATE TABLE "earnings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "source_snapshot_id" TEXT NOT NULL,
    "eligible_views" BIGINT NOT NULL,
    "rate_per_thousand" DECIMAL(10,2) NOT NULL,
    "gross_amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "status" "EarningStatus" NOT NULL DEFAULT 'ELIGIBLE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "earnings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "earnings_source_snapshot_id_key" ON "earnings"("source_snapshot_id");

-- CreateIndex
CREATE INDEX "earnings_user_id_status_idx" ON "earnings"("user_id", "status");

-- CreateIndex
CREATE INDEX "earnings_submission_id_idx" ON "earnings"("submission_id");

-- CreateIndex
CREATE INDEX "earnings_campaign_id_idx" ON "earnings"("campaign_id");

-- AddForeignKey
ALTER TABLE "earnings" ADD CONSTRAINT "earnings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "earnings" ADD CONSTRAINT "earnings_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "earnings" ADD CONSTRAINT "earnings_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "earnings" ADD CONSTRAINT "earnings_source_snapshot_id_fkey" FOREIGN KEY ("source_snapshot_id") REFERENCES "metric_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
