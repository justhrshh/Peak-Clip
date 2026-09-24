-- DropIndex
DROP INDEX IF EXISTS "submissions_user_id_campaign_id_normalized_url_key";

-- CreateIndex: Enforce campaign-wide uniqueness for duplicate clip submissions
CREATE UNIQUE INDEX "submissions_campaign_id_normalized_url_key" ON "submissions"("campaign_id", "normalized_url");
