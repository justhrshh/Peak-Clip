# Peak Clip — Production Codebase Audit Report (Phase 1)

This comprehensive audit evaluates the readiness of **Peak Clip** (Node.js, Discord.js, PostgreSQL/Prisma, Redis/BullMQ) for isolated, single-tenant deployment into a client's Discord server.

---

## Executive Summary & Severity Ranking

| Finding | Topic | Severity | Impact Summary |
|---|---|---|---|
| **F-01** | Prisma Migrations Ignored | 🔴 **BLOCKER** | `prisma/migrations/` is in `.gitignore`; fresh deployments will fail `prisma migrate deploy` because migrations are omitted from git. |
| **F-02** | Privileged MessageContent Intent | 🔴 **BLOCKER** | Client bot token will fail gateway login with `DisallowedIntents` (4014) unless manually toggled in Developer Portal. |
| **F-03** | Cross-User Clip Duplication | 🔴 **BLOCKER** | DB unique constraint is `[userId, campaignId, normalizedUrl]`. Multiple users can submit the identical viral clip and all get paid for the same views. |
| **F-04** | Hardcoded Test Server Fallbacks & Role Names | 🟡 **SHOULD FIX** | Hardcoded role names (`Peak Admin`, `Campaign Manager`) and test guild ID `1551276972703744060` in QA/test scripts; staff auth breaks if client uses custom roles (`Staff`, `Moderator`). |
| **F-05** | Command Collision with `/verify` | 🟡 **SHOULD FIX** | Existing server verification bots (Wick, Vulcan, Double Counter) collide with Peak Clip's `/verify` command. |
| **F-06** | Rigid 1-Hour Publication Window & Zero Ownership Proof | 🟡 **SHOULD FIX** | 3600-second window is hardcoded; missing `publishedAt` completely bypasses freshness; no verification that submitter owns the social account. |
| **F-07** | Apify Compute Cost & Polling Frequency | 🟡 **SHOULD FIX** | Hourly polling on TikTok/Instagram triggers individual Apify Actor runs per clip, risking severe API compute bills ($0.005–$0.01/run). |
| **F-08** | Single-Call YouTube API Quota Inefficiency | 🟡 **SHOULD FIX** | YouTube API queries clips 1-by-1 instead of batching up to 50 IDs per request (`id=id1,id2...`), burning 1 quota unit per clip. |
| **F-09** | Unhandled Gateway Interruption & Error Logging | 🟢 **NICE TO HAVE** | No external error monitoring (Sentry/webhook alerts); `diagnostic.log` appends unrotated logs to disk; interaction errors in event listener could crash process. |
| **F-10** | Unconfigured Environment Keys Standalone Fallback | 🟢 **NICE TO HAVE** | Direct reads of `process.env.MAX_EVIDENCE_FILE_SIZE_BYTES` bypass `config/index.js` Zod schema validation. |

---

## 1. Hardcoded Values & Server Cross-Reference

Cross-referenced against the live server export in `audit-output/guild-1459527799814623315-*.json` (Server Name: **Peak Clip**, ID: `1459527799814623315`, 18 roles, 33 channels).

### Hardcoded Snowflake IDs Detected

| File | Line | Hardcoded ID | Purpose in Code | Exists in Client Server? | Status |
|---|---|---|---|---|---|
| `src/scripts/live_qa_staff_control_plane.js` | 22 | `1551276972703744060` | Fallback `DEV_GUILD_ID` | ❌ No | Hardcoded dev test guild |
| `src/scripts/live_qa_staff_control_plane.js` | 47 | `1551282766920818782` | `Peak Admin` role mock | ❌ No | Dev test role |
| `src/scripts/live_qa_staff_control_plane.js` | 48 | `1551282766920818783` | `Campaign Manager` role mock | ❌ No | Dev test role |
| `src/scripts/verify-discord-operational-flows.js` | 93 | `1551291857370087467` | `adminRoleIds` fixture | ❌ No | Dev test role |
| `src/scripts/verify-discord-operational-flows.js` | 94 | `1551291860654489720` | `campaignManagerRoleIds` fixture | ❌ No | Dev test role |
| `src/scripts/verify-discord-operational-flows.js` | 98 | `1551291864496214056` | `creatorRoleIds` fixture | ❌ No | Dev test role |
| `src/scripts/verify-dev-platform.js` | 366 | `1551291864496214056` | `Creator` role ID | ❌ No | Dev test role |
| `src/bot/components/staff.modals.js` | 106 | `978305861430693960` | User ID placeholder (`harshdevil15`) | ❌ No | Hardcoded developer snowflake |
| `src/scripts/run-real-youtube-lifecycle.js` | 37 | `978305861430693960` | User ID fixture | ❌ No | Developer user ID |
| `src/scripts/seed-dev.js` | 11 | `999999999999999999` | Dummy user Discord ID | ❌ No | Synthetic seed ID |

### Hardcoded Role Names & String Literals

| File | Line | Hardcoded String | Context & Risk |
|---|---|---|---|
| `src/bot/provisioning/server.structure.js` | 7–10 | `'Peak Admin'`, `'Campaign Manager'`, `'Creator'`, `'Peak Clip'` | Canonical role names provisioned or expected. In the client's actual server, the existing roles are `FOUNDER`, `Ceo`, `Moderator`, `Staff`, `Peak Clipper`, and `Member`. |
| `src/modules/admin/admin.auth.js` | 151–155 | `r.name === 'Peak Admin'`, `r.name === 'Campaign Manager'` | Fallback role name checks when env role IDs are unset. Fails silently on client servers with differently named staff roles. |
| `src/bot/commands/verify.js` | 34 | `r.name.toLowerCase() === 'creator'` | Automatically searches for a role literally named "Creator" to assign upon onboarding. |
| `src/bot/commands/verify.js` | 65, 78 | `"Welcome to Peak Clip"`, `"Peak Clip Creator Platform"` | Hardcoded agency branding in creator embeds. |
| `src/modules/verification/verification.service.js` | 341 | `submissionAgeSeconds > 3600` | Rigid 1-hour submission cutoff. |
| `src/modules/earnings/earnings.service.js` | 177 | `creatorEarningCap = ... ?? '600.00'` | Default $600.00 creator earnings cap per campaign. |

---

## 2. Environment Variables & Proposed `.env.example`

### Current Environment Variables in Use

| Env Variable | Type | Default | Used in File | Purpose |
|---|---|---|---|---|
| `NODE_ENV` | String | `development` | `src/config/index.js:6` | Environment toggle |
| `LOG_LEVEL` | String | `info` | `src/config/index.js:7` | Logging verbosity |
| `PORT` | Number | `3000` | `src/config/index.js:8` | HTTP service port |
| `DATABASE_URL` | String (URL) | *None* | `src/config/index.js:11` | PostgreSQL database connection string |
| `REDIS_HOST` | String | `127.0.0.1` | `src/config/index.js:14` | Redis hostname |
| `REDIS_PORT` | Number | `6379` | `src/config/index.js:15` | Redis port |
| `REDIS_PASSWORD` | String | `""` | `src/config/index.js:16` | Redis authentication password |
| `REDIS_DB` | Number | `0` | `src/config/index.js:17` | Redis logical DB index |
| `DISCORD_TOKEN` | String | *None* | `src/config/index.js:20` | Main bot token |
| `DISCORD_CLIENT_ID` | String | *None* | `src/config/index.js:21` | Discord application Client ID |
| `DISCORD_GUILD_ID` | String | *None* | `src/config/index.js:22` | Target Discord Guild ID |
| `DISCORD_ADMIN_ROLE_IDS` | Comma-sep list | `[]` | `src/config/index.js:49` | Staff role IDs for Admin authority |
| `DISCORD_CAMPAIGN_MANAGER_ROLE_IDS` | Comma-sep list | `[]` | `src/config/index.js:53` | Staff role IDs for Campaign Manager |
| `YOUTUBE_API_KEY` | String | *None* | `src/config/index.js:25` | Google Cloud API key for YouTube Data API v3 |
| `META_ACCESS_TOKEN` | String | *None* | `src/config/index.js:26` | Meta Graph API access token |
| `META_APP_ID` | String | *None* | `src/config/index.js:27` | Meta App ID |
| `META_APP_SECRET` | String | *None* | `src/config/index.js:28` | Meta App Secret |
| `META_INSTAGRAM_ACCOUNT_ID` | String | *None* | `src/config/index.js:29` | Meta Instagram business account ID |
| `APIFY_API_TOKEN` | String | *None* | `src/config/index.js:30` | Apify console token |
| `APIFY_FACEBOOK_ACTOR_ID` | String | `apify/facebook-posts-scraper` | `src/config/index.js:31` | Apify Facebook scraper actor |
| `APIFY_TIKTOK_ACTOR_ID` | String | `clockworks/free-tiktok-scraper` | `src/config/index.js:32` | Apify TikTok scraper actor |
| `APIFY_INSTAGRAM_ACTOR_ID` | String | `apify/instagram-scraper` | `src/config/index.js:33` | Apify Instagram scraper actor |
| `APIFY_TIMEOUT_SECS` | Number | `60` | `src/config/index.js:34` | Apify Actor run timeout |
| `METRIC_POLL_INTERVAL_MINUTES` | Number | `60` | `src/config/index.js:38` | Metric polling frequency |
| `METRIC_POLL_BATCH_SIZE` | Number | `50` | `src/config/index.js:39` | Clips per polling chunk |
| `METRIC_POLL_MAX_ATTEMPTS` | Number | `3` | `src/config/index.js:40` | BullMQ retry limit for polling |
| `METRIC_POLL_BACKOFF_MS` | Number | `5000` | `src/config/index.js:41` | Backoff base ms |
| `METRIC_POLL_ENABLED` | Boolean | `true` | `src/config/index.js:42` | Toggle background polling worker |
| `RATE_LIMIT_SUBMIT_PER_MINUTE` | Number | `10` | `src/config/index.js:45` | Submission anti-spam limit |
| `RATE_LIMIT_PAYOUT_PER_MINUTE` | Number | `5` | `src/config/index.js:46` | Payout request limit |
| `MAX_EVIDENCE_FILE_SIZE_BYTES` | Number | `20971520` (20MB) | `src/modules/evidence/evidence.validator.js:14` | Max payout video recording size |

### Proposed `.env.example` for Client Deployment

```env
# ==============================================================================
# Peak Clip — Single-Tenant Client Production Environment
# ==============================================================================

# Application Runtime
NODE_ENV=production
LOG_LEVEL=info
PORT=3000

# PostgreSQL Database (Host or Docker service)
DATABASE_URL=postgresql://postgres:REPLACE_WITH_SECURE_PASSWORD@127.0.0.1:5432/peak_clip_prod?schema=public

# Redis Connection (BullMQ queues & distributed locking)
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# Discord Application Credentials (Dedicated Client Bot Application)
DISCORD_TOKEN=REPLACE_WITH_CLIENT_BOT_TOKEN
DISCORD_CLIENT_ID=REPLACE_WITH_CLIENT_APPLICATION_ID
DISCORD_GUILD_ID=REPLACE_WITH_CLIENT_GUILD_ID

# Staff Role Mapping (Comma-separated Snowflake IDs)
# Users with these roles receive administrative & campaign control permissions
DISCORD_ADMIN_ROLE_IDS=
DISCORD_CAMPAIGN_MANAGER_ROLE_IDS=

# External Verification Role Gating (Optional)
# If set, creators must possess this role (from Wick, CaptchaBot, etc.) to join campaigns
CLIENT_VERIFIED_ROLE_ID=

# Social Media Verification & Metric Tracking Providers
# YouTube Data API v3 key (Google Cloud Console)
YOUTUBE_API_KEY=

# Apify Actor Integration (TikTok & Instagram scraping)
APIFY_API_TOKEN=
APIFY_TIKTOK_ACTOR_ID=clockworks/free-tiktok-scraper
APIFY_INSTAGRAM_ACTOR_ID=apify/instagram-scraper
APIFY_FACEBOOK_ACTOR_ID=apify/facebook-posts-scraper
APIFY_TIMEOUT_SECS=60

# Background Metric Polling Configuration
METRIC_POLL_ENABLED=true
METRIC_POLL_INTERVAL_MINUTES=60
METRIC_POLL_BATCH_SIZE=50

# Upload Limits
MAX_EVIDENCE_FILE_SIZE_BYTES=20971520
```

---

## 3. Slash Command Registration

- **Current Implementation**: Located in [`src/scripts/deploy-commands.js`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/scripts/deploy-commands.js).
  - Uses `REST(version: '10')` and checks `config.discord.guildId`.
  - If `DISCORD_GUILD_ID` is set: executes `Routes.applicationGuildCommands(clientId, guildId)` (instant propagation).
  - If `DISCORD_GUILD_ID` is unset: executes `Routes.applicationCommands(clientId)` (global deployment; takes up to 60 minutes).
- **Single-Guild Deployment Requirements**:
  1. For single-tenant client deployments, `DISCORD_GUILD_ID` must be strictly enforced as required in `src/config/index.js` during production startup.
  2. The deployment pipeline must run `npm run discord:deploy` pointing exclusively to `Routes.applicationGuildCommands`, completely bypassing global command registration to prevent leaking commands to other guilds or waiting for global propagation.

---

## 4. Discord Gateway Intents

- **Declared Intents** (`src/bot/client.js:26–30`):
  1. `GatewayIntentBits.Guilds` (Standard, non-privileged)
  2. `GatewayIntentBits.GuildMessages` (Standard, non-privileged)
  3. `GatewayIntentBits.MessageContent` (🔴 **PRIVILEGED**)
- **Intent Analysis**:
  - `Guilds` & `GuildMessages`: Required for reading channels, guild structure, and detecting messages.
  - `MessageContent`: Marked as **Privileged** in Discord.
    - Used in [`src/bot/events/messageCreate.handler.js:106`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/bot/events/messageCreate.handler.js#L106) to inspect video file attachments (`message.attachments`) uploaded by creators for payout analytics screen recordings.
    - **Fatal Risk**: If a client provisions their own Discord bot token and does not explicitly enable the "Message Content Intent" checkbox in the Discord Developer Portal under **Bot → Privileged Gateway Intents**, the bot connection will immediately crash on startup with error `DisallowedIntents` (code 4014).
    - **Recommendation**: Document this explicitly as an mandatory toggle in deployment docs, and wrap bot login with a diagnostic error message explaining the exact Developer Portal setting.

---

## 5. Permission & Authorization Checks

- **Implementation**: [`src/modules/admin/admin.auth.js`](file:///c:/Users/lenovo/OneDrive/Desktop/dc_clipping_bot/src/modules/admin/admin.auth.js)
  - Hierarchy:
    1. Member has Discord native `Administrator` permission $\rightarrow$ Granted `ADMIN`.
    2. Member has role ID in `DISCORD_ADMIN_ROLE_IDS` $\rightarrow$ Granted `ADMIN`.
    3. Member has role ID in `DISCORD_CAMPAIGN_MANAGER_ROLE_IDS` $\rightarrow$ Granted `CAMPAIGN_MANAGER`.
    4. Fallback: Role names matching `'Peak Admin'` or `'Campaign Manager'`.
- **Findings**:
  - The authorization model itself is well-architected (role-to-permission matrix, financial permissions restricted to `ADMIN` only).
  - **Gap**: Fallback relies on hardcoded role names (`Peak Admin`, `Campaign Manager`) that do not exist on the client server (where roles are `FOUNDER`, `Ceo`, `Moderator`, `Staff`).
  - **Fix**: Require `DISCORD_ADMIN_ROLE_IDS` or implement a setup command (`/setup roles`) to bind existing client roles directly into the database.

---

## 6. BullMQ Jobs, Idempotency & Financial Safety

### Job Idempotency
- **Metric Polling Worker** (`src/workers/metric-polling.worker.js`):
  - **Metrics deduplication**: Compares incoming counts against the latest snapshot via `hasMetricsChanged()`. If unchanged, no new snapshot is written.
  - **Snapshot deduplication**: `MetricSnapshot` insertions use `sourceSnapshotId` reference in earnings.
- **Earnings Accrual** (`src/modules/earnings/earnings.service.js`):
  - **Zero Double-Credit Guarantee**: Uses `this.repo.getEarningBySnapshotId(targetSnapshot.id, tx)`. If a snapshot has already generated an earning row, it returns the existing earning immediately.
  - **Incremental Delta Math**: Tracks `previouslyCreditedViews` sum. Earnings are calculated strictly on `currentViews - previouslyCreditedViews`.
  - **Metric Regression Safety**: If `currentViews < previouslyCreditedViews`, no negative earning is created; the worker logs a warning and returns 0 credited views.
- **Provider Failure vs. Deletion Classification**:
  - `PermanentContentError` (e.g. video deleted, 404, made private) terminates polling without retry.
  - `TransientProviderError` (e.g. network timeout, 5xx upstream) bubbles up to BullMQ for exponential backoff retries.
  - `RateLimitProviderError` (HTTP 429) pauses and retries with backoff.

---

## 7. Money Handling & Financial Ledger Integrity

1. **Floating Point vs. Fixed Decimals**:
   - **No native JS floats for financial balances**: All monetary calculations utilize `Prisma.Decimal` (arbitrary-precision decimal arithmetic) and integer/BigInt units for view counts.
   - Prevents floating-point rounding errors (e.g. `0.1 + 0.2 = 0.30000000000000004`).
2. **Ledger Immutability**:
   - The `Earning` table is **strictly append-only**.
   - Audit search reveals **zero** occurrences of `prisma.earning.delete()` or `prisma.earning.update()`.
   - When a submission is rejected post-approval, historical earnings are **preserved**; the system writes negative records to `FinancialAdjustment` to offset balances.
3. **Transactional Locks**:
   - `creditNewEligibleViews()` and payout requests utilize PostgreSQL row-level locks (`acquireSubmissionLock`, `SELECT ... FOR UPDATE`) inside atomic Prisma interactive transactions (`prisma.$transaction`).

---

## 8. Process Lifecycles, Shutdown & Resilience

- **Signal Handling** (`src/app.js:93–94`):
  - Listens for `SIGINT` and `SIGTERM`.
  - Graceful teardown order:
    1. `stopDiscordBot()` (destroys gateway connection).
    2. `stopWorkers()` (pauses and closes BullMQ workers).
    3. `closeAllQueues()` (disconnects Redis queue clients).
    4. `disconnectDatabase()` (disconnects Prisma client).
  - Guarded by a 10-second forced termination timeout (`setTimeout(..., 10000)`).
- **Process Exception Traps**:
  - `process.on('uncaughtException')` and `process.on('unhandledRejection')` are logged with `logger.fatal()` before terminating (`process.exit(1)`).
- **Vulnerability**:
  - In `src/bot/client.js:62`, `client.on(Events.InteractionCreate)` calls `await handleInteraction(interaction)` without an outer try/catch wrapper. If an error escapes `handleInteraction`, it triggers the process-level `unhandledRejection` handler and terminates the entire bot process.

---

## 9. Database, Migrations & Fresh Deployment

- **Critical Blocker (F-01)**:
  - `.gitignore` line 20 contains `prisma/migrations/`.
  - Because `prisma/migrations/` is ignored by Git, cloning the repository on a fresh server will contain **no migration files**.
  - Running `prisma migrate deploy` on a fresh production database will find 0 migrations and leave the database empty!
  - **Required Fix**: Remove `prisma/migrations/` from `.gitignore` and commit all 13 existing SQL migrations to the repo.
- **Seeding Assumptions**:
  - `src/scripts/seed-campaigns.js` and `seed-dev.js` populate development campaigns (`[DEV] Apex Legends...`) and test Discord IDs (`999999999999999999`).
  - Production bootstrap must **never** run dev seeds automatically. Production setup should either run clean or seed a blank default campaign via staff commands.

---

## 10. External API Cost & Quota Risks

1. **YouTube Data API v3**:
   - Free tier quota: 10,000 units/day.
   - Endpoint: `/videos?part=snippet,contentDetails,statistics,status&id=${videoId}` consumes 1 quota unit.
   - **Risk**: Clips are queried individually. With 200 clips polled hourly: $200 \times 24 = 4,800$ units/day (nearly 50% of total daily quota).
   - **Optimization**: YouTube API supports querying up to 50 comma-separated IDs per request (`id=id1,id2,id3...`) for the exact same 1 quota unit. Batching would reduce quota consumption by up to 98%.
2. **Apify (TikTok & Instagram)**:
   - Scrapers spin up cloud containers charging compute units per actor run.
   - Polling 50 clips hourly = 1,200 container executions/day.
   - **Risk**: Will exhaust Apify's $5 monthly free tier within 24–48 hours, incurring paid usage charges.
   - **Mitigation**: Configurable polling intervals per platform (e.g. YouTube hourly, TikTok/Instagram every 6–12h), or bounding the tracking lifespan (e.g. stop polling clips older than 14 days).

---

## 11. Duplicate Detection & 1-Hour Verification Weaknesses

1. **Cross-User Duplicate Exploitation (F-03)**:
   - In `prisma/schema.prisma:198`:
     `@@unique([userId, campaignId, normalizedUrl])`
   - **Weakness**: The uniqueness constraint is scoped to `userId`. If Clipper A submits a video, Clipper B can submit the exact same URL to the same campaign. Both will be approved, both will create metric snapshots, and both clippers will receive double payouts for the identical views.
   - **Fix**: Require `@@unique([campaignId, normalizedUrl])` across all users.
2. **Rigid 1-Hour Publication Window**:
   - `src/modules/verification/verification.service.js:341` hardcodes:
     `if (submissionAgeSeconds > 3600) { reject... }`
   - If a client wants a 24-hour submission window, this check rejects all clips over 60 minutes old. Must be made configurable per campaign.
3. **Timestamp Omission Bypass**:
   - If a scraper (TikTok/Instagram) returns `publishedAt: null`, the entire age verification block (`if (publishedAt)`) is skipped, allowing months-old clips to pass automatically.
4. **Zero Account Ownership Verification**:
   - The bot has no mechanism to confirm that the submitting Discord user actually owns or created the YouTube/TikTok account. Anyone can submit public viral clips created by third-party influencers within 60 minutes of release and collect payouts.
   - **Mitigation**: Support mandatory unique creator hashtags or Discord tag in video descriptions/comments.

---

## 12. Logging, Diagnostics & Telemetry Gaps

1. **Unbounded Disk File Writes**:
   - `src/bot/events/messageCreate.handler.js:151` directly calls:
     `fs.appendFileSync('diagnostic.log', ...)`
   - Every video attachment uploaded for payout evidence appends verbose unrotated JSON payloads to `diagnostic.log` (already ~1 MB on disk). In a production container, this will grow indefinitely until disk space is exhausted.
2. **No Real-Time Staff Alerts for System Failures**:
   - If Redis connection drops, or YouTube API key quota is exhausted (HTTP 403), logs are printed to stdout, but staff receives no notification in Discord (`#bot-errors` channel is defined in structure but not wired to webhook alerts).

---

### Audit Status
Phase 1 Codebase Audit is **complete**. No source files have been modified. 

Awaiting your review and approval before proceeding to **PHASE 2: Implementation plan**.
