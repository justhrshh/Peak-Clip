-- AlterTable
ALTER TABLE "payout_requests" ADD COLUMN     "cancellation_reason" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "cancelled_by" TEXT,
ADD COLUMN     "processing_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "financial_adjustments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "earning_id" TEXT,
    "type" VARCHAR(50) NOT NULL DEFAULT 'RETENTION_VIOLATION',
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "reason" TEXT NOT NULL,
    "source" VARCHAR(50) NOT NULL DEFAULT 'SYSTEM_RETENTION_WORKER',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "financial_adjustments_user_id_currency_idx" ON "financial_adjustments"("user_id", "currency");

-- CreateIndex
CREATE INDEX "financial_adjustments_submission_id_idx" ON "financial_adjustments"("submission_id");

-- CreateIndex
CREATE INDEX "financial_adjustments_campaign_id_idx" ON "financial_adjustments"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_adjustments_earning_id_type_key" ON "financial_adjustments"("earning_id", "type");

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_earning_id_fkey" FOREIGN KEY ("earning_id") REFERENCES "earnings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
