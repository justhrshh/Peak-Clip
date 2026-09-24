/*
  Phase 10A: Campaign Budget, CPM, Fulfillment & Creator Cap Engine
  
  Migration notes:
  - total_budget uses DEFAULT 0 for existing rows only (DEV data).
    Production campaigns must have totalBudget set explicitly by admin.
  - consumedBudget defaults to 0 (correct initial state).
  - creatorEarningCap defaults to 600.00 (the platform standard cap).
  - Clip duration defaults match CAMPAIGN_POLICY constants (7s/120s).
  - retentionRequired defaults to false (opt-in).
  - COMPLETED added to CampaignStatus enum (system-only state).
  - FACEBOOK added to Platform enum (capability boundary).
*/

-- AlterEnum: Add COMPLETED campaign status (system-only, triggered by budget exhaustion)
ALTER TYPE "CampaignStatus" ADD VALUE 'COMPLETED';

-- AlterEnum: Add FACEBOOK platform (capability boundary, no live provider yet)
ALTER TYPE "Platform" ADD VALUE 'FACEBOOK';

-- AlterTable campaigns: Add all Phase 10A budget and policy columns
-- total_budget uses DEFAULT 0 to allow existing DEV rows to be migrated safely.
-- Admins must set a real budget before activating any existing DRAFT campaigns.
ALTER TABLE "campaigns"
  ADD COLUMN "consumed_budget"          DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "creator_earning_cap"      DECIMAL(14,2) NOT NULL DEFAULT 600.00,
  ADD COLUMN "max_clip_duration_seconds" INTEGER NOT NULL DEFAULT 120,
  ADD COLUMN "min_clip_duration_seconds" INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN "retention_days"           INTEGER,
  ADD COLUMN "retention_required"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "total_budget"             DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateIndex: compound index for fulfillment dashboard queries
CREATE INDEX "campaigns_status_consumed_budget_idx" ON "campaigns"("status", "consumed_budget");

-- CreateIndex: explicit index for creator cap queries (userId + campaignId on earnings)
CREATE INDEX "earnings_user_id_campaign_id_idx" ON "earnings"("user_id", "campaign_id");
