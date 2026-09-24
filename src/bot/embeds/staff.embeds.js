import { EmbedBuilder } from 'discord.js';
import { formatPayoutStatusBadge } from './payout.embeds.js';
import { getCreatorSafeReasonLabel } from '../../modules/moderation/moderation.constants.js';

/**
 * Build Review Queue Hub Canonical Embed (#review-queue)
 */
export function buildStaffReviewQueueHubEmbed(metrics = {}) {
  return new EmbedBuilder()
    .setTitle('📋 STAFF MODERATION HUB — REVIEW QUEUE')
    .setDescription(
      'Operational moderation workspace for submission verification and fraud inspection.\n' +
      'Submissions flagged by the automated pipeline or requiring manual approval are queued here.'
    )
    .setColor(0x3498db)
    .addFields(
      { name: '⏳ Pending Pipeline', value: `**${metrics.pendingVerificationCount || 0}** clips`, inline: true },
      { name: '🔍 Under Review', value: `**${metrics.underReviewCount || 0}** clips`, inline: true },
      { name: '🚩 Flagged / Anomalies', value: `**${metrics.flaggedCount || 0}** clips`, inline: true },
      { name: '🔄 Post-Approval Review', value: `**${metrics.postApprovalCount || 0}** clips`, inline: true },
      { name: '⚡ Moderation SLA', value: '< 24 hours standard', inline: true },
      { name: '🛡️ Moderation Policy', value: 'Zero-Trust • Structured Rejections Required', inline: true }
    )
    .setFooter({ text: 'Peak Clip Staff Operations • Moderation Workspace' })
    .setTimestamp();
}

/**
 * Build Review Queue List Embed
 */
export function buildStaffReviewQueueListEmbed(submissions = [], page = 1, totalPages = 1) {
  const list = Array.isArray(submissions) ? submissions : (submissions?.items || []);
  const embed = new EmbedBuilder()
    .setTitle(`📋 Staff Review Queue — Page ${page}/${totalPages}`)
    .setColor(0x3498db)
    .setTimestamp();

  if (list.length === 0) {
    embed.setDescription('✅ **Review Queue Clear** — No submissions currently requiring staff inspection.');
  } else {
    const items = list.map((sub, i) => {
      const idx = (page - 1) * 5 + i + 1;
      const creatorTag = sub.user?.discordId ? `<@${sub.user.discordId}>` : `Creator ${sub.userId}`;
      const campaignName = sub.campaign?.name || 'Campaign';
      const duration = sub.durationSeconds != null ? `${sub.durationSeconds}s` : 'Unknown';
      const statusBadge = `\`${sub.status}\``;
      return (
        `**${idx}. [${sub.platform}] ${campaignName}** ${statusBadge}\n` +
        `• **Creator**: ${creatorTag} (\`${sub.user?.username || 'user'}\`)\n` +
        `• **Video**: [Open Link](${sub.url}) | **Duration**: \`${duration}\`\n` +
        `• **Submission ID**: \`${sub.id}\``
      );
    });
    embed.setDescription(items.join('\n\n'));
  }

  embed.setFooter({ text: `Page ${page} of ${totalPages} • Click an action button below to review` });
  return embed;
}

/**
 * Build Single Submission Detailed Inspection Embed
 */
export function buildStaffSubmissionDetailEmbed(submission) {
  const creatorTag = submission.user?.discordId ? `<@${submission.user.discordId}>` : `Creator ${submission.userId}`;
  const duration = submission.durationSeconds != null ? `${submission.durationSeconds}s` : 'N/A';
  const retention = submission.retentionRequired
    ? `Required (${submission.retentionDays || 0}d) • \`${submission.retentionStatus || 'PENDING'}\``
    : 'Not required';

  const verifications = submission.verifications || [];
  const latestVer = verifications[0] || null;
  const riskScore = latestVer?.score != null ? latestVer.score : 'N/A';
  const riskLevel = latestVer?.riskLevel ? `\`${latestVer.riskLevel}\`` : 'N/A';

  const embed = new EmbedBuilder()
    .setTitle(`🔎 Submission Telemetry — ${submission.platform}`)
    .setDescription(`**URL**: [${submission.url}](${submission.url})\n**ID**: \`${submission.id}\``)
    .setColor(submission.status === 'APPROVED' ? 0x2ecc71 : submission.status === 'REJECTED' ? 0xe74c3c : 0xf39c12)
    .addFields(
      { name: '👤 Creator', value: `${creatorTag}\n\`${submission.user?.username || 'unknown'}\``, inline: true },
      { name: '🎯 Campaign', value: `${submission.campaign?.name || 'Campaign'}\n\`${submission.campaignId}\``, inline: true },
      { name: '📌 Current Status', value: `\`${submission.status}\``, inline: true },
      { name: '⏱️ Clip Duration', value: `\`${duration}\``, inline: true },
      { name: '🛡️ Retention', value: retention, inline: true },
      { name: '⚖️ Risk Assessment', value: `Risk: ${riskLevel} | Score: \`${riskScore}\``, inline: true }
    );

  // Latest Snapshot Metrics
  const latestSnap = submission.snapshots?.[0] || null;
  let metricsText = 'No metrics captured yet';
  if (latestSnap) {
    const v = latestSnap.views != null ? Number(latestSnap.views).toLocaleString('en-US') : 'N/A';
    const l = latestSnap.likes != null ? Number(latestSnap.likes).toLocaleString('en-US') : 'N/A';
    const c = latestSnap.comments != null ? Number(latestSnap.comments).toLocaleString('en-US') : 'N/A';
    const capturedTime = latestSnap.capturedAt ? `<t:${Math.floor(new Date(latestSnap.capturedAt).getTime() / 1000)}:R>` : 'Unknown';
    const sourceBadge = latestSnap.source === 'MANUAL' ? ' *(Source: ✍️ MANUAL)*' : ' *(Source: 🤖 AUTO)*';
    metricsText = `👁️ Views: **${v}** | ❤️ Likes: **${l}** | 💬 Comments: **${c}**${sourceBadge}\n🕒 Last Check: ${capturedTime}`;
  } else if (submission.platform === 'FACEBOOK') {
    metricsText = '⏳ **Awaiting staff verification** (Manual Entry Required)';
  } else if (submission.platform === 'TIKTOK') {
    metricsText = '⚠️ **Official API unavailable** (Partner Integration Required)';
  }

  // Tracking and Availability Info
  const availStatus = submission.lastAvailabilityStatus ? `\`${submission.lastAvailabilityStatus}\`` : '`AVAILABLE`';
  let trackingState;
  if (submission.platform === 'FACEBOOK') {
    trackingState = '📘 `MANUAL_VERIFICATION_ONLY` (Hourly polling disabled)';
  } else if (submission.platform === 'TIKTOK') {
    trackingState = '⏸️ `PROVIDER_UNAVAILABLE` (No automatic polling)';
  } else {
    trackingState = submission.status === 'APPROVED'
      ? '🟢 `ACTIVE_TRACKING`'
      : submission.status === 'PENDING_VERIFICATION' || submission.status === 'UNDER_REVIEW'
        ? '⏳ `PENDING`'
        : `⏸️ \`${submission.status}\``;
  }
  const verifiedText = submission.verifiedAt
    ? `<t:${Math.floor(new Date(submission.verifiedAt).getTime() / 1000)}:R>`
    : 'Not yet verified';
  const submittedText = submission.submittedAt
    ? `<t:${Math.floor(new Date(submission.submittedAt).getTime() / 1000)}:R>`
    : 'Unknown';

  embed.addFields(
    { name: '📊 Current Metrics', value: metricsText, inline: false },
    { name: '📡 Tracking & Availability', value: `Status: ${trackingState} | Availability: ${availStatus}\nSubmitted: ${submittedText} | Verified: ${verifiedText}`, inline: false }
  );

  if (submission.moderationHistory?.length > 0) {
    const recentHist = submission.moderationHistory.slice(0, 3).map((h) => {
      const time = `<t:${Math.floor(new Date(h.createdAt).getTime() / 1000)}:R>`;
      const label = h.reason ? ` — ${getCreatorSafeReasonLabel(h.reason)}` : '';
      return `• \`${h.action}\` (${h.actorType}) ${time}${label}`;
    });
    embed.addFields({ name: '📜 Recent Moderation Trail', value: recentHist.join('\n'), inline: false });
  }

  embed.setFooter({ text: 'Peak Clip Staff Telemetry • Zero-Trust Review' });
  embed.setTimestamp();
  return embed;
}

/**
 * Build Creator Hub Canonical Embed (#creators)
 */
export function buildStaffCreatorHubEmbed(metrics = {}) {
  return new EmbedBuilder()
    .setTitle('👥 STAFF CREATOR MANAGEMENT HUB')
    .setDescription(
      'Operational workspace for creator onboarding, verification status, and moderation controls.\n' +
      'Search creators, audit submitted clips, inspect earnings, and manage account statuses.'
    )
    .setColor(0x9b59b6)
    .addFields(
      { name: '👤 Total Creators', value: `**${metrics.totalCount || 0}** registered`, inline: true },
      { name: '✅ Active Creators', value: `**${metrics.activeCount || 0}** active`, inline: true },
      { name: '⏸️ Suspended', value: `**${metrics.suspendedCount || 0}** suspended`, inline: true },
      { name: '🚫 Banned Accounts', value: `**${metrics.bannedCount || 0}** banned`, inline: true },
      { name: '🔒 Security Controls', value: 'Instant Ban/Suspend • Preserved Ledgers', inline: true }
    )
    .setFooter({ text: 'Peak Clip Staff Operations • Creator Workspace' })
    .setTimestamp();
}

/**
 * Build Creator List Embed
 */
export function buildStaffCreatorListEmbed(creators = [], page = 1, totalPages = 1) {
  const embed = new EmbedBuilder()
    .setTitle(`👥 Creator Directory — Page ${page}/${totalPages}`)
    .setColor(0x9b59b6)
    .setTimestamp();

  if (creators.length === 0) {
    embed.setDescription('No creators found.');
  } else {
    const lines = creators.map((c, i) => {
      const idx = (page - 1) * 5 + i + 1;
      const joinedTime = c.createdAt ? `<t:${Math.floor(new Date(c.createdAt).getTime() / 1000)}:R>` : 'Unknown';
      const statusBadge = c.status === 'ACTIVE' ? '🟢 `ACTIVE`' : c.status === 'SUSPENDED' ? '🟡 `SUSPENDED`' : '🔴 `BANNED`';
      return (
        `**${idx}. ${c.displayName || c.username}** ${statusBadge}\n` +
        `• Discord: <@${c.discordId}> (\`${c.discordId}\`)\n` +
        `• Joined: ${joinedTime} | UUID: \`${c.id}\``
      );
    });
    embed.setDescription(lines.join('\n\n'));
  }

  embed.setFooter({ text: `Page ${page} of ${totalPages} • Select a creator to inspect details` });
  return embed;
}

/**
 * Build Creator-specific Submissions List Embed (#creators)
 *
 * @param {object} user
 * @param {Array<object>} submissions
 * @param {number} page
 * @param {number} totalPages
 * @returns {EmbedBuilder}
 */
export function buildStaffCreatorSubsListEmbed(user, submissions = [], page = 1, totalPages = 1) {
  const username = user?.displayName || user?.username || 'Creator';
  const list = Array.isArray(submissions) ? submissions : (submissions?.items || []);

  const embed = new EmbedBuilder()
    .setTitle(`🎬 Submissions — ${username} (Page ${page}/${totalPages})`)
    .setColor(0x9b59b6)
    .setTimestamp();

  if (list.length === 0) {
    embed.setDescription(`No clips submitted yet by **${username}**.`);
  } else {
    const items = list.map((sub, i) => {
      const idx = (page - 1) * 5 + i + 1;
      const campaignName = sub.campaign?.name || 'Campaign';
      const duration = sub.durationSeconds != null ? `${sub.durationSeconds}s` : 'Unknown';
      const statusBadge = `\`${sub.status}\``;
      return (
        `**${idx}. [${sub.platform}] ${campaignName}** ${statusBadge}\n` +
        `• **Video**: [Open Link](${sub.url}) | **Duration**: \`${duration}\`\n` +
        `• **Submission ID**: \`${sub.id}\``
      );
    });
    embed.setDescription(items.join('\n\n'));
  }

  embed.setFooter({ text: `Page ${page} of ${totalPages} • Peak Clip Staff Creator Workspace` });
  return embed;
}

/**
 * Build Single Creator Detailed Inspection Embed
 */
export function buildStaffCreatorDetailEmbed(creatorData) {
  const user = creatorData;
  const statusBadge = user.status === 'ACTIVE' ? '🟢 `ACTIVE`' : user.status === 'SUSPENDED' ? '🟡 `SUSPENDED`' : '🔴 `BANNED`';
  const joinedTime = user.createdAt ? `<t:${Math.floor(new Date(user.createdAt).getTime() / 1000)}:f>` : 'Unknown';
  const breakdown = user.submissionStatusBreakdown || {};

  const embed = new EmbedBuilder()
    .setTitle(`👤 Creator Profile — ${user.displayName || user.username}`)
    .setDescription(`Discord: <@${user.discordId}> (\`${user.discordId}\`)\nInternal UUID: \`${user.id}\``)
    .setColor(user.status === 'ACTIVE' ? 0x2ecc71 : 0xe74c3c)
    .addFields(
      { name: '📌 Account Status', value: statusBadge, inline: true },
      { name: '📅 Joined Platform', value: joinedTime, inline: true },
      { name: '🎬 Total Submissions', value: `**${user.totalSubmissions || 0}** submitted`, inline: true },
      {
        name: '📊 Submissions Breakdown',
        value:
          `• Approved: **${breakdown.APPROVED || 0}**\n` +
          `• Under Review: **${breakdown.UNDER_REVIEW || 0}**\n` +
          `• Pending: **${breakdown.PENDING_VERIFICATION || 0}**\n` +
          `• Flagged: **${breakdown.FLAGGED || 0}**\n` +
          `• Rejected: **${breakdown.REJECTED || 0}**`,
        inline: true
      },
      { name: '💸 Payout Requests', value: `**${user.totalPayoutRequests || 0}** requests`, inline: true },
      { name: '🎯 Campaigns Joined', value: `**${user.memberships?.length || 0}** campaigns`, inline: true }
    );

  if (user.financials) {
    const fin = user.financials;
    embed.addFields({
      name: '💰 Financial Ledger Breakdown',
      value:
        `• Gross Earned: **$${Number(fin.eligibleEarnings || 0).toFixed(2)}**\n` +
        `• Available Balance: **$${Number(fin.availableBalance || 0).toFixed(2)}**\n` +
        `• Active Reservations: **$${Number(fin.reservedBalance || 0).toFixed(2)}**\n` +
        `• Disbursed Volume: **$${Number(fin.completedPayouts || 0).toFixed(2)}**`,
      inline: false
    });
  }

  if (user.payoutProfile) {
    const p = user.payoutProfile;
    const masked = p.walletAddress
      ? `\`${p.walletAddress.substring(0, 6)}••••${p.walletAddress.substring(p.walletAddress.length - 4)}\` (${p.network || 'Polygon'})`
      : 'Unspecified';
    embed.addFields({
      name: '💳 Payout Profile Status',
      value: `• Destination: ${masked}\n• Provider: \`${p.walletName || 'Manual'}\` • Verified: ✅`,
      inline: false
    });
  }

  embed.setFooter({ text: 'Peak Clip Staff Creator Operations • Zero-Trust Security' })
    .setTimestamp();

  return embed;
}

/**
 * Build Campaign Hub Canonical Embed (#campaign-management)
 */
export function buildStaffCampaignHubEmbed(metrics = {}) {
  return new EmbedBuilder()
    .setTitle('🎯 STAFF CAMPAIGN MANAGEMENT HUB')
    .setDescription(
      'Operational command center for clipping campaigns, budgets, rates, and fulfillment tracking.\n' +
      'Monitor live budgets, creator caps, duration policies, and campaign state transitions.'
    )
    .setColor(0xe67e22)
    .addFields(
      { name: '🎯 Active Campaigns', value: `**${metrics.activeCount || 0}** live`, inline: true },
      { name: '⏸️ Paused Campaigns', value: `**${metrics.pausedCount || 0}** paused`, inline: true },
      { name: '🏁 Completed / Exhausted', value: `**${metrics.completedCount || 0}** completed`, inline: true },
      { name: '💰 Total Budget Committed', value: `$${Number(metrics.totalBudget || 0).toFixed(2)}`, inline: true },
      { name: '📊 Total Budget Consumed', value: `$${Number(metrics.consumedBudget || 0).toFixed(2)}`, inline: true },
      { name: '💵 Remaining Budget', value: `$${Number(metrics.remainingBudget || 0).toFixed(2)}`, inline: true }
    )
    .setFooter({ text: 'Peak Clip Staff Operations • Campaign Operations' })
    .setTimestamp();
}

/**
 * Build Campaign List Embed
 */
export function buildStaffCampaignListEmbed(campaigns = [], page = 1, totalPages = 1) {
  const embed = new EmbedBuilder()
    .setTitle(`🎯 Campaign Directory — Page ${page}/${totalPages}`)
    .setColor(0xe67e22)
    .setTimestamp();

  if (campaigns.length === 0) {
    embed.setDescription('No campaigns found.');
  } else {
    const lines = campaigns.map((c, i) => {
      const idx = (page - 1) * 5 + i + 1;
      const statusBadge = `\`${c.status}\``;
      const total = Number(c.totalBudget || 0).toFixed(2);
      const consumed = Number(c.consumedBudget || 0).toFixed(2);
      const remaining = Math.max(0, total - consumed).toFixed(2);
      const pct = total > 0 ? ((consumed / total) * 100).toFixed(1) : '0.0';

      return (
        `**${idx}. ${c.name}** (${c.clientName}) ${statusBadge}\n` +
        `• **Budget**: $${consumed} / $${total} (${pct}% fulfilled) | Rem: **$${remaining}**\n` +
        `• **Rate**: $${Number(c.payRate).toFixed(2)} / 1k views | Cap: $${Number(c.creatorEarningCap || 600).toFixed(2)}\n` +
        `• **UUID**: \`${c.id}\``
      );
    });
    embed.setDescription(lines.join('\n\n'));
  }

  embed.setFooter({ text: `Page ${page} of ${totalPages} • Select a campaign to manage` });
  return embed;
}

/**
 * Build Single Campaign Detailed Inspection Embed
 */
export function buildStaffCampaignDetailEmbed(campaign) {
  const liveConsumedVal = Math.max(
    Number(campaign.consumedBudget || 0),
    Number(campaign.metrics?.liveConsumedBudget || 0),
    Number(campaign.metrics?.totalEligibleEarnings || 0)
  );
  const total = Number(campaign.totalBudget || 0).toFixed(2);
  const consumed = liveConsumedVal.toFixed(2);
  const remaining = Math.max(0, Number(campaign.totalBudget || 0) - liveConsumedVal).toFixed(2);
  const pct = Number(campaign.totalBudget || 0) > 0 ? ((liveConsumedVal / Number(campaign.totalBudget)) * 100).toFixed(1) : '0.0';

  const durationStr = `${campaign.minClipDurationSeconds || 7}s – ${campaign.maxClipDurationSeconds || 120}s`;
  const retentionStr = campaign.retentionRequired ? `Required (${campaign.retentionDays || 0} days)` : 'Not required';

  const clippersJoined = campaign.metrics?.activeMembers ?? 0;
  const totalClips = campaign.metrics?.totalSubmissions ?? 0;
  const approvedClips = campaign.metrics?.statusBreakdown?.APPROVED ?? 0;
  const rawPlatforms = campaign.requirements?.allowedPlatforms;
  const platformsStr = Array.isArray(rawPlatforms) && rawPlatforms.length > 0
    ? rawPlatforms.map((p) => String(p).toUpperCase()).join(', ')
    : 'ALL';

  const embed = new EmbedBuilder()
    .setTitle(`🎯 Campaign Details — ${campaign.name}`)
    .setDescription(
      `**Client**: ${campaign.clientName}\n` +
      `**Slug**: \`${campaign.slug}\`\n` +
      `**UUID**: \`${campaign.id}\`` +
      (campaign.description ? `\n**Description**: ${campaign.description}` : '')
    )
    .setColor(campaign.status === 'ACTIVE' ? 0x2ecc71 : campaign.status === 'PAUSED' ? 0xf39c12 : 0x95a5a6)
    .addFields(
      { name: '📌 Status', value: `\`${campaign.status}\``, inline: true },
      { name: '💵 Pay Rate (CPM)', value: `$${Number(campaign.payRate).toFixed(2)} / 1k`, inline: true },
      { name: '🧢 Creator Cap', value: `$${Number(campaign.creatorEarningCap || 600).toFixed(2)}`, inline: true },
      {
        name: '💰 Financial Progress',
        value: `Total: **$${total}**\nConsumed: **$${consumed}** (${pct}%)\nRemaining: **$${remaining}**`,
        inline: true
      },
      {
        name: '👥 Participation',
        value: `Clippers: **${clippersJoined}**\nTotal Clips: **${totalClips}** (✅ ${approvedClips} approved)`,
        inline: true
      },
      { name: '🌐 Allowed Platforms', value: `\`${platformsStr}\``, inline: true },
      { name: '⏱️ Clip Duration', value: durationStr, inline: true },
      { name: '🛡️ Retention', value: retentionStr, inline: true }
    )
    .setFooter({ text: 'Peak Clip Staff Campaign Management' })
    .setTimestamp();

  return embed;
}

/**
 * Build Payout Queue Hub Canonical Embed (#payout-queue)
 */
export function buildStaffPayoutHubEmbed(metrics = {}) {
  return new EmbedBuilder()
    .setTitle('💸 STAFF PAYOUT & FINANCIAL QUEUE')
    .setDescription(
      'Operational financial desk for creator payout verification and disbursement authorization.\n' +
      'Every payout requires an active payout profile and fresh analytics screen recording (<40.0s).'
    )
    .setColor(0x2ecc71)
    .addFields(
      { name: '📥 Awaiting Review', value: `**${metrics.pendingCount || 0}** requests`, inline: true },
      { name: '💰 Total Pending Amount', value: `$${Number(metrics.totalPendingAmount || 0).toFixed(2)}`, inline: true },
      { name: '✅ Approved for Disbursement', value: `**${metrics.approvedCount || 0}** requests`, inline: true },
      { name: '🎬 Evidence Policy', value: 'Screen Recording < 40.0s • Demographics Checked', inline: true },
      { name: '🔒 Financial Authority', value: 'Peak Admin Only • Concurrency Locked', inline: true }
    )
    .setFooter({ text: 'Peak Clip Financial Desk • Zero Double-Disbursement Guarantee' })
    .setTimestamp();
}

/**
 * Build Payout List Embed (Queue or History)
 */
export function buildStaffPayoutListEmbed(requests = [], page = 1, totalPages = 1, isHistory = false) {
  const title = isHistory ? `📜 Payout History — Page ${page}/${totalPages}` : `💸 Staff Payout Review Queue — Page ${page}/${totalPages}`;
  const embed = new EmbedBuilder().setTitle(title).setColor(0x2ecc71).setTimestamp();

  if (requests.length === 0) {
    embed.setDescription(isHistory ? 'No past payout records found.' : '✅ **Payout Queue Clear** — No pending payout requests awaiting review.');
  } else {
    const lines = requests.map((req, i) => {
      const idx = (page - 1) * 5 + i + 1;
      const creatorTag = req.user?.discordId ? `<@${req.user.discordId}>` : `Creator ${req.userId}`;
      const amount = Number(req.amount || 0).toFixed(2);
      const badge = formatPayoutStatusBadge(req.status);
      const time = req.createdAt ? `<t:${Math.floor(new Date(req.createdAt).getTime() / 1000)}:R>` : 'Unknown';

      return (
        `**${idx}. Payout Request $${amount}** ${badge}\n` +
        `• Creator: ${creatorTag} | Requested: ${time}\n` +
        `• Payout ID: \`${req.id}\``
      );
    });
    embed.setDescription(lines.join('\n\n'));
  }

  embed.setFooter({ text: `Page ${page} of ${totalPages} • Select a request to review telemetry & evidence` });
  return embed;
}

/**
 * Build Single Payout Request Detailed Inspection Embed
 */
export function buildStaffPayoutDetailEmbed(req) {
  const creatorTag = req.user?.discordId ? `<@${req.user.discordId}>` : `Creator ${req.userId}`;
  const amount = Number(req.amount || 0).toFixed(2);
  const badge = formatPayoutStatusBadge(req.status);
  const time = req.createdAt ? `<t:${Math.floor(new Date(req.createdAt).getTime() / 1000)}:f>` : 'Unknown';

  const profile = req.profileSnapshot || req.activeProfile || {};
  const walletStr = profile.walletAddress
    ? `\`${profile.walletAddress.substring(0, 6)}••••${profile.walletAddress.substring(profile.walletAddress.length - 4)}\` (${profile.network || 'Polygon'})\nApp: \`${profile.walletName || 'Manual'}\` • Status: ✅ \`VERIFIED\``
    : 'No profile snapshot attached';

  const evidenceList = req.evidence || [];
  const latestEv = evidenceList[evidenceList.length - 1] || null;
  const evStatus = latestEv ? `\`${latestEv.status}\` (${latestEv.durationSeconds || '?'}s, v${latestEv.version || 1})` : '⚠️ No recording attached';

  const embed = new EmbedBuilder()
    .setTitle(`💸 Payout Request Details — $${amount}`)
    .setDescription(`**Status**: ${badge}\n**Request ID**: \`${req.id}\`\n**Created**: ${time}`)
    .setColor(req.status === 'COMPLETED' ? 0x2ecc71 : req.status === 'REJECTED' ? 0xe74c3c : 0x3498db)
    .addFields(
      { name: '👤 Creator', value: `${creatorTag}\n\`${req.user?.username || 'user'}\``, inline: true },
      { name: '💵 Amount Requested', value: `**$${amount} ${req.currency || 'USD'}**`, inline: true },
      { name: '💳 Payout Destination', value: walletStr, inline: false },
      { name: '🎬 Analytics Evidence', value: evStatus, inline: false }
    );

  if (req.balanceBreakdown) {
    const b = req.balanceBreakdown;
    embed.addFields({
      name: '💰 Creator Ledger State',
      value: `• Available: **$${Number(b.availableBalance || 0).toFixed(2)}** | Reserved: **$${Number(b.reservedBalance || 0).toFixed(2)}**`,
      inline: false
    });
  }

  embed.setFooter({ text: 'Peak Clip Financial Operations • Zero-Trust Verification' })
    .setTimestamp();

  return embed;
}

/**
 * Build Evidence Telemetry Review Embed
 *
 * @param {object} payoutRequest
 * @param {object|null} evidence
 * @param {object} [options={}] - { hasAttachment, fileError, totalVersions }
 * @returns {EmbedBuilder}
 */
export function buildStaffEvidenceReviewEmbed(payoutRequest, evidence, options = {}) {
  const amount = Number(payoutRequest?.amount || 0).toFixed(2);

  if (!evidence) {
    return new EmbedBuilder()
      .setTitle('📹 ANALYTICS SCREEN RECORDING TELEMETRY REVIEW')
      .setDescription(
        `Verifying audience authenticity for Payout Request \`${payoutRequest?.id || 'N/A'}\` ($${amount}).\n\n` +
        '⚠️ **No screen recording evidence was submitted for this payout request.**\n' +
        'This request has no attached analytics telemetry video on record.'
      )
      .setColor(0xe67e22)
      .addFields(
        { name: '🎬 Evidence ID', value: '`None`', inline: true },
        { name: '⏱️ Duration Check', value: '`N/A`', inline: true },
        { name: '📦 File Status', value: '`No Recording Attached`', inline: true },
        { name: '📌 Evidence Status', value: '`NOT_SUBMITTED`', inline: true }
      )
      .setFooter({ text: 'Peak Clip Fraud Prevention • Demographics Review' })
      .setTimestamp();
  }

  const durationSec = evidence.durationSeconds != null ? Number(evidence.durationSeconds).toFixed(2) : 'Unknown';
  const durationCheck = evidence.durationSeconds != null && Number(evidence.durationSeconds) <= 40.0
    ? '✅ PASSED (<= 40.0s strict)'
    : '❌ VIOLATION (> 40.0s)';

  const sizeKb = Math.round(Number(evidence.fileSize || 0) / 1024);
  const sizeMb = (Number(evidence.fileSize || 0) / (1024 * 1024)).toFixed(2);

  let desc = `Verifying audience authenticity for Payout Request \`${payoutRequest?.id || 'N/A'}\` ($${amount}).\n` +
    'Staff must inspect the recording for valid channel ownership, views, and demographics.';

  if (options.hasAttachment) {
    desc += '\n\n▶️ **Screen recording video is attached below for direct playback in Discord.**';
  } else if (options.fileError) {
    desc += `\n\n⚠️ **File Warning:** \`${options.fileError}\``;
  }

  const embed = new EmbedBuilder()
    .setTitle('📹 ANALYTICS SCREEN RECORDING TELEMETRY REVIEW')
    .setDescription(desc)
    .setColor(evidence.status === 'ACCEPTED' ? 0x2ecc71 : evidence.status === 'REJECTED' ? 0xe74c3c : 0x3498db)
    .addFields(
      {
        name: '🎬 Evidence ID',
        value: `\`${evidence.id}\` (Version **${evidence.version || 1}**${options.totalVersions ? ` of ${options.totalVersions}` : ''})`,
        inline: true
      },
      { name: '⏱️ Duration Check', value: `${durationCheck}\nDuration: \`${durationSec}s\``, inline: true },
      { name: '📦 File Size & Type', value: `${sizeKb} KB (${sizeMb} MB) • \`${evidence.mimeType || 'video/mp4'}\``, inline: true },
      { name: '📁 Filename', value: `\`${evidence.filename || 'recording.mp4'}\``, inline: true },
      { name: '💾 Storage Key', value: `\`${evidence.storageKey || 'N/A'}\``, inline: true },
      { name: '📌 Evidence Status', value: `\`${evidence.status || 'PENDING_REVIEW'}\``, inline: true },
      {
        name: '📊 Required Demographics Telemetry Checklist',
        value:
          '• **Account Match**: Channel handle matches creator\n' +
          '• **Audience Views**: View count aligns with reported views (Meta Professional Dashboard verified for Facebook)\n' +
          '• **Demographics**: Audience countries, age distribution, and gender visible\n' +
          '• **Unedited Recording**: Continuous, authentic video without editing or spoofing',
        inline: false
      }
    );

  if (evidence.rejectionReason) {
    embed.addFields({ name: '⚠️ Rejection Reason', value: `\`${evidence.rejectionReason}\`\n${evidence.notes || ''}`, inline: false });
  }

  embed.setFooter({ text: 'Peak Clip Fraud Prevention • Demographics Review' });
  embed.setTimestamp();
  return embed;
}

/**
 * Build Audit Log Hub Canonical Embed (#audit-log)
 */
export function buildStaffAuditHubEmbed(metrics = {}) {
  return new EmbedBuilder()
    .setTitle('📜 STAFF IMMUTABLE AUDIT TRAIL')
    .setDescription(
      'Permanent, tamper-evident audit log of all staff operations, status transitions, and financial outcomes.\n' +
      'Every administrative action is cryptographically tied to actor Discord snowflake and timestamp.'
    )
    .setColor(0x34495e)
    .addFields(
      { name: '📜 Recorded Events', value: `**${metrics.totalEvents || 0}** events`, inline: true },
      { name: '🔒 Immutability', value: 'Strictly Append-Only • Zero Deletions', inline: true },
      { name: '🛡️ Audit Coverage', value: 'Submissions • Payouts • Campaigns • Creators', inline: true }
    )
    .setFooter({ text: 'Peak Clip Immutable Audit Trail' })
    .setTimestamp();
}

/**
 * Build Audit Log List Embed
 */
export function buildStaffAuditListEmbed(events = [], page = 1, totalPages = 1) {
  const embed = new EmbedBuilder()
    .setTitle(`📜 Immutable Audit Log — Page ${page}/${totalPages}`)
    .setColor(0x34495e)
    .setTimestamp();

  if (events.length === 0) {
    embed.setDescription('No audit events recorded yet.');
  } else {
    const lines = events.map((ev, i) => {
      const idx = (page - 1) * 5 + i + 1;
      const time = ev.createdAt ? `<t:${Math.floor(new Date(ev.createdAt).getTime() / 1000)}:f>` : 'Unknown';
      const actorTag = `<@${ev.actorDiscordId}>`;
      const reasonStr = ev.reason ? `\n  *Reason: ${ev.reason}*` : '';

      return (
        `**${idx}. \`${ev.action}\`** (${ev.entityType})\n` +
        `• Actor: ${actorTag} | Target ID: \`${ev.entityId}\`\n` +
        `• Time: ${time}${reasonStr}`
      );
    });
    embed.setDescription(lines.join('\n\n'));
  }

  embed.setFooter({ text: `Page ${page} of ${totalPages} • Immutable audit records` });
  return embed;
}

/**
 * Build System Status Canonical Embed (#bot-status)
 */
export function buildStaffSystemStatusEmbed(healthData = {}) {
  const ping = healthData.gatewayPing != null ? `${healthData.gatewayPing} ms` : 'N/A';
  const dbLatency = healthData.dbLatency != null ? `${healthData.dbLatency} ms` : 'N/A';
  const memUsage = healthData.memoryMb != null ? `${healthData.memoryMb} MB` : 'N/A';
  const uptime = healthData.uptimeStr || '0h 0m';

  return new EmbedBuilder()
    .setTitle('⚙️ PEAK CLIP — SYSTEM STATUS & TELEMETRY')
    .setDescription('Real-time operational health telemetry for bot runtime and platform infrastructure.')
    .setColor(0x1abc9c)
    .addFields(
      { name: '🟢 Bot Gateway', value: `Online • Ping: \`${ping}\``, inline: true },
      { name: '🗄️ PostgreSQL Database', value: `Connected • Query: \`${dbLatency}\``, inline: true },
      { name: '⚡ Redis / Queues', value: healthData.redisStatus || 'Deferred/Offline mode', inline: true },
      { name: '⏱️ Runtime Uptime', value: uptime, inline: true },
      { name: '💾 Memory Footprint', value: memUsage, inline: true },
      { name: '🛡️ Zero-Trust Engine', value: 'Active • Enforced Server-Side', inline: true }
    )
    .setFooter({ text: 'Peak Clip System Health Telemetry' })
    .setTimestamp();
}

/**
 * Build Bot Errors Overview Embed (#bot-errors)
 */
export function buildStaffBotErrorsEmbed(errorMetrics = {}) {
  return new EmbedBuilder()
    .setTitle('🚨 PEAK CLIP — ERROR & DIAGNOSTIC INGESTION')
    .setDescription(
      'Automated diagnostic alert channel for runtime interaction exceptions, API rate limits, and service failures.\n' +
      'All exceptions logged here preserve safe client messages without leaking server secrets.'
    )
    .setColor(0xc0392b)
    .addFields(
      { name: '📊 Recent Incidents', value: `**${errorMetrics.recentCount || 0}** logged in session`, inline: true },
      { name: '🔒 Security Redaction', value: 'Credentials & Full Stacks Redacted', inline: true },
      { name: '⚙️ Diagnostic Logging', value: 'Active • Correlation IDs Tracked', inline: true }
    )
    .setFooter({ text: 'Peak Clip Incident Ingestion' })
    .setTimestamp();
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBMISSION REGISTRY AND ANALYTICS EMBEDS
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORM_EMOJI = { YOUTUBE: '▶️', TIKTOK: '🎵', INSTAGRAM: '📸', FACEBOOK: '🔵' };
const STATUS_BADGE = {
  APPROVED: '✅ `APPROVED`',
  REJECTED: '❌ `REJECTED`',
  FLAGGED: '🚩 `FLAGGED`',
  UNDER_REVIEW: '🔍 `UNDER_REVIEW`',
  PENDING_VERIFICATION: '⏳ `PENDING_VERIFICATION`',
  POST_APPROVAL_REVIEW: '🔄 `POST_APPROVAL_REVIEW`'
};



// ─────────────────────────────────────────────────────────────────────────────
// SUBMISSION REGISTRY LIST EMBED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build Staff Submission Registry List Embed
 */
export function buildStaffSubmissionRegistryEmbed(submissions = [], { page = 1, totalPages = 1, totalCount = 0, platform = 'ALL', status = 'ALL' } = {}) {
  const list = Array.isArray(submissions) ? submissions : [];
  const embed = new EmbedBuilder()
    .setTitle('📂 SUBMISSION REGISTRY — ALL PLATFORMS')
    .setColor(0x9b59b6)
    .addFields(
      { name: '📊 Total Submissions', value: `**${totalCount}**`, inline: true },
      { name: '🔎 Platform Filter', value: `\`${platform}\``, inline: true },
      { name: '📌 Status Filter', value: `\`${status}\``, inline: true }
    );

  if (list.length === 0) {
    embed.setDescription('No submissions match the current filters.');
  } else {
    const lines = list.map((sub, i) => {
      const idx = (page - 1) * 5 + i + 1;
      const platformEmoji = PLATFORM_EMOJI[sub.platform] || '🎬';
      const statusBadge = STATUS_BADGE[sub.status] || `\`${sub.status}\``;
      const submittedAt = sub.submittedAt
        ? `<t:${Math.floor(new Date(sub.submittedAt).getTime() / 1000)}:d>`
        : 'N/A';
      const creatorTag = sub.user?.discordId ? `<@${sub.user.discordId}>` : `\`${sub.userId}\``;
      const latestSnap = (sub.snapshots || []).sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt))[0];
      const views = latestSnap ? `👁️ ${Number(latestSnap.views || 0).toLocaleString()}` : '👁️ N/A';
      return (
        `**${idx}. ${platformEmoji} \`${sub.id}\`** ${statusBadge}\n` +
        `• Creator: ${creatorTag} | Campaign: **${sub.campaign?.name || 'N/A'}**\n` +
        `• ${views} | Submitted: ${submittedAt}`
      );
    });
    embed.setDescription(lines.join('\n\n'));
  }

  embed.setFooter({ text: `Page ${page} of ${totalPages} • ${totalCount} total submissions` }).setTimestamp();
  return embed;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBMISSION ANALYTICS EMBED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build Staff Submission Analytics (Metric History) Embed
 */
export function buildStaffSubmissionAnalyticsEmbed(analyticsData = {}) {
  const {
    submission,
    snapshots = [],
    page = 1,
    totalPages = 1,
    totalSnapshots = 0,
    totalViewsGained = 0,
    successfulChecks = 0,
    unavailableChecks = 0,
    firstTracked = null,
    latestTracked = null
  } = analyticsData;
  const s = submission || {};
  const platformEmoji = PLATFORM_EMOJI[s.platform] || '🎬';

  const embed = new EmbedBuilder()
    .setTitle(`${platformEmoji} Metric Analytics — \`${s.id || 'Unknown'}\``)
    .setColor(0x1abc9c)
    .addFields(
      { name: '📊 Total Snapshots', value: `**${totalSnapshots}**`, inline: true },
      { name: '🔎 Platform', value: `\`${s.platform || 'N/A'}\``, inline: true },
      { name: '📌 Status', value: STATUS_BADGE[s.status] || `\`${s.status || 'N/A'}\``, inline: true },
      { name: '📈 Total Views Gained', value: `**+${Number(totalViewsGained || 0).toLocaleString('en-US')}**`, inline: true },
      { name: '📡 Polling Checks', value: `✅ **${successfulChecks || 0}** ok | ⚠️ **${unavailableChecks || 0}** unavail`, inline: true },
      {
        name: '⏱️ Tracking Duration',
        value: firstTracked?.capturedAt
          ? `<t:${Math.floor(new Date(firstTracked.capturedAt).getTime() / 1000)}:d> → <t:${Math.floor(new Date(latestTracked?.capturedAt || firstTracked.capturedAt).getTime() / 1000)}:R>`
          : 'N/A',
        inline: true
      }
    );

  if (snapshots.length === 0) {
    embed.setDescription('No metric snapshots recorded yet for this submission.');
  } else {
    const lines = snapshots.map((snap, i) => {
      const idx = (page - 1) * 5 + i + 1;
      const capturedAt = snap.capturedAt
        ? `<t:${Math.floor(new Date(snap.capturedAt).getTime() / 1000)}:f>`
        : 'N/A';
      const views = Number(snap.views || 0).toLocaleString('en-US');
      const likes = Number(snap.likes || 0).toLocaleString('en-US');
      const viewsGained = snap.viewsGained != null ? ` (+${Number(snap.viewsGained).toLocaleString('en-US')})` : '';
      const likesGained = snap.likesGained != null ? ` (+${Number(snap.likesGained).toLocaleString('en-US')})` : '';
      const sourceTag = snap.source === 'MANUAL' ? ' `[✍️ MANUAL]`' : ' `[🤖 AUTO]`';
      return (
        `**${idx}. Snapshot**${sourceTag} — ${capturedAt}\n` +
        `• 👁️ Views: **${views}**${viewsGained} | ❤️ Likes: **${likes}**${likesGained}\n` +
        `• 💬 Comments: **${Number(snap.comments || 0).toLocaleString()}** | 🔁 Shares: **${Number(snap.shares || 0).toLocaleString()}**`
      );
    });
    embed.setDescription(lines.join('\n\n'));
  }

  embed.setFooter({ text: `Analytics Page ${page} of ${totalPages} • Submission ${s.id || ''}` }).setTimestamp();
  return embed;
}

