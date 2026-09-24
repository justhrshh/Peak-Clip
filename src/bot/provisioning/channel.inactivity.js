import { logger } from '../../utils/logger.js';
import { serverProvisioner } from './server.provisioner.js';

export const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class ChannelInactivityManager {
  constructor(timeoutMs = INACTIVITY_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
    this.timers = new Map(); // channelId -> Timeout
  }

  /**
   * Record activity on a managed channel and restart its 5-minute inactivity timer.
   * @param {import('discord.js').GuildTextBasedChannel} channel
   */
  touch(channel) {
    if (!channel || !channel.id || !channel.guild || typeof channel.send !== 'function') return;

    // Only track bot-managed channels
    const channelName = channel.name?.toLowerCase();
    const managedNames = [
      'dashboard', 'campaigns', 'submissions', 'stats', 'earnings', 'payouts',
      'review-queue', 'creators', 'campaign-management', 'payout-queue', 'audit-log',
      'bot-status', 'bot-errors'
    ];
    if (!managedNames.includes(channelName)) return;

    const channelId = channel.id;

    // Clear existing timer if any
    if (this.timers.has(channelId)) {
      clearTimeout(this.timers.get(channelId));
    }

    const timer = setTimeout(async () => {
      this.timers.delete(channelId);
      await this.resetChannelToFresh(channel);
    }, this.timeoutMs);

    timer.unref?.();
    this.timers.set(channelId, timer);
  }

  /**
   * Reset channel back to fresh default message and remove stray messages.
   * @param {import('discord.js').GuildTextBasedChannel} channel
   */
  async resetChannelToFresh(channel) {
    try {
      logger.info(
        { channelId: channel.id, channelName: channel.name },
        'Channel reached 5-minute inactivity timeout; resetting to fresh default channel state'
      );

      // 1. Reconcile canonical channel message
      const botMember = channel.guild?.members?.me || null;
      await serverProvisioner.reconcileSingleChannel(channel, botMember);

      // 2. Clean up any stray messages in the channel to leave it 100% fresh
      if (channel.messages && typeof channel.messages.fetch === 'function') {
        const fetched = await channel.messages.fetch({ limit: 50 }).catch(() => null);
        if (fetched) {
          const messages = Array.from(fetched.values());
          const botId = channel.guild?.client?.user?.id;
          let keptCanonical = false;

          for (const msg of messages) {
            // Keep the single canonical bot message (the most recent one with embeds/components)
            if (msg.author?.id === botId && msg.embeds?.length > 0 && !keptCanonical) {
              keptCanonical = true;
              continue;
            }

            // Delete user messages or duplicate bot messages
            try {
              await msg.delete();
            } catch {
              // Ignore already deleted or permission errors
            }
          }
        }
      }

      logger.info(
        { channelId: channel.id, channelName: channel.name },
        'Channel successfully auto-reset to fresh default hub'
      );
    } catch (err) {
      logger.warn(
        { err: err?.message, channelId: channel?.id, channelName: channel?.name },
        'Non-fatal error during channel inactivity reset'
      );
    }
  }

  /**
   * Stop all active timers (e.g. for clean shutdown or tests)
   */
  stopAll() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}

export const channelInactivityManager = new ChannelInactivityManager();
export default channelInactivityManager;
