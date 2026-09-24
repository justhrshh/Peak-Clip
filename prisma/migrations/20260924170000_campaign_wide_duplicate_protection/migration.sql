-- DropIndex
DROP INDEX IF EXISTS "submissions_user_id_campaign_id_normalized_url_key";

-- Create partial unique index: enforce campaign-wide uniqueness for non-rejected submissions
CREATE UNIQUE INDEX "submissions_campaign_id_normalized_url_active_idx" 
ON "submissions"("campaign_id", "normalized_url") 
WHERE "status" != 'REJECTED';

-- Create standard index for campaignId + normalizedUrl
CREATE INDEX IF NOT EXISTS "submissions_campaign_id_normalized_url_idx"
ON "submissions"("campaign_id", "normalized_url");
