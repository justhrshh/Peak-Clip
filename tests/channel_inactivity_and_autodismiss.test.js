import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelInactivityManager } from '../src/bot/provisioning/channel.inactivity.js';
import { handleCampaignSelectForSubmit, handleModalSubmitClip } from '../src/bot/interactions/submission.interactions.js';

describe('Channel Inactivity Auto-Reset & Submission Auto-Dismiss Suite', () => {
  test('ChannelInactivityManager resets channel to fresh after inactivity timeout', async () => {
    let reconciledChannel = null;
    let deletedMessageIds = [];

    const mockMessages = new Map([
      ['msg_canonical', {
        id: 'msg_canonical',
        author: { id: 'bot_123' },
        embeds: [{ title: 'CAMPAIGNS' }],
        edit: async () => {},
        delete: async () => { deletedMessageIds.push('msg_canonical'); }
      }],
      ['msg_stray_user', {
        id: 'msg_stray_user',
        author: { id: 'user_456' },
        embeds: [],
        delete: async () => { deletedMessageIds.push('msg_stray_user'); }
      }],
      ['msg_old_bot', {
        id: 'msg_old_bot',
        author: { id: 'bot_123' },
        embeds: [{ title: 'OLD ERROR' }],
        delete: async () => { deletedMessageIds.push('msg_old_bot'); }
      }]
    ]);

    const mockChannel = {
      id: 'ch_campaigns',
      name: 'campaigns',
      guild: {
        client: { user: { id: 'bot_123' } },
        members: { me: { id: 'bot_123' } }
      },
      messages: {
        fetch: async () => mockMessages
      },
      send: async () => ({ id: 'new_msg' })
    };

    // Use short 25ms timeout for testing
    const manager = new ChannelInactivityManager(25);
    manager.touch(mockChannel);

    assert.equal(manager.timers.has('ch_campaigns'), true, 'Timer should be active for channel');

    // Wait for timeout to fire
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(manager.timers.has('ch_campaigns'), false, 'Timer should have fired and cleared');
    // Verify stray messages were cleaned up, keeping the canonical message
    assert.ok(deletedMessageIds.includes('msg_stray_user'), 'Stray user message should be deleted');
    assert.ok(deletedMessageIds.includes('msg_old_bot'), 'Old bot message should be deleted');
    assert.ok(!deletedMessageIds.includes('msg_canonical'), 'Canonical bot message should be preserved');
  });

  test('handleCampaignSelectForSubmit deletes picker message upon selection', async () => {
    let pickerDeleted = false;
    let modalShown = false;

    const mockInteraction = {
      values: ['camp_123'],
      message: {
        delete: async () => { pickerDeleted = true; }
      },
      showModal: async () => { modalShown = true; }
    };

    // Mock campaign service
    const origGet = (await import('../src/modules/campaigns/campaign.service.js')).campaignService.getCampaignById;
    (await import('../src/modules/campaigns/campaign.service.js')).campaignService.getCampaignById = async () => ({
      id: 'camp_123',
      name: 'Test Campaign',
      requirements: {}
    });

    try {
      await handleCampaignSelectForSubmit(mockInteraction);
      assert.equal(modalShown, true, 'Modal should be shown');
      assert.equal(pickerDeleted, true, 'Picker message should be deleted on selection');
    } finally {
      (await import('../src/modules/campaigns/campaign.service.js')).campaignService.getCampaignById = origGet;
    }
  });

  test('handleModalSubmitClip sends non-ephemeral reply and schedules auto-deletion', async () => {
    let deferred = false;
    let replyPayload = null;
    let deleteCalled = false;

    const mockInteraction = {
      user: { id: 'usr_discord_1', username: 'clipper_1' },
      fields: {
        getTextInputValue: () => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      },
      deferReply: async (opts) => {
        deferred = true;
        // Verify it is NOT ephemeral so deletion works
        assert.equal(opts, undefined, 'deferReply must be non-ephemeral for Discord deletion support');
      },
      editReply: async (payload) => {
        replyPayload = payload;
      },
      deleteReply: async () => {
        deleteCalled = true;
      }
    };

    // Mock services
    const userService = (await import('../src/modules/users/user.service.js')).userService;
    const submissionService = (await import('../src/modules/submissions/submission.service.js')).submissionService;
    const campaignService = (await import('../src/modules/campaigns/campaign.service.js')).campaignService;

    const origUser = userService.getOrCreateFromDiscord;
    const origSub = submissionService.createSubmission;
    const origCamp = campaignService.getCampaignById;

    userService.getOrCreateFromDiscord = async () => ({ id: 'usr_uuid_1', status: 'ACTIVE' });
    submissionService.createSubmission = async () => ({
      id: 'sub_12345678',
      platform: 'YOUTUBE',
      status: 'APPROVED',
      normalizedUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    campaignService.getCampaignById = async () => ({
      id: 'camp_123',
      name: 'Music Campaign',
      clientName: 'Music Client'
    });

    try {
      await handleModalSubmitClip(mockInteraction, 'camp_123');
      assert.equal(deferred, true);
      assert.ok(replyPayload.content.includes('Video submitted successfully!'));
      assert.ok(replyPayload.content.includes('Auto-dismissing in 10s'));
      assert.ok(replyPayload.embeds.length > 0);
    } finally {
      userService.getOrCreateFromDiscord = origUser;
      submissionService.createSubmission = origSub;
      campaignService.getCampaignById = origCamp;
    }
  });
});
