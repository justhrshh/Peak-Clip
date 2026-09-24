import { EmbedBuilder } from 'discord.js';

const BRAND_COLOR = 0x5865F2;
const SUCCESS_COLOR = 0x57F287;
const PENDING_COLOR = 0xFEE75C;

const PLATFORM_EMOJIS = {
  YOUTUBE: '▶️',
  TIKTOK: '🎵',
  INSTAGRAM: '📸',
  FACEBOOK: '📘'
};

const STATUS_BADGES = {
  PENDING_VERIFICATION: '⏳ Pending Verification',
  UNDER_REVIEW: '🔍 Under Review',
  APPROVED: '✅ Approved',
  REJECTED: '❌ Not Approved',
  FLAGGED: '⚠️ Additional Review Required',
  POST_APPROVAL_REVIEW: '🔍 Under Review'
};

const RETENTION_BADGES = {
  NOT_REQUIRED: 'Not Required',
  PENDING_CHECK: '⏳ Pending',
  ACTIVE: '🟢 Active Retention',
  FULFILLED: '✅ Fulfilled',
  VIOLATED: '⚠️ Video Removed Before 30 Days'
};

/**
 * Build submission confirmation embed
 * @param {object} submission
 * @param {object} campaign
 * @returns {EmbedBuilder}
 */
export function buildSubmissionSuccessEmbed(submission, campaign) {
  const emoji = PLATFORM_EMOJIS[submission.platform] || '🎬';
  const shortId = submission.id.slice(0, 8);
  const minDur = campaign.minClipDurationSeconds || 7;
  const maxDur = campaign.maxClipDurationSeconds || 120;
  const retStr = campaign.retentionRequired
    ? `Required (${campaign.retentionDays || 0} days post-approval)`
    : 'Not Required';

  const isApproved = submission.status === 'APPROVED';
  const isReview = submission.status === 'UNDER_REVIEW' || submission.status === 'FLAGGED';

  const title = isApproved
    ? '🎬 Clip Approved & Tracking Active!'
    : (isReview ? '🔍 Submission Received — Under Review' : '🎬 Submission Received!');

  const description = isApproved
    ? 'Your video clip has been verified and **auto-approved**! Automated metric tracking and earnings calculation have started.'
    : (isReview
      ? 'Your video clip has been recorded and placed under staff review. You will be notified once reviewed.'
      : 'Your video clip has been recorded and submitted for automated verification.');

  const color = isApproved ? SUCCESS_COLOR : (isReview ? 0xF39C12 : PENDING_COLOR);

  const footerText = isApproved
    ? 'Tracking metrics continuously. Check your stats anytime with /submissions'
    : 'Verification worker will inspect this clip shortly. Check status anytime with /submissions';

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .addFields(
      { name: '📢 Campaign', value: campaign.name || 'Campaign', inline: true },
      { name: '🏢 Client', value: campaign.clientName || 'Client', inline: true },
      { name: '📱 Platform', value: `${emoji} **${submission.platform}**`, inline: true },
      { name: '🔗 Submitted URL', value: `[View Clip Link](${submission.normalizedUrl})`, inline: false },
      { name: '⏱️ Duration Rules', value: `${minDur}s – ${maxDur}s`, inline: true },
      { name: '🛡️ Retention', value: retStr, inline: true },
      { name: '📊 Status', value: STATUS_BADGES[submission.status] || submission.status, inline: true },
      { name: '🆔 Submission Ref', value: `\`${shortId}\``, inline: true }
    )
    .setFooter({ text: footerText })
    .setTimestamp();
}

/**
 * Build paginated list of user submissions
 * @param {object} result
 * @param {Array<object>} result.items
 * @param {number} result.page
 * @param {number} result.totalPages
 * @param {number} result.total
 * @returns {EmbedBuilder}
 */
export function buildUserSubmissionsEmbed({ items, page, totalPages, total }) {
  const embed = new EmbedBuilder()
    .setTitle('📂 Your Video Submissions')
    .setColor(BRAND_COLOR)
    .setFooter({ text: `Page ${page} of ${totalPages} • Total Submissions: ${total}` })
    .setTimestamp();

  if (items.length === 0) {
    embed.setDescription('You have not submitted any video clips yet.\nUse `/submit` to submit a clip to an active campaign.');
    return embed;
  }

  embed.setDescription(`Showing your submitted clips (${items.length} of ${total}):`);

  items.forEach((sub, index) => {
    const emoji = PLATFORM_EMOJIS[sub.platform] || '🎬';
    const badge = STATUS_BADGES[sub.status] || sub.status;
    const submittedTime = `<t:${Math.floor(new Date(sub.submittedAt).getTime() / 1000)}:R>`;
    const shortId = sub.id.slice(0, 8);

    let detailsStr = `**Status:** ${badge}\n**Submitted:** ${submittedTime}`;

    if (sub.durationSeconds != null) {
      detailsStr += ` • **Duration:** ${sub.durationSeconds}s`;
    }

    if (sub.status === 'REJECTED' && sub.rejectionReason) {
      detailsStr += `\n**Reason:** ${sub.rejectionReason}`;
    }

    if (sub.retentionRequired && sub.retentionStatus !== 'NOT_REQUIRED') {
      const retBadge = RETENTION_BADGES[sub.retentionStatus] || sub.retentionStatus;
      if (sub.retentionStatus === 'ACTIVE' && sub.retentionDeadline) {
        const deadlineUnix = Math.floor(new Date(sub.retentionDeadline).getTime() / 1000);
        detailsStr += `\n**Retention:** ${retBadge} (until <t:${deadlineUnix}:d>)`;
      } else {
        detailsStr += `\n**Retention:** ${retBadge}`;
      }
    }

    detailsStr += `\n**URL:** [${sub.normalizedUrl.slice(0, 45)}...](${sub.normalizedUrl})\n**Ref:** \`${shortId}\``;

    embed.addFields({
      name: `${(page - 1) * 5 + index + 1}. ${sub.campaign?.name || 'Campaign'} • ${emoji} ${sub.platform}`,
      value: detailsStr,
      inline: false
    });
  });

  return embed;
}

