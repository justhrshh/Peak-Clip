import { EmbedBuilder } from 'discord.js';

const SUCCESS_COLOR = 0x57F287; // Green
const BRAND_COLOR = 0x5865F2; // Blurple
const WARNING_COLOR = 0xFEE75C; // Yellow
const DANGER_COLOR = 0xED4245; // Red

/**
 * Format status with emoji badge
 * @param {string} status
 * @returns {string}
 */
export function formatPayoutStatusBadge(status) {
  switch (status) {
    case 'REQUESTED':
      return '⏳ `REQUESTED`';
    case 'UNDER_REVIEW':
      return '🔍 `UNDER REVIEW`';
    case 'APPROVED':
      return '✅ `APPROVED`';
    case 'PROCESSING':
      return '🔄 `PROCESSING`';
    case 'COMPLETED':
      return '🟢 `COMPLETED`';
    case 'FAILED':
      return '❌ `FAILED`';
    case 'REJECTED':
      return '🚫 `REJECTED`';
    case 'CANCELLED':
      return '⚪ `CANCELLED`';
    default:
      return `\`${status}\``;
  }
}

/**
 * Build embed for User Payout Dashboard
 * @param {object} balance
 * @param {Array<object>} history
 * @param {import('discord.js').User} discordUser
 * @param {object|null} [profile=null]
 * @returns {EmbedBuilder}
 */
export function buildUserPayoutEmbed(balance, history, discordUser, profile = null) {
  const symbol = balance.currency === 'USD' ? '$' : `${balance.currency} `;
  const availStr = `${symbol}${Number(balance.availableBalance).toFixed(2)}`;
  const reservedStr = `${symbol}${Number(balance.reservedBalance).toFixed(2)}`;
  const completedStr = `${symbol}${Number(balance.completedPayouts).toFixed(2)}`;
  const minPayoutStr = `${symbol}${Number(balance.minimumPayout).toFixed(2)}`;

  const isEligible = balance.availableBalance.greaterThanOrEqualTo(balance.minimumPayout);

  const embed = new EmbedBuilder()
    .setTitle('🏦 Creator Payout Dashboard')
    .setDescription(`Authoritative payout and disbursement summary for <@${discordUser.id}>.`)
    .setColor(isEligible ? SUCCESS_COLOR : BRAND_COLOR)
    .setTimestamp();

  // Balance breakdown
  embed.addFields({
    name: '💵 Payout Balances',
    value:
      `💰 **Available to Request:** ${availStr}\n` +
      `🔒 **Reserved (Active Requests):** ${reservedStr}\n` +
      `🟢 **Total Disbursed:** ${completedStr}`,
    inline: true
  });

  // Minimum payout condition
  const thresholdNotice = isEligible
    ? `🟢 **Eligible for Payout**\n*You meet the minimum requirement of ${minPayoutStr}.*`
    : `⚪ **Below Minimum (${minPayoutStr})**\n*You need at least ${minPayoutStr} available to request a payout.*`;

  embed.addFields({
    name: '🎯 Minimum Payout Requirement',
    value: thresholdNotice,
    inline: true
  });

  // Payout Profile Section
  if (profile) {
    const rawWallet = profile.walletAddress || '';
    const masked = rawWallet.length > 10
      ? `${rawWallet.slice(0, 6)}••••••••••${rawWallet.slice(-4)}`
      : rawWallet;
    const handleLine = profile.creatorHandle ? `• **Handle:** \`${profile.creatorHandle}\`\n` : '';
    embed.addFields({
      name: '💳 Payout Profile (Verified Destination)',
      value:
        `• **Wallet:** \`${masked}\`\n` +
        `• **Network:** ${profile.network} (${profile.walletName || 'Default'})\n` +
        handleLine +
        `• **Discord:** <@${discordUser.id}>`,
      inline: false
    });
  } else {
    embed.addFields({
      name: '💳 Payout Profile',
      value: '⚠️ *No payout profile configured. Use the button below to set up your payout wallet.*',
      inline: false
    });
  }

  // Active payout request section if one is currently in flight
  const historyList = Array.isArray(history) ? history : [];
  const activeReq = historyList.find((p) =>
    ['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING'].includes(p?.status)
  );
  if (activeReq) {
    const reqAmtStr = `${symbol}${Number(activeReq.amount).toFixed(2)}`;
    const badge = formatPayoutStatusBadge(activeReq.status);
    const evidenceItem = activeReq.evidence?.[0] || null;
    let evidenceStr = '⚠️ *Evidence Pending*';
    if (evidenceItem) {
      evidenceStr = `\`${evidenceItem.status}\` (v${evidenceItem.version || 1}) — \`${evidenceItem.filename}\``;
    }
    embed.addFields({
      name: '📋 Active Payout Request',
      value:
        `💵 **Requested Amount:** ${reqAmtStr}\n` +
        `📋 **Payout Status:** ${badge}\n` +
        `📹 **Evidence:** ${evidenceStr}\n` +
        `🕒 **Requested:** <t:${Math.floor(new Date(activeReq.requestedAt).getTime() / 1000)}:R>`,
      inline: false
    });
  }

  // Recent payout requests
  let historyText = '';
  if (historyList.length > 0) {
    historyText = historyList
      .slice(0, 5)
      .map((req, idx) => {
        const amtStr = `${symbol}${Number(req.amount).toFixed(2)}`;
        const badge = formatPayoutStatusBadge(req.status);
        const unix = Math.floor(new Date(req.requestedAt).getTime() / 1000);
        return `${idx + 1}. **${amtStr}** • ${badge} • <t:${unix}:R>`;
      })
      .join('\n');
  } else {
    historyText = '*No payout requests created yet.*';
  }

  embed.addFields({
    name: '📜 Recent Payout Requests',
    value: historyText,
    inline: false
  });

  embed.addFields({
    name: '📹 Evidence Requirement',
    value: 'Every payout request requires a private screen recording (<40s) showing analytics dashboard telemetry.',
    inline: false
  });

  embed.setFooter({
    text: 'Note: Payout requests reserve balance from your ledger without modifying earnings.'
  });

  return embed;
}

/**
 * Build embed for a successful payout request submission
 * @param {object} payout
 * @param {import('discord.js').User} discordUser
 * @returns {EmbedBuilder}
 */
export function buildPayoutSuccessEmbed(payout, discordUser) {
  const symbol = payout.currency === 'USD' ? '$' : `${payout.currency} `;
  const amtStr = `${symbol}${Number(payout.amount).toFixed(2)}`;

  return new EmbedBuilder()
    .setTitle('✅ Payout Request Submitted')
    .setDescription(
      `Your payout request of **${amtStr}** has been received and queued for review.\n` +
      `Funds have been reserved from your available balance.`
    )
    .setColor(SUCCESS_COLOR)
    .addFields(
      { name: 'Request ID', value: `\`${payout.id}\``, inline: true },
      { name: 'Status', value: formatPayoutStatusBadge(payout.status), inline: true },
      { name: 'Requested At', value: `<t:${Math.floor(new Date(payout.requestedAt || Date.now()).getTime() / 1000)}:f>`, inline: false }
    )
    .setFooter({ text: 'Our team will review your request. Use /payout to track status.' })
    .setTimestamp();
}

/**
 * Build embed displaying creator's Payout Profile
 * @param {object|null} profile
 * @param {import('discord.js').User} discordUser
 * @returns {EmbedBuilder}
 */
export function buildPayoutProfileEmbed(profile, discordUser) {
  const embed = new EmbedBuilder()
    .setTitle('💳 Creator Payout Profile')
    .setDescription(`Payout destination configuration for <@${discordUser.id}>.`)
    .setColor(BRAND_COLOR)
    .setTimestamp();

  if (!profile) {
    embed.addFields({
      name: 'Status',
      value: '⚠️ No payout profile has been configured yet. Use the **Set Up Profile** button to configure your wallet.',
      inline: false
    });
    return embed;
  }

  const rawWallet = profile.walletAddress || '';
  const masked = rawWallet.length > 10
    ? `${rawWallet.slice(0, 6)}••••••••••${rawWallet.slice(-4)}`
    : rawWallet;

  embed.addFields(
    { name: 'Public Wallet Address', value: `\`${masked}\``, inline: false },
    { name: 'Network', value: profile.network, inline: true },
    { name: 'Wallet App / Name', value: profile.walletName || 'Standard', inline: true },
    { name: 'Discord Account', value: discordUser ? `<@${discordUser.id}>` : (profile.creatorHandle ? `\`${profile.creatorHandle}\`` : 'Verified'), inline: true },
    { name: 'Profile Created', value: `<t:${Math.floor(new Date(profile.createdAt).getTime() / 1000)}:R>`, inline: true },
    { name: 'Last Updated', value: `<t:${Math.floor(new Date(profile.updatedAt).getTime() / 1000)}:R>`, inline: true }
  );

  embed.setFooter({
    text: 'Note: Only public address information is stored. Private keys are never requested or stored.'
  });

  return embed;
}

/**
 * Build embed providing platform-specific screen recording evidence instructions
 * @param {string} [platform='YOUTUBE']
 * @returns {EmbedBuilder}
 */
export function buildEvidenceInstructionsEmbed(platform = 'YOUTUBE') {
  const isFb = platform?.toUpperCase() === 'FACEBOOK';
  const embed = new EmbedBuilder()
    .setTitle(`📹 Screen Recording Guidance — ${platform}`)
    .setDescription(
      'To protect creator payouts and verify analytics authenticity, submit a short screen recording demonstrating ownership and telemetry.'
    )
    .setColor(BRAND_COLOR)
    .addFields(
      { name: '⏱️ Duration Limit', value: 'Maximum **40 seconds** (must be <40.0s).', inline: true },
      { name: '📁 Format', value: 'MP4, WebM, MOV, or MKV (Max 50MB)', inline: true },
      { name: '🔒 Security Note', value: 'Evidence files are private and accessible strictly by staff for review.', inline: false }
    );

  if (isFb) {
    embed.addFields({
      name: '📘 Facebook / Meta Requirement',
      value: 'Because Facebook does not show public view counters on single Reel links, you **MUST** open your **Meta Professional Dashboard** or **Creator Studio** in the recording to display the video\'s verified view count.',
      inline: false
    });
  }

  return embed;
}

/**
 * Build Awaiting Analytics Screen Recording embed shown when creator is prompted to upload
 * @returns {EmbedBuilder}
 */
export function buildPayoutEvidenceWaitingEmbed() {
  return new EmbedBuilder()
    .setTitle('📥 Awaiting Analytics Screen Recording')
    .setColor(0x3498db)
    .setDescription(
      'Please upload your analytics screen recording as a video attachment.\n\n' +
      '• **Supported:** `.mp4`, `.webm`, `.mov`, `.mkv`\n' +
      '• **Maximum size:** 20 MB\n' +
      '• **Duration:** under 40 seconds\n' +
      '• **Facebook clips:** Must show Meta Professional Dashboard view count\n\n' +
      'Your recording will be validated automatically after upload.'
    )
    .setFooter({ text: 'Awaiting upload... upload window is active for 2 minutes.' });
}

/**
 * Build Required Analytics Verification embed shown before evidence upload
 * @param {object} params
 * @param {string} params.amount
 * @param {string} params.currency
 * @param {object} params.profile
 * @returns {EmbedBuilder}
 */
export function buildPayoutEvidenceInstructionsEmbed({ amount, currency = 'USD', profile }) {
  const rawWallet = profile?.walletAddress || '';
  const masked = rawWallet.length > 10
    ? `${rawWallet.slice(0, 6)}••••••••••${rawWallet.slice(-4)}`
    : rawWallet;

  return new EmbedBuilder()
    .setTitle('🎬 Required Analytics Verification')
    .setColor(BRAND_COLOR)
    .setDescription(
      'Start the screen recording from this chat, then:\n\n' +
      '📈 **Open your Analytics Dashboard**\n' +
      '🏷️ **Show your name/profile**\n' +
      '👁️ **Show how many people watched your videos**\n' +
      '📅 **Show the age breakdown of your audience**\n' +
      '🌎 **Show the countries your audience is from**\n' +
      '⚧️ **Show the gender breakdown of your audience**\n\n' +
      '📱 **For Facebook / Meta Clips:**\n' +
      '• Open **Meta Professional Dashboard** or **Creator Studio**\n' +
      '• Clearly display the specific Reel / video with its **exact view count**, title, and upload date\n\n' +
      '⏳ **Keep the entire recording UNDER 40 seconds.**\n' +
      '✨ **Make sure all analytics are clearly visible.**\n\n' +
      '⚠️ *The recording must be original and unedited. No artificial/faked analytics, cuts, or manipulated footage. If fraudulent evidence is detected, the account may be subject to moderation according to the platform\'s existing policy.*'
    )
    .addFields(
      { name: '💵 Requested Amount', value: `**$${Number(amount).toFixed(2)} ${currency}**`, inline: true },
      { name: '💳 Destination Wallet', value: `${profile?.network || 'Default'} (\`${masked}\`)`, inline: true }
    )
    .setFooter({
      text: 'Peak Clip • Analytics Screen Recording Required for All Disbursements'
    });
}

/**
 * Build confirmation embed when evidence recording is validated & received
 * @param {object} params
 * @param {object} params.evidence
 * @returns {EmbedBuilder}
 */
export function buildPayoutEvidenceReceivedEmbed(params) {
  const evidence = params?.evidence || params || {};
  const sizeMb = ((evidence.fileSize || 0) / (1024 * 1024)).toFixed(2);
  const durStr = evidence.durationSeconds != null ? `${Number(evidence.durationSeconds).toFixed(2)} seconds` : 'Inspected';

  return new EmbedBuilder()
    .setTitle('✅ Recording Received')
    .setColor(0x2ecc71)
    .setDescription('Your analytics recording passed the technical checks.')
    .addFields(
      { name: '⏱️ Duration', value: durStr, inline: true },
      { name: '📁 Format', value: evidence.filename?.split('.').pop()?.toUpperCase() || 'MP4', inline: true },
      { name: '📦 Size', value: `${sizeMb} MB`, inline: true }
    )
    .setFooter({
      text: 'Click Continue to Review to review payout details before final submission.'
    });
}

/**
 * Build payout review summary embed
 * @param {object} params
 * @param {string} params.amount
 * @param {string} params.currency
 * @param {object} params.profile
 * @param {object} params.evidence
 * @returns {EmbedBuilder}
 */
export function buildPayoutReviewEmbed({ amount, currency = 'USD', profile, evidence }) {
  const rawWallet = profile?.walletAddress || '';
  const masked = rawWallet.length > 10
    ? `${rawWallet.slice(0, 6)}••••••••••${rawWallet.slice(-4)}`
    : rawWallet;
  const durStr = evidence?.durationSeconds != null ? `${Number(evidence.durationSeconds).toFixed(2)} sec` : 'Verified';

  return new EmbedBuilder()
    .setTitle('💸 Payout Review')
    .setColor(BRAND_COLOR)
    .setDescription('Please review your payout details before submitting. Once submitted, your request and evidence will be submitted to staff for review.')
    .addFields(
      { name: '💵 Amount', value: `**$${Number(amount).toFixed(2)} ${currency}**`, inline: true },
      { name: '💳 Destination', value: `${profile?.network || 'Default'} (\`${masked}\`)`, inline: true },
      { name: '📹 Evidence', value: '✅ Attached', inline: true },
      { name: '⏱️ Recording Duration', value: durStr, inline: true }
    )
    .setFooter({
      text: 'Funds will be reserved upon clicking Submit Payout.'
    });
}

/**
 * Build payout submission success embed
 * @param {object} payout
 * @returns {EmbedBuilder}
 */
export function buildPayoutSubmittedEmbed(payout) {
  return new EmbedBuilder()
    .setTitle('✅ Payout Request Submitted Successfully')
    .setColor(0x2ecc71)
    .setDescription(
      `Your payout request \`${payout.id}\` for **$${Number(payout.amount).toFixed(2)} ${payout.currency}** has been submitted with analytics screen recording evidence and is now under review by staff.`
    )
    .addFields(
      { name: 'Status', value: '⏳ **REQUESTED / UNDER REVIEW**', inline: true },
      { name: 'Reservation', value: `🔒 **$${Number(payout.amount).toFixed(2)}** Reserved`, inline: true }
    )
    .setTimestamp();
}
