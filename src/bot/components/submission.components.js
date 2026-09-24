import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';

/**
 * Build dropdown select menu for choosing a campaign to submit to
 * @param {Array<object>} joinedMemberships
 * @returns {ActionRowBuilder<StringSelectMenuBuilder>}
 */
export function buildCampaignPickerForSubmit(joinedMemberships) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('submit:campaign:select')
    .setPlaceholder('Choose a campaign for your clip submission...')
    .addOptions(
      joinedMemberships.slice(0, 25).map((m) => {
        const c = m.campaign;
        const platforms = (c.requirements?.allowedPlatforms || ['YouTube']).join('/');
        const duration = `${c.minClipDurationSeconds || 7}s-${c.maxClipDurationSeconds || 120}s`;
        const cpm = `$${Number(c.payRate).toFixed(2)}`;
        const ret = c.retentionRequired ? ` • ${c.retentionDays || 0}d retention` : '';
        const desc = `${c.clientName} • ${cpm} CPM • ${platforms} • ${duration}${ret}`.slice(0, 100);

        return new StringSelectMenuOptionBuilder()
          .setLabel(c.name.slice(0, 100))
          .setDescription(desc)
          .setValue(c.id);
      })
    );

  return new ActionRowBuilder().addComponents(select);
}

/**
 * Build interactive modal for entering the clip URL
 * @param {string} campaignId
 * @param {string} campaignName
 * @param {object} [campaign=null]
 * @returns {ModalBuilder}
 */
export function buildSubmitModal(campaignId, campaignName, campaign = null) {
  const modal = new ModalBuilder()
    .setCustomId(`submit:modal:${campaignId}`)
    .setTitle(`Submit Clip: ${campaignName.slice(0, 30)}`);

  const min = campaign?.minClipDurationSeconds || 7;
  const max = campaign?.maxClipDurationSeconds || 120;
  const platforms = (campaign?.requirements?.allowedPlatforms || ['YouTube', 'TikTok', 'Instagram', 'Facebook']).join(', ');

  const urlInput = new TextInputBuilder()
    .setCustomId('submit:url_input')
    .setLabel(`Video / Clip URL (${min}s–${max}s)`.slice(0, 45))
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(`https://... (${platforms})`.slice(0, 100))
    .setRequired(true)
    .setMinLength(10)
    .setMaxLength(500);

  const row = new ActionRowBuilder().addComponents(urlInput);
  modal.addComponents(row);

  return modal;
}

/**
 * Build pagination action buttons for /submissions view
 * @param {number} page
 * @param {number} totalPages
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildSubmissionsPaginationRow(page, totalPages) {
  const row = new ActionRowBuilder();

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`submission:list:${page - 1}`)
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1)
  );

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`submission:list:${page + 1}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages)
  );

  return row;
}
