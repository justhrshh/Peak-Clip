import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';

/**
 * Build primary action row for User Earnings: [Campaigns] [Refresh]
 * @param {string} userId
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildUserEarningsActionRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`earnings_campaigns:${userId}`)
      .setLabel('Campaigns')
      .setEmoji('🎯')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`earnings_refresh:${userId}:overview`)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build dropdown select menu for choosing a campaign to view earnings
 * @param {string} userId
 * @param {Array<object>} memberships
 * @returns {ActionRowBuilder<StringSelectMenuBuilder>}
 */
export function buildEarningsCampaignSelectRow(userId, memberships) {
  const options = memberships.slice(0, 25).map((m) => {
    const symbol = m.campaign.currency === 'USD' ? '$' : `${m.campaign.currency} `;
    const rate = `${symbol}${Number(m.campaign.payRate).toFixed(2)}/1k views`;
    return new StringSelectMenuOptionBuilder()
      .setLabel(m.campaign.name.slice(0, 100))
      .setDescription(`${m.campaign.clientName} • Rate: ${rate}`.slice(0, 100))
      .setValue(m.campaign.id);
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`earnings_select_campaign:${userId}`)
    .setPlaceholder('Select a campaign to view earnings...')
    .addOptions(options);

  return new ActionRowBuilder().addComponents(select);
}

/**
 * Build navigation buttons when viewing campaign earnings selector: [Back to Overview]
 * @param {string} userId
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildEarningsCampaignBackRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`earnings_overview:${userId}`)
      .setLabel('Back to Overview')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build action buttons for Campaign Earnings: [Overview] [Refresh]
 * @param {string} userId
 * @param {string} campaignId
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildCampaignEarningsActionRow(userId, campaignId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`earnings_overview:${userId}`)
      .setLabel('Overview')
      .setEmoji('📊')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`earnings_refresh:${userId}:campaign:${campaignId}`)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );
}
