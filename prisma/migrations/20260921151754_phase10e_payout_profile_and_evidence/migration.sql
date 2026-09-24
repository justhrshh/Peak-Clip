-- CreateEnum
CREATE TYPE "EvidenceStatus" AS ENUM ('UPLOADED', 'PENDING_REVIEW', 'ACCEPTED', 'REJECTED');

-- AlterTable
ALTER TABLE "payout_requests" ADD COLUMN     "profile_snapshot" JSONB;

-- CreateTable
CREATE TABLE "payout_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "wallet_address" VARCHAR(255) NOT NULL,
    "network" VARCHAR(50) NOT NULL,
    "wallet_name" VARCHAR(50) NOT NULL,
    "creator_handle" VARCHAR(100) NOT NULL,
    "platform" "Platform" NOT NULL DEFAULT 'YOUTUBE',
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_profile_audits" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "actor_user_id" TEXT,
    "actor_discord_id" TEXT NOT NULL,
    "old_network" VARCHAR(50),
    "new_network" VARCHAR(50),
    "old_wallet_name" VARCHAR(50),
    "new_wallet_name" VARCHAR(50),
    "platform" VARCHAR(50),
    "wallet_address_changed" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_profile_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_evidence" (
    "id" TEXT NOT NULL,
    "payout_request_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL DEFAULT 'YOUTUBE',
    "filename" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "file_size" BIGINT NOT NULL,
    "duration_seconds" DECIMAL(6,2),
    "storage_key" TEXT NOT NULL,
    "status" "EvidenceStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "version" INTEGER NOT NULL DEFAULT 1,
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by" TEXT,
    "rejection_reason" VARCHAR(50),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payout_profiles_user_id_key" ON "payout_profiles"("user_id");

-- CreateIndex
CREATE INDEX "payout_profiles_network_idx" ON "payout_profiles"("network");

-- CreateIndex
CREATE INDEX "payout_profile_audits_user_id_idx" ON "payout_profile_audits"("user_id");

-- CreateIndex
CREATE INDEX "payout_profile_audits_created_at_idx" ON "payout_profile_audits"("created_at");

-- CreateIndex
CREATE INDEX "payout_evidence_payout_request_id_idx" ON "payout_evidence"("payout_request_id");

-- CreateIndex
CREATE INDEX "payout_evidence_user_id_idx" ON "payout_evidence"("user_id");

-- CreateIndex
CREATE INDEX "payout_evidence_status_idx" ON "payout_evidence"("status");

-- AddForeignKey
ALTER TABLE "payout_profiles" ADD CONSTRAINT "payout_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_profile_audits" ADD CONSTRAINT "payout_profile_audits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_evidence" ADD CONSTRAINT "payout_evidence_payout_request_id_fkey" FOREIGN KEY ("payout_request_id") REFERENCES "payout_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_evidence" ADD CONSTRAINT "payout_evidence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
