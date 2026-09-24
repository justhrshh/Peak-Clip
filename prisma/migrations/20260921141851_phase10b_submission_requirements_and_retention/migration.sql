-- CreateEnum
CREATE TYPE "RetentionStatus" AS ENUM ('NOT_REQUIRED', 'PENDING_CHECK', 'ACTIVE', 'FULFILLED', 'VIOLATED');

-- AlterTable
ALTER TABLE "submissions" ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "duration_seconds" INTEGER,
ADD COLUMN     "duration_status" VARCHAR(30) NOT NULL DEFAULT 'PENDING_CHECK',
ADD COLUMN     "last_availability_status" VARCHAR(30),
ADD COLUMN     "last_checked_at" TIMESTAMP(3),
ADD COLUMN     "requirements_snapshot" JSONB,
ADD COLUMN     "retention_days" INTEGER,
ADD COLUMN     "retention_deadline" TIMESTAMP(3),
ADD COLUMN     "retention_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "retention_status" "RetentionStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "retention_violated_at" TIMESTAMP(3),
ADD COLUMN     "retention_violation_reason" TEXT;

-- CreateIndex
CREATE INDEX "submissions_retention_status_retention_deadline_idx" ON "submissions"("retention_status", "retention_deadline");
