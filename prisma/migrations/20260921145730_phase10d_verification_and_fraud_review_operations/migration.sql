/*
  Warnings:

  - You are about to drop the column `last_checked_at` on the `submissions` table. All the data in the column will be lost.

*/
-- AlterEnum
ALTER TYPE "SubmissionStatus" ADD VALUE 'POST_APPROVAL_REVIEW';

-- AlterTable
ALTER TABLE "submissions" DROP COLUMN "last_checked_at",
ADD COLUMN     "moderated_at" TIMESTAMP(3),
ADD COLUMN     "moderated_by" TEXT,
ADD COLUMN     "moderation_notes" TEXT,
ADD COLUMN     "structured_reason" VARCHAR(50);

-- CreateTable
CREATE TABLE "submission_moderation_history" (
    "id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "previous_status" "SubmissionStatus" NOT NULL,
    "new_status" "SubmissionStatus" NOT NULL,
    "actor_user_id" TEXT,
    "actor_discord_id" TEXT NOT NULL DEFAULT 'SYSTEM',
    "actor_type" TEXT NOT NULL DEFAULT 'SYSTEM',
    "reason" TEXT,
    "notes" TEXT,
    "verification_id" TEXT,
    "evidence" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_moderation_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "submission_moderation_history_submission_id_idx" ON "submission_moderation_history"("submission_id");

-- CreateIndex
CREATE INDEX "submission_moderation_history_action_idx" ON "submission_moderation_history"("action");

-- CreateIndex
CREATE INDEX "submission_moderation_history_created_at_idx" ON "submission_moderation_history"("created_at");

-- AddForeignKey
ALTER TABLE "submission_moderation_history" ADD CONSTRAINT "submission_moderation_history_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
