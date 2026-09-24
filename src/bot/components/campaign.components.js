import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import { CREATOR_COMPONENTS } from './creatorComponentIds.js';

/**
 * Build dropdown select menu for active campaigns
 * @param {Array<object>} campaigns
 * @returns {ActionRowBuilder<StringSelectMenuBuilder>|null}
 */
export function buildCampaignSelectMenu(campaigns) {
  if (!campaigns || campaigns.length === 0) {
    return null;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('campaign:select')
    .setPlaceholder('Select a campaign to view details & join...')
    .addOptions(
      campaigns.slice(0, 25).map((camp) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(camp.name.slice(0, 100))
          .setDescription(`${camp.clientName} • \$${Number(camp.payRate).toFixed(2)}/1k views`.slice(0, 100))
          .setValue(camp.id)
      )
    );

  return new ActionRowBuilder().addComponents(select);
}

/**
 * Build interactive action buttons for campaign view.
 * Join button is only shown for genuinely joinable campaigns (ACTIVE + budget remaining).
 * Exhausted/closed campaigns show a disabled indicator instead of a misleading Join button.
 *
 * Uses CREATOR_COMPONENTS.CAMP_JOIN / CAMP_LEAVE as the canonical source of truth
 * so the router can resolve them consistently.
 *
 * @param {string} campaignId
 * @param {boolean} isMember - whether the current user is an active member
 * @param {object} [campaign] - full campaign object (used to determine joinability)
 * @param {string} [campaign.status]
 * @param {import('@prisma/client').Prisma.Decimal|number|null} [campaign.remainingBudget]
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildCampaignActionRow(campaignId, isMember, campaign = null) {
  const row = new ActionRowBuilder();

  const isActive = !campaign || campaign.status === 'ACTIVE';
  const hasBudget = !campaign
    || campaign.remainingBudget == null
    || Number(campaign.remainingBudget) > 0;
  const isJoinable = isActive && hasBudget;

  if (isMember) {
    // Creators cannot leave — membership persists until the campaign ends.
    // Show a disabled "Joined" indicator so the UI is informative, not misleading.
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`noop_joined_${campaignId}`)
        .setLabel('✅ Joined')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );
    // Member-only: submit a clip to this campaign
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('pub_dash_submit')
        .setLabel('Submit Clip')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📤')
    );
  } else if (isJoinable) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${CREATOR_COMPONENTS.CAMP_JOIN}:${campaignId}`)
        .setLabel('Join Campaign')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🚀')
    );
  } else {
    // Campaign is not joinable — show a disabled state button
    const closedLabel = campaign?.status === 'PAUSED' ? '⏸️ Campaign Paused' : '🔴 Campaign Closed';
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`noop_closed_${campaignId}`)
        .setLabel(closedLabel)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );
  }

  // Refresh button (all states) — re-fetches the campaign detail
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${CREATOR_COMPONENTS.CAMP_REFRESH}:${campaignId}`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔄')
  );

  row.addComponents(
    new ButtonBuilder()
      .setCustomId('campaign:list')
      .setLabel('All Campaigns')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📋')
  );

  return row;
}
