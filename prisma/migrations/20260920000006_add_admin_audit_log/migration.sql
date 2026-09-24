-- CreateTable
CREATE TABLE "admin_audit_events" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_discord_id" TEXT NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(50) NOT NULL,
    "entity_id" TEXT NOT NULL,
    "previous_state" JSONB,
    "new_state" JSONB,
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_audit_events_entity_type_entity_id_idx" ON "admin_audit_events"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "admin_audit_events_actor_discord_id_idx" ON "admin_audit_events"("actor_discord_id");

-- CreateIndex
CREATE INDEX "admin_audit_events_action_idx" ON "admin_audit_events"("action");

-- CreateIndex
CREATE INDEX "admin_audit_events_created_at_idx" ON "admin_audit_events"("created_at");
