# Discord Clipping Agency Platform

Production-grade Discord platform for clipping agencies, creators, and campaign managers.

---

## 🏗 System Architecture

```
Discord UI (Slash Commands, Buttons, Select Menus, Modals)
    ↓
Discord Application Layer (Thin routers & handlers)
    ↓
Service / Business Logic Layer (Decoupled from Discord)
    ↓
Repositories / Database Layer (Prisma ORM)
    ↓
PostgreSQL Database
```

### Background Processing

```
Redis
  ↓
BullMQ
  ↓
Workers
  ├── Verification Worker (Verifies video URLs, timestamps, account ownership)
  ├── Metrics Worker (Takes periodic metric snapshots: views, likes, shares)
  └── Payout Worker (Audits view thresholds and executes earnings payouts)
```

### External Platform Integrations

```
PlatformProvider (Abstract Interface)
    ├── YouTubeProvider
    ├── TikTokProvider
    └── InstagramProvider
```

---

## 📂 Project Structure

```
src/
  bot/
    commands/          # Slash command definitions & thin handlers (/ping, etc.)
    interactions/      # Interaction dispatcher for buttons, menus, modals
    embeds/            # Discord embed templates and builders
    components/        # Discord action rows, buttons, modals
    client.js          # Discord client setup and event wiring

  modules/             # Modular domain boundaries (Phase 1+)
    users/
    campaigns/
    submissions/
    verification/
    statistics/
    earnings/
    payouts/

  providers/           # External social video platform abstractions
    youtube/
    tiktok/
    instagram/

  workers/             # BullMQ background workers
    verification.worker.js
    metrics.worker.js
    payout.worker.js
    index.js

  queues/              # BullMQ queue definitions and Redis connection factory
    redis.js
    index.js

  database/            # Prisma ORM client singleton and health checks
    client.js

  services/            # Core business logic services (platform-agnostic)
  config/              # Centralized environment validation (Zod)
  utils/               # Structured logging (Pino) & standardized error handling
  app.js               # Application orchestrator and graceful shutdown

prisma/
  schema.prisma        # PostgreSQL database schema
```

---

## ⚙️ Environment Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | No | `development` | Environment mode (`development`, `production`, `test`) |
| `LOG_LEVEL` | No | `info` | Logger verbosity (`debug`, `info`, `warn`, `error`) |
| `DATABASE_URL` | Yes (Prod) | - | PostgreSQL connection URL |
| `REDIS_HOST` | No | `127.0.0.1` | Redis host for BullMQ |
| `REDIS_PORT` | No | `6379` | Redis port |
| `REDIS_PASSWORD` | No | - | Redis auth password |
| `DISCORD_TOKEN` | Yes (Prod) | - | Discord Bot token from Developer Portal |
| `DISCORD_CLIENT_ID` | Yes (Prod) | - | Discord Application Client ID |
| `DISCORD_GUILD_ID` | No | - | Discord Guild ID for rapid command development |
| `PORT` | No | `3000` | Optional HTTP port for future dashboard/health endpoints |

> **Development-Safe Startup**: In `development` mode, the app starts in safe/standby mode even if `DISCORD_TOKEN`, `DATABASE_URL`, or `REDIS_HOST` are omitted or offline.

---

## 🚀 Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Generate Prisma Client
```bash
npm run db:generate
```

### 3. Run in Development Mode
```bash
npm run dev
```

### 4. Run Test Suite
```bash
npm test
```

### 5. Production Start
```bash
npm start
```

---

## 🛡 Design & Resilience Principles
- **Thin Discord Handlers**: Discord commands do not contain raw SQL or heavy business logic.
- **Background Decoupling**: Video metrics collection and URL verification run through BullMQ jobs.
- **Fail-Safe**: External API or Redis downtime will not crash the Discord bot gateway connection.
- **Graceful Shutdown**: Listens to `SIGINT` and `SIGTERM` to cleanly drain background queues, disconnect Redis, close Prisma pools, and destroy Discord websocket connections.

---

## 🔍 Verification & Engagement Intelligence Architecture (Phase 3.1)

### 1. Risk Assessment ≠ Final Submission Approval
Verification and business approval are strictly decoupled:
- **Verification Engine** (`src/modules/verification/verification.service.js`): Gathers evidence, takes metric snapshots, detects behavioral anomalies, and calculates a normalized anomaly score. It outputs an objective risk classification: `LOW_RISK`, `REVIEW_REQUIRED`, or `HIGH_RISK`.
- **Approval Policy** (`src/modules/verification/approval.policy.js`): Evaluates business campaign eligibility and maps the risk tier to the final `Submission` lifecycle state (`APPROVED`, `UNDER_REVIEW`, `FLAGGED`, `REJECTED`). `LOW_RISK` qualifies for approval consideration, but does not conflate risk assessment with business policy.

### 2. Configurable Verification Policy (`src/modules/verification/policy.js`)
All anomaly thresholds, signal weights, baseline parameters, and risk score boundaries are centralized in `DEFAULT_VERIFICATION_POLICY`. Policies can be dynamically resolved or overridden per campaign:
- Minimum view threshold for ratio evaluation: 1,000 views.
- Sudden growth velocity threshold: 10x hourly multiplier.
- Expected like-to-view ratios: 0.1% to 50%.
- Expected comment-to-view ratios: 0.005% to 10%.
- Severity score weights: `INFO` (0.00), `LOW` (0.05), `MEDIUM` (0.15), `HIGH` (0.35), `CRITICAL` (0.60).
- Risk classification thresholds: `LOW_RISK` (<0.30), `REVIEW_REQUIRED` (0.30–0.69), `HIGH_RISK` (>=0.70).

### 3. Explicit Metric Availability Semantics (`0` vs. `null`)
To prevent false-positive anomaly signals and preserve statistical integrity:
- `MetricSnapshot.views`, `likes`, and `comments` are nullable `BigInt?`.
- Metric availability states are explicitly tracked in `metadata.availability`: `AVAILABLE`, `UNAVAILABLE`, `NOT_SUPPORTED`, or `TEMPORARILY_UNAVAILABLE`.
- A metric count of `0` is only treated as zero when `AVAILABLE`. An unavailable metric is stored as `null` and is never treated as `0`.
- Ratios are only computed when denominators are `AVAILABLE` and positive. Unavailable denominators cleanly bypass ratio calculations without generating spurious anomaly signals.

### 4. Provider Error Taxonomy & Classification
Errors during external platform provider communication are classified into distinct categories:
- `TransientProviderError` (HTTP 429 rate limit, 502/503 bad gateway, network timeout): Classified as retryable. BullMQ worker performs retries with exponential backoff.
- `ConfigurationAuthError` (missing API keys, invalid credentials, expired OAuth tokens): Operator infrastructure failure. Non-retryable; transitions submission to `UNDER_REVIEW` and notifies staff without penalizing the creator.
- `PermanentContentError` (HTTP 404, deleted video, private video): Permanent content failure. Non-retryable; transitions submission to `REJECTED`.

### 5. Idempotency vs. Scheduled Metric Polling
- **Worker Idempotency Guard**: Protects against duplicate snapshot creation during rapid BullMQ worker retries if a previous snapshot was completed within the past 60 seconds.
- **Scheduled Polling**: Future periodic metric collectors pass `{ forceRefresh: true }` to bypass the rapid-retry cache and append new chronological snapshots to the submission audit trail.

---

## 📈 Statistics Engine Architecture (Phase 4A)
- **Read-Side Multi-Level Aggregation**: Derives User Overview, Campaign Overview, and Individual Submission Growth without redundant aggregate tables or caching.
- **Deterministic Latest Snapshot**: Current totals sum only the latest valid snapshot per submission (`capturedAt DESC, id DESC`). Historical snapshots are never double-counted into current metrics.
- **Explicit Metric Availability**: Categorizes metrics into `COMPLETE`, `PARTIAL`, or `UNAVAILABLE`. Never converts missing provider data (`null`) into zero.
- **Access Control & Privacy**: Server-side user authorization strictly blocks cross-user data access. Internal risk scores and signal weights are completely redacted from creator-facing statistics.

---

## 💰 Earnings Engine Architecture (Phase 4B)
- **Authoritative Immutable Ledger**: The `Earning` model is the single source of truth. User balances are calculated dynamically from immutable credit events rather than mutable counters.
- **Exact Decimal Financial Precision**: Monetary calculations strictly use Prisma `Decimal` (`NUMERIC(10, 2)`) with `ROUND_HALF_UP` commercial rounding. JavaScript floats are prohibited.
- **Incremental View Crediting**: Only newly accrued views beyond previously credited views are eligible (`100k -> 150k -> 220k` yields credits for `100k, +50k, +70k`).
- **Regression Resilience**: Metric drops (e.g. 220k -> 180k) never generate negative earnings or delete ledger records.
- **Idempotency & Concurrency**: Unique database constraints on `sourceSnapshotId` combined with atomic transactions prevent duplicate crediting across concurrent workers.
- **Rate-Locking & Currency**: Every ledger event locks the effective `ratePerThousand` and `currency` (ISO 4217, default `USD`). Historical earnings are immune to future campaign rate adjustments.

---

## 💸 Payout Requests & Disbursement Ledger (Phase 5)
- **Immutable Earning Ledger Preservation**: Payout requests and disbursements **NEVER** mutate, delete, void, or rewrite `Earning` records. The `Earning` ledger remains the single, unadulterated source of truth for all earned money.
- **Dynamic Balance Reservation Math**:
  `availableBalance = eligibleEarnings - reservedBalance - completedPayouts`
  - Active payout requests in reserving states (`REQUESTED`, `UNDER_REVIEW`, `APPROVED`, `PROCESSING`) immediately reserve funds.
  - Terminated non-successful requests (`REJECTED`, `CANCELLED`, `FAILED`) release reservations back to available balance.
  - Successful disbursements (`COMPLETED`) permanently consume the balance without double-deduction.
- **Pre-flight Financial Validation**:
  - Validates creator account is active (prevents suspended or banned creators from requesting payouts).
  - Enforces dynamic minimum payout threshold per currency based on campaigns the creator earned in (defaulting to `$10.00`).
  - Guards against zero/negative amounts and balance overdraws within atomic interactive database transactions.
- **Centralized Lifecycle State Machine**:
  - `REQUESTED` -> `UNDER_REVIEW`, `CANCELLED` (creator self-cancellation), or `REJECTED` (admin).
  - `UNDER_REVIEW` -> `APPROVED`, `REJECTED`, or `CANCELLED`.
  - `APPROVED` -> `PROCESSING` or `CANCELLED`.
  - `PROCESSING` -> `COMPLETED` or `FAILED`.
  - `FAILED` -> `PROCESSING` (retry capability).
  - Terminal states (`COMPLETED`, `REJECTED`, `CANCELLED`) cannot transition to any other status.
- **Pluggable Disbursement Provider Architecture**:
  - Abstract `BaseDisbursementProvider` interface for pluggable payment rails.
  - Built-in `ManualDisbursementProvider` providing deterministic reference generation and manual tracking without real-money gateway coupling.
- **Full Immutable Audit Trail**:
  - Every state transition produces an immutable `PayoutEvent` with timestamp, actor ID, and JSON metadata.
- **Creator-Private Discord UI**:
  - Ephemeral `/payout` dashboard displays available, reserved, disbursed totals, minimum requirement, and recent history.
  - Interactive modal dialog for submitting requested amounts with client and server validation.
  - Action buttons dynamically enable/disable based on minimum balance threshold.

---

## ⚡ Platform Hardening & Scheduled Polling (Phase 6)
- **Dedicated Metric Polling Queue & Scheduler**:
  - Dedicated BullMQ queue (`metric-polling-queue`) and worker (`src/workers/metric-polling.worker.js`).
  - Global scheduler dispatcher (`src/workers/metric-scheduler.js`) processes approved submissions in bounded batches (`METRIC_POLL_BATCH_SIZE`, default 50).
  - Uses deterministic job IDs (`poll:${submissionId}:${cycleBucket}`) to prevent scheduler duplication or queue bloat across multiple application instances.
- **Centralized Polling Eligibility Policy**:
  - Centralized in `src/modules/verification/polling.policy.js`.
  - Submissions are eligible only when: status is `APPROVED`, campaign is `ACTIVE` (or within 7-day post-end grace period), platform provider supports `fetchViews`, submission is not soft-deleted, and creator account is `ACTIVE`.
- **Deterministic Metric Snapshot Change Policy (Policy A)**:
  - If newly fetched metrics (`views`, `likes`, `comments`) are completely identical to the most recent snapshot, duplicate `MetricSnapshot` insertion is skipped to prevent database bloat.
  - New snapshots are created only when metrics change.
  - Preserves `null` (unavailable) vs `0` (actual known count). Unavailable data is never converted to zero.
- **Transactional Database Advisory Locks**:
  - **High-Water-Mark Concurrency**: Interactive transactions acquire `pg_advisory_xact_lock(hashtext('submission_earnings_' || submissionId))`. Concurrently arriving snapshots (Worker A: 150k, Worker B: 180k) execute sequentially, ensuring Worker B credits against the committed 150k baseline (+30k), guaranteeing total credited views match the 180k high-water mark without stale deltas.
  - **Out-of-Order Resiliency**: Regressing or out-of-order snapshots (175k arriving after 200k) evaluate to incremental $\le 0$, crediting 0 views with zero negative ledger rows.
  - **Payout Balance Reservation Lock**: Transactions acquire `pg_advisory_xact_lock(hashtext('payout_balance_' || userId))` to prevent simultaneous requests from overdrawing available balances.
  - **Disbursement Processing Lock**: Transactions acquire `pg_advisory_xact_lock(hashtext('payout_disburse_' || payoutRequestId))` to ensure only one worker processes an approved payout.
- **Centralized Provider Capability Matrix & Error Taxonomy**:
  - Centralized in `src/providers/capabilities.js`. Exposes granular platform abilities (`fetchViews`, `fetchLikes`, `fetchComments`, `fetchShares`, etc.).
  - Distinct `RateLimitProviderError` carrying `retryAfterMs` for exponential backoff.
  - Permanent failures (`PermanentContentError`, `ConfigurationAuthError`) terminate cleanly without endless retries.
- **Operational Health & Readiness**:
  - `checkLiveness()` in `src/utils/health.js` reports process status, uptime, and memory usage.
  - `checkReadiness()` verifies PostgreSQL and Redis connections without leaking credentials.
- **Application-Level Abuse Rate Limiting**:
  - Token-bucket sliding window rate limiter in `src/utils/rate-limiter.js`.
  - Protects creator submission creation and payout request endpoints while leaving background workers unaffected.

---

## 🚀 Production Provider Integration & End-to-End Verification (Phase 7)
- **Official YouTube Data API v3 Integration**:
  - `YouTubeProvider` (`src/providers/youtube/youtube.provider.js`) is fully integrated using strictly official YouTube Data API v3 endpoints (`videos?part=snippet,contentDetails,statistics,status`).
  - No scraping, unofficial endpoints, or browser automation.
  - Supports standard `watch?v=`, Shorts (`/shorts/`), shortlink (`youtu.be/`), and embed URLs, stripping tracking queries cleanly.
- **Strict Metric Normalization & Zero vs. Null Integrity**:
  - `0` views, likes, or comments are treated as valid zero counts (`0n`).
  - Hidden likes or disabled comments (where fields are omitted by YouTube API) are preserved strictly as `null` with `availability: 'UNAVAILABLE'`. They are **never** coerced to `0`, preventing distorted anomaly ratios or fraudulent risk signals.
- **Comprehensive Error Taxonomy & Network Hardening**:
  - `PermanentContentError`: Private videos, deleted videos, or videos rejected by upload policy fail permanently with immediate terminal state.
  - `ConfigurationAuthError`: Invalid/unauthorized API keys trigger operator alerts and hold submissions `UNDER_REVIEW` without penalizing creators.
  - `RateLimitProviderError`: HTTP 429 and `quotaExceeded` (403) errors extract `retry-after` delays and trigger queue backoff.
  - `TransientProviderError`: Upstream 5xx errors and network timeouts (configured at 8000ms) fail transiently to enable queue retries.
  - Credentials and API keys are strictly redacted from error messages, database rows, and structured logs.
- **TikTok & Instagram Boundary Preservation**:
  - Non-metric boundaries remain intact, returning `DATA_UNAVAILABLE` cleanly until official API access is provisioned.
- **End-to-End Verification Suite**:
  - 100% offline unit and deterministic fixture tests (`tests/youtube-provider.test.js`).
  - Full platform lifecycle integration tests (`tests/e2e.test.js`) verifying Creator -> Campaign -> Submit -> Verify -> Approval -> Earnings -> Statistics -> Payout.
  - Validated metric progression with high-water-mark tracking ($100\text{k} \to 150\text{k} \to 220\text{k} \to \text{drop } 180\text{k} \to 250\text{k}$).
  - Validated historical campaign rate-locking ($100\text{k} @ \$0.80 \to \text{rate change to } \$1.00 \to 50\text{k} @ \$1.00$).
  - Validated Risk vs. Approval decoupling (anomalous metrics elevate risk and hold submission for review, preventing automated balance crediting).
- **Opt-In Live Integration Suite**:
  - Optional live network suite (`tests/integration/youtube.integration.test.js`) ran via `npm run test:integration`.
  - Executes only when `RUN_PROVIDER_INTEGRATION_TESTS=true` and `YOUTUBE_API_KEY` are provided; skips cleanly by default.

---

## 🛡️ Campaign Operations & Admin Control Plane (Phase 8)

### 1. Server-Side Administrative Authorization
- **Zero Client Trust**: Administrative permissions are resolved strictly server-side from Discord interaction metadata (`interaction.member.roles` and guild `Administrator` permissions) against configured environment role IDs (`DISCORD_ADMIN_ROLE_IDS`, `DISCORD_CAMPAIGN_MANAGER_ROLE_IDS`).
- Custom IDs, command arguments, and client-supplied identifiers are never trusted as proof of authorization.
- Component button handlers extract entity identifiers, re-verify caller permissions, load fresh state from the database, and execute domain operations inside transactional boundaries.

### 2. Role Permission Matrix

| Administrative Operation | Admin | Campaign Manager | Creator |
|:---|:---:|:---:|:---:|
| **Create Campaign** (`CAMPAIGN_CREATE`) | ✅ | ✅ | ❌ |
| **Edit Campaign Settings** (`CAMPAIGN_EDIT`) | ✅ | ✅ | ❌ |
| **Activate / Pause / End / Archive** (`CAMPAIGN_ACTIVATE`, etc.) | ✅ | ✅ | ❌ |
| **View Campaign Members** (`MEMBER_VIEW`) | ✅ | ✅ | ❌ |
| **Remove / Reactivate Member** (`MEMBER_REMOVE`, `MEMBER_REACTIVATE`) | ✅ | ✅ | ❌ |
| **Search & View Creators** (`CREATOR_VIEW`) | ✅ | ✅ | ❌ |
| **Manage Creator Status** (`CREATOR_STATUS_MANAGE`) | ✅ | ✅ | ❌ |
| **View Submission Queue** (`SUBMISSION_VIEW`) | ✅ | ✅ | ❌ |
| **Review Operational Submission Details** (`SUBMISSION_REVIEW`) | ✅ | ✅ | ❌ |
| **Approve / Reject Submissions** (`SUBMISSION_APPROVE`, `SUBMISSION_REJECT`) | ✅ | ✅ | ❌ |
| **Flag Submissions** (`SUBMISSION_FLAG`) | ✅ | ✅ | ❌ |
| **Inspect Verification Evidence & Risk Signals** | ✅ | ✅ | ❌ |
| **View Payout Queue & Requests** (`PAYOUT_VIEW`) | ✅ | ✅ | ❌ |
| **Approve / Reject Payout Requests** (`PAYOUT_APPROVE`, `PAYOUT_REJECT`) | ✅ | ❌ | ❌ |
| **Process Manual Disbursements** (`PAYOUT_PROCESS`) | ✅ | ❌ | ❌ |
| **View Administrative Audit Trail** (`AUDIT_VIEW`) | ✅ | ✅ | ❌ |

### 3. Campaign Lifecycle & Financial Safeguards
- **Centralized Lifecycle State Machine**:
  - `DRAFT` $\to$ `ACTIVE`, `ARCHIVED`
  - `ACTIVE` $\to$ `PAUSED`, `ENDED`
  - `PAUSED` $\to$ `ACTIVE`, `ENDED`
  - `ENDED` $\to$ `ARCHIVED`
  - `ARCHIVED` $\to$ Terminal (no transitions permitted)
- **Date Integrity**: Activation is strictly blocked if the campaign's `endsAt` timestamp is in the past.
- **Historical Rate-Locking**: Updating `Campaign.payRate` modifies only future view credit increments; existing historical `Earning` ledger rows remain immutable.
- **Currency Modification Protection**: Modifying `Campaign.currency` on an active campaign with existing submissions or earnings is strictly rejected with `CurrencyModificationForbiddenError` to prevent accounting ledger corruption.

### 4. Submission Moderation & Creator Privacy
- **Approval Decoupling**: Manual approval transitions a submission to `APPROVED`. It does not directly manipulate or create earnings; earnings become eligible through the standard Phase 4B earnings engine upon snapshot evaluation.
- **Mandatory Rejection Reason**: Rejecting a submission requires a non-empty, validated reason. Historical snapshots and verifications are preserved.
- **Creator Privacy Guarantee**: Internal verification risk tiers, numerical anomaly scores, and granular verification signals are strictly isolated to staff views and redacted from creator-facing responses.

### 5. Append-Only Administrative Audit Trail
- Powered by `AdminAuditEvent` with indexed lookup by `entityType`, `entityId`, `actorDiscordId`, and `action`.
- Audit records store actor, action, previous state, new state, reason, and timestamp.
- The repository exposes **zero update or delete methods**, guaranteeing an immutable, append-only operational record.
