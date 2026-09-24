# Peak Clip Deployment — Client Discovery Questionnaire

Welcome! To ensure a seamless deployment of **Peak Clip** (Campaigns, Submissions, Metric Tracking, Review Queue, and Earnings Ledger) into your Discord server without conflicting with your existing verification, ticketing, and announcement bots, please complete this technical questionnaire.

---

## 1. Server Roles & Hierarchy

1. **Role Hierarchy Map**:
   - What are the top administrative and staff roles in your server?
   - Please list the roles in descending order of hierarchy (highest permissions to lowest).
2. **Staff Access Roles**:
   - Which role(s) should have **Campaign Management** permissions (create campaigns, edit budgets, close campaigns)?
   - Which role(s) should have **Clip Reviewer** permissions (review flagged clips in `#review-queue`, approve/reject)?
   - Which role(s) should have **Finance / Payout Admin** permissions (approve payout requests, mark manual disbursements, export financial ledgers)?
3. **Bot Position**:
   - Can the Peak Clip bot role be positioned above standard moderator / member roles in **Server Settings → Roles** to allow it to view private staff channels and manage message components?

---

## 2. Server Verification & Onboarding

1. **Existing Verification Bot**:
   - What bot currently handles member onboarding/verification (e.g., Wick, Double Counter, AltDentifier, Captcha.bot, custom)?
2. **"Verified Member" Role**:
   - What is the exact name and Snowflake ID of the role given to users once they pass your verification?
3. **Gating Policy**:
   - Should Peak Clip strictly require users to hold this "Verified Member" role before they can join campaigns or submit clips?
   - Should unverified users be blocked from viewing clipping channels altogether?

---

## 3. Channels & Categories

1. **Existing Channel Layout**:
   - Do you currently have existing clipping or content-creator categories/channels, or should Peak Clip set up a dedicated category?
2. **Target Channels**:
   Peak Clip operates with the following dedicated channels. Please indicate whether we should create new ones or bind to existing channels (provide Channel IDs if existing):
   - **`#campaigns`** (Public view: active campaigns, rules, join buttons): `New` / `Existing (ID: ____________)`
   - **`#submissions`** (Public submit desk: submit clip modal, user stats): `New` / `Existing (ID: ____________)`
   - **`#review-queue`** (Private staff channel: fraud flags, duration/watermark reviews, manual overrides): `New` / `Existing (ID: ____________)`
   - **`#payout-audit`** (Private staff channel: withdrawal requests, payout receipts, audit trail): `New` / `Existing (ID: ____________)`
   - **`#creators`** / **Announcements** (Public or creator-only: campaign launch pings, leaderboards): `New` / `Existing (ID: ____________)`
3. **Category Permissions**:
   - Are there category-level permission overwrites that hide or restrict new channels by default?

---

## 4. Existing Bots & Permission Overwrites

1. **Other Active Bots**:
   - Please list all bots currently active in the server (e.g., ticket bots like Ticket Tool, moderation bots like Carl-bot/Dyno, announcement bots).
2. **Potential Collisions**:
   - Do any moderation bots automatically delete messages containing external links (YouTube, TikTok, Instagram) or delete bot messages?
   - If so, can Peak Clip and the designated `#submissions` channel be whitelisted from link auto-deletion?

---

## 5. Campaign Rules, Platforms & Submission Windows

1. **Supported Platforms**:
   - Which platforms will you accept for clipping?
     - [ ] YouTube (Shorts & Standard)
     - [ ] TikTok
     - [ ] Instagram Reels
     - [ ] Facebook Reels / Clips
2. **Video Constraints**:
   - Minimum clip duration (default: 7 seconds): ______ seconds
   - Maximum clip duration (default: 120 seconds): ______ seconds
   - Are specific hashtags (e.g. `#brand`, `#ad`), title tags, or account mentions strictly mandatory?
3. **Submission Window**:
   - How fresh must a clip be when submitted?
     - [ ] Must be submitted within 1 hour of publishing on the platform
     - [ ] Must be submitted within 24 hours of publishing
     - [ ] Other: ______________________
4. **Account Ownership Verification**:
   - Do you require clippers to include a specific Discord username/tag in their video description or pinned comment to prove account ownership?

---

## 6. Rates, Budgets & Financial Mechanics

1. **Reward Model**:
   - What is the payment rate per 1,000 eligible views (RPM/CPM)? (e.g., $1.50 per 1,000 views)
   - Do rates vary by platform (e.g., YouTube vs. TikTok)?
2. **Cap Thresholds**:
   - Maximum earnings per clip cap: $______ (or unlimited)
   - Maximum earnings per creator cap: $______ (or unlimited)
   - Total campaign budget cap: $______
3. **Minimum Metric Requirement**:
   - Is there a minimum view count threshold before earnings begin accruing? (e.g., must hit 1,000 views to be monetized)

---

## 7. Payouts & Disbursements

1. **Payout Threshold**:
   - What is the minimum withdrawal request balance? (default: $20.00)
2. **Disbursement Methods**:
   - What payment rails do you support for paying creators?
     - [ ] Crypto (USDT, USDC, SOL, BTC — networks: ____________)
     - [ ] PayPal
     - [ ] Wise / Bank Wire
     - [ ] Stripe / Tipalti
     - [ ] Other: ______________________
3. **Execution Workflow**:
   - Payout execution is manual off-chain/off-platform. When staff completes a payment, do you require staff to attach an external transaction ID / explorer link / receipt image for auditing?

---

## 8. Expected Scale & Technical Limits

1. **Volume Estimates**:
   - Estimated number of active clippers: ______ creators
   - Estimated submissions per day / per month: ______ clips / month
   - Expected view growth / tracking horizon (e.g., track clips for 7 days, 14 days, or 30 days): ______ days
2. **API Quota Constraints**:
   - Will the client provide their own YouTube Data API v3 key and Apify / Scraper API tokens, or use centrally provided keys?

---

## 9. Compliance, Legal & Regional Considerations

1. **Age & Geographic Restrictions**:
   - Are creators from specific countries restricted from receiving payouts?
   - Is there a minimum age requirement (e.g. 18+ or 13+ with parental consent)?
2. **Tax & Legal Reporting**:
   - Do you require W-9 / W-8BEN collection prior to releasing payouts exceeding $600?
3. **Content Guidelines**:
   - Are there specific DMCA, music copyright, or NSFW disqualification policies that reviewers must enforce?

---

### Submission & Next Steps
Please fill out the details above and return this form to the deployment engineer. Once received, we will run the read-only guild audit and configure the deployment environment.
