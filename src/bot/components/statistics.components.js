import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';

/**
 * Build primary action row for User Overview: [Campaigns] [Platforms] [Channels] [My Clips] [Refresh]
 * Discord allows up to 5 buttons per action row.
 * @param {string} userId
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildUserOverviewActionRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`stats_campaigns:${userId}:1`)
      .setLabel('Campaigns')
      .setEmoji('🎯')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`stats_platforms:${userId}`)
      .setLabel('Platforms')
      .setEmoji('📱')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`stats_channels:${userId}`)
      .setLabel('Channels')
      .setEmoji('📺')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`stats_clips:${userId}:all:1`)
      .setLabel('My Clips')
      .setEmoji('🎬')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`stats_refresh:${userId}:overview`)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build pagination action row for campaigns list: [◀ Prev] [Next ▶] [Overview]
 * @param {string} userId
 * @param {number} page
 * @param {number} totalPages
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildCampaignPaginationRow(userId, page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`stats_campaigns:${userId}:${page - 1}`)
      .setLabel('Previous')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`stats_campaigns:${userId}:${page + 1}`)
      .setLabel('Next')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
    new ButtonBuilder()
      .setCustomId(`stats_overview:${userId}`)
      .setLabel('Overview')
      .setEmoji('📊')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build back/refresh row for platforms breakdown view: [Overview] [Refresh]
 * @param {string} userId
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildPlatformBackRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`stats_overview:${userId}`)
      .setLabel('Back to Overview')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`stats_refresh:${userId}:platforms`)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build back/refresh row for channels breakdown view: [Overview] [Refresh]
 * @param {string} userId
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildChannelBackRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`stats_overview:${userId}`)
      .setLabel('Back to Overview')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`stats_refresh:${userId}:channels`)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build dropdown select menu for choosing a campaign to view its statistics
 * @param {string} userId
 * @param {Array<object>} memberships
 * @returns {ActionRowBuilder<StringSelectMenuBuilder>}
 */
export function buildCampaignSelectorRow(userId, memberships) {
  const options = memberships.slice(0, 25).map((m) => {
    const statusTag = m.campaign.status === 'ACTIVE' ? 'Active' : m.campaign.status;
    return new StringSelectMenuOptionBuilder()
      .setLabel(m.campaign.name.slice(0, 100))
      .setDescription(`${m.campaign.clientName} • ${statusTag} • Status: ${m.status}`.slice(0, 100))
      .setValue(m.campaign.id);
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`stats_select_campaign:${userId}`)
    .setPlaceholder('Select a campaign to view statistics...')
    .addOptions(options);

  return new ActionRowBuilder().addComponents(select);
}

/**
 * Build navigation buttons when viewing campaign selector: [Back to Overview]
 * @param {string} userId
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildCampaignSelectBackRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`stats_overview:${userId}`)
      .setLabel('Back to Overview')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build action buttons for Campaign Overview: [My Clips] [Overview] [Refresh]
 * @param {string} userId
 * @param {string} campaignId
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildCampaignOverviewActionRow(userId, campaignId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`stats_clips:${userId}:${campaignId}:1`)
      .setLabel('My Clips')
      .setEmoji('🎬')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`stats_overview:${userId}`)
      .setLabel('Overview')
      .setEmoji('📊')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`stats_refresh:${userId}:campaign:${campaignId}`)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build dropdown to select an individual clip from the current page
 * @param {string} userId
 * @param {Array<object>} submissions
 * @returns {ActionRowBuilder<StringSelectMenuBuilder>}
 */
export function buildClipPickerRow(userId, submissions) {
  const options = submissions.slice(0, 25).map((sub, idx) => {
    const snap = sub.snapshots?.[0];
    const viewsVal = sub.latestViews ?? snap?.views;
    const views = viewsVal !== null && viewsVal !== undefined ? `${Number(viewsVal).toLocaleString()} views` : 'views unavail';
    return new StringSelectMenuOptionBuilder()
      .setLabel(`${idx + 1}. ${sub.platform} (${sub.status})`.slice(0, 100))
      .setDescription(`${views} • ${sub.campaign?.name || 'Campaign'}`.slice(0, 100))
      .setValue(sub.id);
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`stats_select_clip:${userId}`)
    .setPlaceholder('Select a clip to view detailed analytics...')
    .addOptions(options);

  return new ActionRowBuilder().addComponents(select);
}

/**
 * Build pagination action row for clips list: [◀ Prev] [Next ▶] [Overview]
 * @param {string} userId
 * @param {number} page
 * @param {number} totalPages
 * @param {string} campaignId
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildClipPaginationRow(userId, page, totalPages, campaignId = 'all') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`stats_clips:${userId}:${campaignId}:${page - 1}`)
      .setLabel('Previous')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`stats_clips:${userId}:${campaignId}:${page + 1}`)
      .setLabel('Next')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
    new ButtonBuilder()
      .setCustomId(`stats_overview:${userId}`)
      .setLabel('Overview')
      .setEmoji('📊')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build action row for individual clip view: [Back to Clips] [Overview] [Refresh]
 * @param {string} userId
 * @param {string} campaignId
 * @param {string} submissionId
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildClipDetailActionRow(userId, campaignId = 'all', submissionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`stats_clips:${userId}:${campaignId}:1`)
      .setLabel('Back to Clips')
      .setEmoji('🎬')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`stats_overview:${userId}`)
      .setLabel('Overview')
      .setEmoji('📊')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`stats_refresh:${userId}:clip:${submissionId}`)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );
}
