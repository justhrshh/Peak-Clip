-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW_RISK', 'REVIEW_REQUIRED', 'HIGH_RISK');

-- CreateEnum
CREATE TYPE "SignalSeverity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('VIEW_VELOCITY_CHANGE', 'LIKE_VIEW_RATIO', 'COMMENT_VIEW_RATIO', 'SHARE_VIEW_RATIO', 'ENGAGEMENT_CHANGE', 'SUDDEN_GROWTH', 'METRIC_INCONSISTENCY', 'DATA_UNAVAILABLE', 'PLATFORM_ANOMALY');

-- CreateTable
CREATE TABLE "metric_snapshots" (
    "id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "views" BIGINT NOT NULL,
    "likes" BIGINT NOT NULL,
    "comments" BIGINT NOT NULL,
    "shares" BIGINT,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'PROVIDER',
    "metadata" JSONB,

    CONSTRAINT "metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "risk_level" "RiskLevel" NOT NULL DEFAULT 'LOW_RISK',
    "score" DOUBLE PRECISION,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_signals" (
    "id" TEXT NOT NULL,
    "verification_id" TEXT NOT NULL,
    "type" "SignalType" NOT NULL,
    "severity" "SignalSeverity" NOT NULL,
    "value" JSONB NOT NULL,
    "explanation" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_signals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "metric_snapshots_submission_id_captured_at_idx" ON "metric_snapshots"("submission_id", "captured_at");

-- AddForeignKey
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_signals" ADD CONSTRAINT "verification_signals_verification_id_fkey" FOREIGN KEY ("verification_id") REFERENCES "verifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
