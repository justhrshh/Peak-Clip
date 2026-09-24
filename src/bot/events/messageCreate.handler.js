import fs from 'node:fs';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { payoutUploadSessionManager, UPLOAD_SESSION_STATUS } from '../../modules/payouts/payout-upload-session.manager.js';
import { payoutDraftManager } from '../../modules/payouts/payout-draft.manager.js';
import { storageService } from '../../modules/storage/storage.service.js';
import { validateEvidenceFile, isSupportedVideoAttachment } from '../../modules/evidence/evidence.validator.js';
import {
  buildPayoutEvidenceActionRow,
  buildPayoutEvidenceReceivedActionRow
} from '../components/payout.components.js';
import { buildPayoutEvidenceReceivedEmbed } from '../embeds/payout.embeds.js';
import { channelInactivityManager } from '../provisioning/channel.inactivity.js';

const processedMessageTimestamps = new Map();

/**
 * Handle Discord messageCreate events for payout evidence uploads.
 *
 * Trace:
 * Discord messageCreate
 * → identify attachment
 * → identify active payout evidence upload session
 * → validate ownership/channel/session
 * → download/process attachment from Discord CDN
 * → server-side media validation (< 40.0s strict, < 50MB, mp4/webm/mov/mkv)
 * → store in evidence storage abstraction
 * → attach to payout draft session (DO NOT create PayoutRequest yet)
 * → delete raw user message for creator privacy
 * → respond with Recording Received embed and review buttons
 *
 * @param {import('discord.js').Message} message
 * @param {object} [deps] - Overrides for testing
 */
export async function handleMessageCreate(message, deps = {}) {
  // 1. Ignore bot messages
  if (message.author?.bot) return;

  if (message.channel) {
    channelInactivityManager.touch(message.channel);
  }

  // 1b. Deduplication: drop rapid duplicate messageCreate events fired for the same Discord snowflake ID within 5000ms
  const isRealSnowflake = message.id && /^\d{17,20}$/.test(message.id);
  if ((isRealSnowflake || deps.enableDeduplication) && message.id) {
    const lastSeen = processedMessageTimestamps.get(message.id);
    const now = Date.now();
    if (lastSeen && now - lastSeen < 5000) {
      return;
    }
    processedMessageTimestamps.set(message.id, now);
    if (processedMessageTimestamps.size > 2000) {
      for (const [k, v] of processedMessageTimestamps) {
        if (now - v > 60000) processedMessageTimestamps.delete(k);
      }
    }
  }

  const sessionManager = deps.sessionManager || payoutUploadSessionManager;
  const draftManager = deps.draftManager || payoutDraftManager;
  const storage = deps.storageService || storageService;
  const validator = deps.validateEvidenceFile || validateEvidenceFile;

  // 2. Identify active payout evidence upload session
  const session = await sessionManager.getSession(message.author.id);
  if (!session) {
    // Normal message in channel; not an active upload session
    return;
  }

  // 3. Validate channel and guild match
  if (
    (message.guildId && session.guildId && message.guildId !== session.guildId) ||
    (message.channelId && session.channelId && message.channelId !== session.channelId)
  ) {
    // Message sent in a different channel or guild; do not process
    return;
  }

  const correlationId = `ev_msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // 4. Check if upload session has expired (> 2 minutes)
  if (session.isExpired || Date.now() > session.expiresAt || session.status === UPLOAD_SESSION_STATUS.EXPIRED) {
    logger.warn({ correlationId, discordUserId: message.author.id, userId: session.userId }, 'Attachment arrived after upload session expired');

    // Delete raw upload message for privacy
    await message.delete?.().catch(() => {});

    await message.channel?.send({
      content: `❌ <@${message.author.id}> **This recording upload session has expired.**\nPlease start the payout request again.`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`payout_request_btn:${session.userId}`)
            .setLabel('Request Payout')
            .setStyle(ButtonStyle.Primary)
        )
      ]
    });

    await sessionManager.clearSession(message.author.id);
    return;
  }

  // 5. Inspect message.attachments directly using .size and .values() (Section 1 & 3)
  const attachmentMeta = message.attachments?.map
    ? message.attachments.map((a) => ({
        id: a.id,
        name: a.name,
        size: a.size,
        contentType: a.contentType,
        url: a.url,
        proxyURL: a.proxyURL
      }))
    : Array.from(message.attachments?.values() || []).map((a) => ({
        id: a.id,
        name: a.name,
        size: a.size,
        contentType: a.contentType,
        url: a.url,
        proxyURL: a.proxyURL
      }));

  const attachmentCount = message.attachments?.size ?? attachmentMeta.length;
  const firstAttachment = message.attachments?.first
    ? message.attachments.first()
    : Array.from(message.attachments?.values() || [])[0] || null;
  const qualificationResult = firstAttachment ? isSupportedVideoAttachment(firstAttachment) : false;

  // Temporary structured diagnostics (Section 1)
  const diagnosticPayload = {
    timestamp: new Date().toISOString(),
    correlationId,
    messageId: message.id,
    authorId: message.author?.id,
    authorTag: message.author?.tag,
    channelId: message.channelId ?? message.channel?.id,
    guildId: message.guildId ?? message.guild?.id,
    content: message.content,
    attachmentsSize: attachmentCount,
    attachments: attachmentMeta,
    qualificationResult
  };

  logger.info(
    diagnosticPayload,
    '[DIAGNOSTIC] Payout upload handler attachment inspection'
  );

  try {
    fs.appendFileSync('diagnostic.log', JSON.stringify(diagnosticPayload, null, 2) + '\n---\n');
  } catch {}

  // 6. Single attachment rule (Section 4)
  if (attachmentCount === 0) {
    logger.debug({ correlationId, discordUserId: message.author.id }, 'Message received without attachment during upload window');
    await message.delete?.().catch(() => {});

    await message.channel?.send({
      content: `📹 <@${message.author.id}> Please upload your analytics screen recording as a video attachment.`
    });
    return;
  }

  if (attachmentCount > 1) {
    logger.warn({ correlationId, count: attachmentCount, discordUserId: message.author.id }, 'Multiple attachments uploaded in single message');
    await message.delete?.().catch(() => {});

    await message.channel?.send({
      content: `⚠️ <@${message.author.id}> Please upload one analytics recording at a time.`,
      components: [buildPayoutEvidenceActionRow(session.userId)]
    });
    return;
  }

  const attachment = message.attachments?.first
    ? message.attachments.first()
    : Array.from(message.attachments?.values() || [])[0];

  // Preliminary qualification check (Section 2 & 5)
  if (!isSupportedVideoAttachment(attachment)) {
    logger.warn(
      { correlationId, attachmentName: attachment.name, contentType: attachment.contentType, discordUserId: message.author.id },
      'Attachment preliminary qualification failed'
    );
    await message.delete?.().catch(() => {});

    await message.channel?.send({
      content: `<@${message.author.id}>\n\n❌ **Recording Rejected**\n\nReason: Unsupported recording format. Please upload .mp4, .webm, or .mov.`,
      components: [buildPayoutEvidenceActionRow(session.userId)]
    });
    return;
  }

  // 7. Exactly 1 supported attachment: check atomic state transition (WAITING_FOR_UPLOAD -> PROCESSING)
  const transition = await sessionManager.transitionToProcessing(message.author.id, {
    guildId: message.guildId,
    channelId: message.channelId
  });

  if (transition.alreadyReceived) {
    await message.delete?.().catch(() => {});
    await message.channel?.send({
      content: `⚠️ <@${message.author.id}> This payout recording has already been received.`
    });
    return;
  }

  if (transition.concurrent) {
    await message.delete?.().catch(() => {});
    await message.channel?.send({
      content: `⚠️ <@${message.author.id}> A recording upload is already being processed. Please wait.`
    });
    return;
  }

  if (transition.expired) {
    await message.delete?.().catch(() => {});
    await message.channel?.send({
      content: `❌ <@${message.author.id}> This recording upload session has expired. Please start the payout request again.`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`payout_request_btn:${session.userId}`)
            .setLabel('Request Payout')
            .setStyle(ButtonStyle.Primary)
        )
      ]
    });
    return;
  }

  if (!transition.success) {
    return;
  }

  // 8. Delete creator's raw Discord upload message immediately for privacy (Section 9)
  await message.delete?.().catch(() => {});

  // 9. Download attachment immediately from Discord CDN / media proxy (Section 6)
  const downloadUrl = attachment.proxyURL || attachment.url;
  let buffer;
  try {
    let res = await (deps.fetch || fetch)(downloadUrl, {
      headers: {
        'User-Agent': 'DiscordBot (https://discord.js.org, 14.17.3)'
      }
    });

    if (!res.ok && attachment.url && downloadUrl !== attachment.url) {
      res = await (deps.fetch || fetch)(attachment.url, {
        headers: {
          'User-Agent': 'DiscordBot (https://discord.js.org, 14.17.3)'
        }
      });
    }

    if (!res.ok) {
      throw new Error(`Failed to download attachment from Discord CDN: HTTP ${res.status}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  } catch (downloadErr) {
    logger.error({ correlationId, err: downloadErr.message, url: downloadUrl, userId: session.userId }, 'Discord CDN download failure');
    await sessionManager.resetToWaiting(message.author.id);

    await message.channel?.send({
      content: `⚠️ <@${message.author.id}> We couldn't process that recording. Please try uploading it again.`,
      components: [buildPayoutEvidenceActionRow(session.userId)]
    });
    return;
  }

  // 10. Server-side media validation (< 40.0s strict, < 20MB, mp4/webm/mov/mkv) (Section 5 & 7)
  let validation;
  try {
    validation = await validator({
      buffer,
      filename: attachment.name,
      mimeType: attachment.contentType
    });
  } catch (valErr) {
    logger.warn({ correlationId, err: valErr.message, code: valErr.code, userId: session.userId }, 'Evidence validation rejected upload');
    await sessionManager.resetToWaiting(message.author.id);

    let userMsg = '❌ **Recording Rejected**\n\nReason: Recording could not be validated.';
    if (valErr.code === 'DURATION_EXCEEDED' || valErr.message?.includes('under 40 seconds') || valErr.message?.includes('exceeds allowed length')) {
      userMsg = '❌ **Recording Rejected**\n\nReason: Recording must be under 40 seconds.';
    } else if (valErr.message?.includes('Unsupported file format') || valErr.message?.includes('supported')) {
      userMsg = '❌ **Recording Rejected**\n\nReason: Unsupported recording format. Please upload .mp4, .webm, or .mov.';
    } else if (valErr.message?.includes('maximum file size') || valErr.message?.includes('20MB') || valErr.message?.includes('20 MB') || valErr.message?.includes('50MB')) {
      userMsg = '❌ **Recording Rejected**\n\nReason: Recording exceeds the maximum file size limit (20 MB).';
    } else if (valErr.code === 'INVALID_FILE') {
      userMsg = `❌ **Recording Rejected**\n\nReason: ${valErr.message}`;
    }

    await message.channel?.send({
      content: `<@${message.author.id}>\n\n${userMsg}`,
      components: [buildPayoutEvidenceActionRow(session.userId)]
    });
    return;
  }

  // 10. Persist into evidence storage abstraction (Section 6 & 7)
  let saved;
  try {
    saved = await storage.saveFile({
      buffer,
      filename: attachment.name,
      mimeType: attachment.contentType,
      subfolder: 'evidence'
    });
  } catch (storageErr) {
    logger.error({ correlationId, err: storageErr.message, userId: session.userId }, 'Evidence storage failure');
    await sessionManager.resetToWaiting(message.author.id);

    await message.channel?.send({
      content: `⚠️ <@${message.author.id}> We couldn't process that recording. Please try uploading it again.`,
      components: [buildPayoutEvidenceActionRow(session.userId)]
    });
    return;
  }

  // 11. Associate evidence with current payout flow (DO NOT create PayoutRequest yet)
  const evidenceData = {
    buffer,
    storageKey: saved.storageKey,
    filename: saved.filename,
    mimeType: saved.mimeType,
    durationSeconds: validation.durationSeconds,
    fileSize: saved.fileSize,
    format: validation.format || attachment.name?.split('.').pop()?.toUpperCase() || 'MP4'
  };

  await sessionManager.attachEvidence(message.author.id, evidenceData);
  draftManager.attachEvidence(session.userId, evidenceData);

  logger.info({ correlationId, discordUserId: message.author.id, userId: session.userId, duration: validation.durationSeconds }, 'Payout evidence successfully uploaded and verified');

  // 12. Send Recording Received embed with progression buttons (Section 7)
  const receivedEmbed = buildPayoutEvidenceReceivedEmbed(evidenceData);
  const receivedRow = buildPayoutEvidenceReceivedActionRow(session.userId);

  await message.channel?.send({
    content: `<@${message.author.id}>`,
    embeds: [receivedEmbed],
    components: [receivedRow]
  });
}
