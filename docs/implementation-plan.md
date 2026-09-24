# Peak Clip — Client Deployment Implementation Plan (Phase 2)

This plan details the technical roadmap for preparing **Peak Clip** for single-tenant deployment into a client's Discord server. It is based on the Phase 1 Codebase Audit ([`docs/audit-report.md`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/docs/audit-report.md)) and the live server export ([`audit-output/`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/audit-output/)).

---

## 1. Prioritized Implementation Roadmap

| Priority | Task ID | Description | Severity | Effort | Risk |
|:---:|---|---|:---:|:---:|:---:|
| **1** | **IMP-01** | Un-ignore Prisma migrations, commit SQL, and verify clean DB deployment | 🔴 BLOCKER | **S** | Low |
| **2** | **IMP-02** | Campaign-wide clip deduplication (`campaignId + normalizedUrl`) with pre-migration SQL | 🔴 BLOCKER | **M** | Medium |
| **3** | **IMP-03** | Remove `MessageContent` privileged intent via `/payout-upload` slash command | 🔴 BLOCKER | **M** | Medium |
| **4** | **IMP-04** | Fail closed on missing `publishedAt` & make submission window configurable | 🟡 SHOULD FIX | **S** | Low |
| **5** | **IMP-05** | Config layer overhaul: enforce `DISCORD_GUILD_ID`, role IDs, & branding | 🟡 SHOULD FIX | **M** | Low |
| **6** | **IMP-06** | Rename `/verify` to `/register` and bind configured creator role | 🟡 SHOULD FIX | **S** | Low |
| **7** | **IMP-07** | Implement $N$-strike consecutive missing check before deletion penalty | 🟡 SHOULD FIX | **M** | Medium |
| **8** | **IMP-08** | Batch YouTube API requests (up to 50 IDs per call) | 🟡 SHOULD FIX | **M** | Medium |
| **9** | **IMP-09** | Platform-specific polling intervals, tracking age cap & Apify cost limits | 🟡 SHOULD FIX | **M** | Low |
| **10** | **IMP-10** | Wrap `InteractionCreate` in top-level try/catch with user-friendly fallback | 🟢 NICE TO HAVE | **S** | Low |
| **11** | **IMP-11** | Remove raw `diagnostic.log` disk append and route to structured logger | 🟢 NICE TO HAVE | **S** | Low |
| **12** | **IMP-12** | System health & operational diagnostic command (`/health`) | 🟢 NICE TO HAVE | **M** | Low |
| **13** | **IMP-13** | Critical staff alerting via Discord webhook (`#bot-errors`) & Sentry stub | 🟢 NICE TO HAVE | **M** | Low |
| **14** | **IMP-14** | Core test suite additions (ledger, deduplication, missing publishedAt, strikes) | 🟡 SHOULD FIX | **L** | Low |

---

## 2. Detailed Task Specifications

### IMP-01: Prisma Migrations Un-ignore & Verification (F-01)
- **What Changes**:
  1. Remove `prisma/migrations/` from [`.gitignore`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/.gitignore#L20).
  2. Verify that all 13 migration directories in `prisma/migrations/` match [`prisma/schema.prisma`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/prisma/schema.prisma) using `npx prisma migrate diff`.
  3. Ensure `prisma migrate deploy` succeeds on an empty PostgreSQL database without requiring interactive prompts or dev seeding.
- **Files Affected**:
  - `.gitignore`
  - `prisma/migrations/*`
- **Effort**: **S** (Small) | **Risk**: Low
- **Verification**: Run `npx prisma migrate status` and test deployment against a clean local test DB container.

---

### IMP-02: Campaign-Wide Duplicate Protection (F-03)
- **What Changes**:
  1. Modify `Submission` model in `prisma/schema.prisma`:
     - Replace `@@unique([userId, campaignId, normalizedUrl])` with `@@unique([campaignId, normalizedUrl])`.
  2. Pre-Migration Data Guard (SQL):
     Detect if any existing duplicate URLs exist across different creators before applying the index:
     ```sql
     SELECT campaign_id, normalized_url, COUNT(*) as count, array_agg(user_id) as users
     FROM submissions
     GROUP BY campaign_id, normalized_url
     HAVING COUNT(*) > 1;
     ```
  3. Create Prisma migration: `add_campaign_wide_duplicate_index`.
  4. Update [`src/modules/submissions/submission.repository.js`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/modules/submissions/submission.repository.js#L82):
     - Replace `findDuplicateSubmission(userId, campaignId, normalizedUrl)` with `findDuplicateSubmission(campaignId, normalizedUrl)`.
  5. Update [`src/modules/submissions/submission.service.js`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/modules/submissions/submission.service.js#L98):
     - Throw `DuplicateSubmissionError` if any user has already submitted the clip to the campaign.
- **Files Affected**:
  - `prisma/schema.prisma`
  - `prisma/migrations/*`
  - `src/modules/submissions/submission.repository.js`
  - `src/modules/submissions/submission.service.js`
- **Effort**: **M** (Medium) | **Risk**: Medium (schema index change)
- **Verification**: Test submitting the exact same YouTube clip URL from User A and User B. User B's submission must be rejected with `DuplicateSubmissionError`.

---

### IMP-03: Remove Privileged `MessageContent` Intent (F-02)
- **What Changes**:
  1. Remove `GatewayIntentBits.MessageContent` from [`src/bot/client.js`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/bot/client.js#L29).
  2. Implement `/payout-upload` slash command:
     - Includes a mandatory `attachment` option (`AttachmentBuilder` / video file).
     - Validates that the invoking user has an active payout draft session.
     - Routes the attachment directly through [`validateEvidenceFile()`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/modules/evidence/evidence.validator.js) and [`storageService.saveFile()`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/modules/storage/storage.service.js).
  3. Deprecate `messageCreate` attachment listener in [`src/bot/events/messageCreate.handler.js`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/bot/events/messageCreate.handler.js).
  4. Add friendly startup exception handling in [`src/bot/client.js`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/bot/client.js#L113):
     - If `client.login()` throws `DisallowedIntents` (4014), log clear step-by-step instructions for the Discord Developer Portal.
- **Files Affected**:
  - `src/bot/client.js`
  - `src/bot/commands/payoutUpload.js` (new command)
  - `src/bot/components/payout.components.js`
  - `src/bot/events/messageCreate.handler.js`
- **Effort**: **M** (Medium) | **Risk**: Medium (payout evidence UX modification)
- **Verification**: Authenticate bot with 0 privileged intents. Verify that `/payout-upload` accepts video evidence, validates duration (<40s), and attaches to the payout request.

---

### IMP-04: Missing `publishedAt` Handling & Configurable Submission Window (F-06)
- **What Changes**:
  1. **Fail Closed on Missing Timestamps**:
     In [`src/modules/verification/verification.service.js`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/modules/verification/verification.service.js#L281):
     - If `publishedAt` is `null` or `undefined` (scraper failed to extract publication date):
       - Do **NOT** auto-approve.
       - Transition submission to `UNDER_REVIEW` (or `PENDING_MANUAL_REVIEW`) with reason: `Missing publication timestamp; manual staff review required`.
       - Record `MODERATION_ACTIONS.FLAGGED` and dispatch alert to `#review-queue`.
  2. **Configurable Submission Window**:
     - Check `campaign.requirements?.submissionWindowSeconds ?? config.submissionWindowSeconds ?? 3600`.
     - Allow campaigns to set custom submission windows (e.g. 24 hours / 86400s, or 0 to disable).
     - Add `DEFAULT_SUBMISSION_WINDOW_HOURS=1` to `.env`.
- **Files Affected**:
  - `src/config/index.js`
  - `src/modules/verification/verification.service.js`
  - `src/modules/campaigns/campaign.validation.js`
- **Effort**: **S** (Small) | **Risk**: Low
- **Verification**: Submit a mock clip returning `publishedAt: null`; confirm it flags to `UNDER_REVIEW`. Submit a clip published 5 hours ago to a campaign with `submissionWindowHours: 24`; confirm it passes.

---

### IMP-05: Config Layer & Multi-Server Hardening
- **What Changes**:
  1. Enforce `DISCORD_GUILD_ID` as required in production schema in [`src/config/index.js`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/config/index.js#L76).
  2. Support role ID mapping via `.env`:
     - `DISCORD_ADMIN_ROLE_IDS` (comma-separated).
     - `DISCORD_CAMPAIGN_MANAGER_ROLE_IDS` (comma-separated).
     - `DISCORD_CREATOR_ROLE_ID` (Snowflake ID).
  3. Remove all hardcoded role names (`Peak Admin`, `Campaign Manager`) from [`src/modules/admin/admin.auth.js`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/modules/admin/admin.auth.js#L151).
  4. Make branding configurable via env:
     - `AGENCY_NAME` (default: "Peak Clip")
     - `BOT_DISPLAY_NAME` (default: "Peak Clip")
  5. Remove hardcoded user IDs (`978305861430693960`) from UI placeholders in [`src/bot/components/staff.modals.js`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/bot/components/staff.modals.js#L106).
- **Files Affected**:
  - `src/config/index.js`
  - `.env.example`
  - `src/modules/admin/admin.auth.js`
  - `src/bot/components/staff.modals.js`
  - `src/bot/embeds/dashboard.embeds.js`
  - `src/bot/embeds/submission.embeds.js`
- **Effort**: **M** (Medium) | **Risk**: Low
- **Verification**: Run with arbitrary role IDs and custom `AGENCY_NAME`; confirm embeds and permission checks use configured values.

---

### IMP-06: Rename `/verify` & Integrate Client Verification (F-05)
- **What Changes**:
  1. Rename slash command `/verify` $\rightarrow$ `/register` (or `/creator-onboard`):
     - Prevents command collision with the client's existing verification bot (e.g. Wick, Double Counter).
  2. In [`src/bot/commands/register.js`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/bot/commands/verify.js):
     - Optional gate: If `CLIENT_VERIFIED_ROLE_ID` is set in env, assert that the user has this role before allowing them to register as a creator.
     - Role assignment: Assign the role specified by `DISCORD_CREATOR_ROLE_ID` instead of searching for a role named "Creator".
- **Files Affected**:
  - `src/bot/commands/verify.js` $\rightarrow$ renamed to `src/bot/commands/register.js`
  - `src/scripts/deploy-commands.js`
  - `src/bot/client.js`
- **Effort**: **S** (Small) | **Risk**: Low
- **Verification**: Execute `/register` in a test guild; confirm proper role assignment without colliding with `/verify`.

---

### IMP-07: Deletion Penalties ($N$-Strike Consecutive Missing Checks)
- **Current State Analysis (Requirement 12)**:
  - In [`src/modules/retention/retention.service.js`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/modules/retention/retention.service.js#L93):
    - `DATA_UNAVAILABLE` is safely preserved (`status: ACTIVE`).
    - `TransientProviderError` bubbles up to BullMQ retry.
    - `ConfigurationAuthError` is safely preserved without penalizing the creator.
    - **VULNERABILITY**: On a `PermanentContentError` (or `isAvailable: false`), the service **immediately** transitions the clip to `VIOLATED` on a **single check**. A temporary upstream API anomaly or 404 blip will falsely penalize creators and cancel payouts.
- **What Changes**:
  1. Add `missingConsecutiveChecks Int @default(0)` to `Submission` in `schema.prisma`.
  2. In `retention.service.js`:
     - When `PermanentContentError` or `isAvailable: false` is returned:
       - Increment `missingConsecutiveChecks`.
       - If `missingConsecutiveChecks < 3`: Keep status `ACTIVE`, record warning log, and schedule next check.
       - If `missingConsecutiveChecks >= 3`: Transition to `VIOLATED` and execute financial penalties.
     - When content is confirmed available: Reset `missingConsecutiveChecks = 0`.
- **Files Affected**:
  - `prisma/schema.prisma`
  - `prisma/migrations/*`
  - `src/modules/retention/retention.service.js`
- **Effort**: **M** (Medium) | **Risk**: Medium
- **Verification**: Mock provider returning 404 once, then 200; verify status stays `ACTIVE`. Mock provider returning 404 three times consecutively; verify status transitions to `VIOLATED`.

---

### IMP-08: Batch YouTube API Requests (F-08)
- **What Changes**:
  1. In [`src/providers/youtube/youtube.provider.js`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/providers/youtube/youtube.provider.js):
     - Implement `getBatchMetrics(videoIds)` querying `/videos?part=snippet,contentDetails,statistics,status&id=${videoIds.slice(0, 50).join(',')}`.
     - Normalizes results into a map of `videoId -> metrics`.
  2. In [`src/workers/metric-polling.worker.js`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/workers/metric-polling.worker.js):
     - Group eligible YouTube clips into chunks of up to 50 items.
     - Execute 1 API call per chunk instead of 50 individual HTTP calls.
- **Files Affected**:
  - `src/providers/youtube/youtube.provider.js`
  - `src/workers/metric-polling.worker.js`
- **Effort**: **M** (Medium) | **Risk**: Medium
- **Verification**: Run batch query with 25 YouTube IDs; confirm only 1 HTTP request is dispatched and all 25 snapshots are saved correctly.

---

### IMP-09: Platform-Specific Polling & Apify Cost Bounds (F-07)
- **Apify Cost Calculation**:
  - 1 run $\approx$ \$0.005.
  - 50 clips polled hourly = $50 \times 24 \times 30 = 36,000$ runs/month $\rightarrow$ **\$180.00 / month**.
  - 50 clips polled every 12h = $50 \times 2 \times 30 = 3,000$ runs/month $\rightarrow$ **\$15.00 / month**.
  - 50 clips polled every 24h = $50 \times 1 \times 30 = 1,500$ runs/month $\rightarrow$ **\$7.50 / month**.
- **What Changes**:
  1. Add granular interval settings to `.env`:
     - `METRIC_POLL_INTERVAL_YOUTUBE_MINS=60` (hourly for YouTube)
     - `METRIC_POLL_INTERVAL_TIKTOK_MINS=720` (every 12h for TikTok)
     - `METRIC_POLL_INTERVAL_INSTAGRAM_MINS=720` (every 12h for Instagram)
     - `METRIC_POLL_MAX_TRACKING_DAYS=14` (stop polling clips older than 14 days)
  2. In [`src/modules/verification/polling.policy.js`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/modules/verification/polling.policy.js):
     - Evaluate `submission.platform` and last snapshot timestamp to determine if clip is due for polling.
     - Skip polling if `submission.submittedAt < now - MAX_TRACKING_DAYS`.
- **Files Affected**:
  - `src/config/index.js`
  - `src/modules/verification/polling.policy.js`
  - `src/workers/metric-scheduler.js`
- **Effort**: **M** (Medium) | **Risk**: Low
- **Verification**: Test scheduling with mixed platforms; confirm YouTube runs hourly while TikTok is deferred to 12h intervals.

---

### IMP-10: Top-Level Interaction Error Trap (F-10)
- **What Changes**:
  In [`src/bot/client.js:62`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/bot/client.js#L62):
  ```javascript
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handleInteraction(interaction);
    } catch (unhandledErr) {
      logger.error({ err: unhandledErr.message, stack: unhandledErr.stack }, 'Top-level interaction error trap triggered');
      if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '❌ An unexpected error occurred. Please try again later.',
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      }
    }
  });
  ```
- **Files Affected**:
  - `src/bot/client.js`
- **Effort**: **S** (Small) | **Risk**: Low
- **Verification**: Trigger a forced mock error inside an interaction; verify bot catches it and does not exit via `process.on('unhandledRejection')`.

---

### IMP-11: Remove Raw Disk Log Appending (F-09)
- **What Changes**:
  - Remove `fs.appendFileSync('diagnostic.log', ...)` in [`src/bot/events/messageCreate.handler.js:151`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/bot/events/messageCreate.handler.js#L151).
  - Use `logger.debug(diagnosticPayload, 'Payout upload inspection')` which writes to stdout and respects `LOG_LEVEL`.
- **Files Affected**:
  - `src/bot/events/messageCreate.handler.js`
- **Effort**: **S** (Small) | **Risk**: Low
- **Verification**: Verify no `diagnostic.log` is created or grown on disk during upload flows.

---

### IMP-12: System Health Diagnostic Command (`/health`)
- **What Changes**:
  - Implement `/health` command restricted to `ADMIN` roles.
  - Executes live diagnostic checks and returns an embed:
    - **Database**: Ping PostgreSQL via `SELECT 1` (Latency in ms).
    - **Redis**: Ping Redis via `redis.ping()` (Status / Latency).
    - **Bot Permissions**: Verify `ManageRoles`, `ManageChannels`, `SendMessages`, `EmbedLinks`.
    - **Configured Roles**: Validate that role IDs set in `DISCORD_ADMIN_ROLE_IDS`, `DISCORD_CAMPAIGN_MANAGER_ROLE_IDS`, and `DISCORD_CREATOR_ROLE_ID` exist in guild.
    - **Channel Bindings**: Check existence of `#campaigns`, `#submissions`, `#review-queue`, `#payout-audit`.
- **Files Affected**:
  - `src/bot/commands/health.js` (new command)
  - `src/scripts/deploy-commands.js`
- **Effort**: **M** (Medium) | **Risk**: Low
- **Verification**: Run `/health` in Discord; verify embed displays checkmarks/warnings for all subsystems.

---

### IMP-13: Critical Staff Alerting via Webhook & Sentry Stub
- **What Changes**:
  1. Add `DISCORD_ALERT_WEBHOOK_URL` to env.
  2. Implement `src/utils/alerting.js`:
     - Dispatches formatted alert embeds for:
       - Redis disconnect or worker crash.
       - YouTube API 403 quota exhaustion.
       - Consecutive database connection failures.
  3. Optional Sentry integration: If `SENTRY_DSN` is provided, initialize `@sentry/node` for production error capture.
- **Files Affected**:
  - `src/utils/alerting.js` (new)
  - `src/app.js`
  - `src/config/index.js`
- **Effort**: **M** (Medium) | **Risk**: Low
- **Verification**: Simulate Redis disconnect; confirm alert embed is sent to the configured staff webhook.

---

### IMP-14: Test Suite Additions & Hardening
- **What Changes**:
  Add dedicated test suites in `tests/`:
  1. **Ledger & Earnings Idempotency**: Simulate identical snapshots replayed 5 times; assert exactly 1 earning row is created and balances match.
  2. **Cross-User Duplicate Submission**: Submit same video from User A and User B; assert User B fails with `DuplicateSubmissionError`.
  3. **Missing `publishedAt`**: Pass metadata without publication date; assert status is `UNDER_REVIEW` (fails closed).
  4. **Deletion Classification**: Verify $N=1$ and $N=2$ missing checks keep status `ACTIVE`; verify $N=3$ transitions to `VIOLATED`.
- **Files Affected**:
  - `tests/deployment_hardening.test.js` (new)
- **Effort**: **L** (Large) | **Risk**: Low
- **Verification**: Run `npm test`; verify 100% pass rate.

---

## 3. Open Questions for the Client / Server Admin

Before proceeding to Phase 3 implementation, please provide feedback on the following operational decisions:

1. **Command Renaming for Onboarding**:
   - We plan to rename `/verify` to `/register` (or `/creator-onboard`) to prevent collision with your existing server verification bot. Do you prefer `/register` or another command name?
2. **External Verification Gate**:
   - Should Peak Clip require members to hold your existing server's "Verified" role before allowing them to run `/register` and submit clips? If yes, what is that role's Snowflake ID?
3. **Apify Polling Frequency**:
   - For TikTok and Instagram clips, polling every 12 hours costs ~\$15/month for 50 active clips, whereas hourly polling costs ~\$180/month. Is a 12-hour or 24-hour interval acceptable for TikTok/Instagram, while keeping YouTube hourly?
4. **Active Tracking Lifespan**:
   - How long should a clip actively accrue view growth after publication? (Recommended: 14 days or 30 days). After this window, the clip is finalized and polling stops to preserve API quotas.
5. **Staff Alerting Channel**:
   - Would you like critical error alerts (e.g. YouTube API quota exhausted, worker downtime) sent to a private `#bot-errors` channel via a Discord Webhook URL?
