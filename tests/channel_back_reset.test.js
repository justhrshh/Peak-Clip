import test from 'node:test';
import assert from 'node:assert/strict';
import { STAFF_COMPONENTS, staffIds } from '../src/bot/components/staffComponentIds.js';
import {
  buildStaffReviewQueueHubRow,
  buildStaffCreatorDetailRow,
  buildStaffCreatorSubsNavRow,
  buildStaffSubmissionDetailRow
} from '../src/bot/components/staff.components.js';
import { buildStaffCreatorSubsListEmbed } from '../src/bot/embeds/staff.embeds.js';
import { serverProvisioner } from '../src/bot/provisioning/server.provisioner.js';
import { execute as executeAdminCommand } from '../src/bot/commands/admin.js';

test('Channel Back / Reset Suite: Component Navigation Invariants', async (t) => {
  await t.test('buildStaffReviewQueueHubRow includes "Back to Creators" when in creators channel', () => {
    const rowInReviewQueue = buildStaffReviewQueueHubRow('review-queue');
    const compIdsInReviewQueue = rowInReviewQueue.components.map((c) => c.data?.custom_id || c.customId);
    assert.ok(compIdsInReviewQueue.includes(STAFF_COMPONENTS.RQ_REFRESH));
    assert.ok(!compIdsInReviewQueue.includes(STAFF_COMPONENTS.CR_HUB));

    const rowInCreators = buildStaffReviewQueueHubRow('creators');
    const compIdsInCreators = rowInCreators.components.map((c) => c.data?.custom_id || c.customId);
    assert.ok(compIdsInCreators.includes(STAFF_COMPONENTS.RQ_REFRESH));
    assert.ok(compIdsInCreators.includes(STAFF_COMPONENTS.CR_HUB), 'Must have Back to Creators button');
    const backBtn = rowInCreators.components.find((c) => (c.data?.custom_id || c.customId) === STAFF_COMPONENTS.CR_HUB);
    assert.equal(backBtn.data?.label, '◀ Back to Creators');
  });

  await t.test('buildStaffCreatorSubsNavRow contains Back to Creator and Creator Hub buttons', () => {
    const userId = 'user_123';
    const mockItems = [
      { id: 'sub_1', platform: 'INSTAGRAM', url: 'https://instagram.com/reel/abc', durationSeconds: 30, status: 'APPROVED' },
      { id: 'sub_2', platform: 'TIKTOK', url: 'https://tiktok.com/@u/video/123', durationSeconds: 45, status: 'UNDER_REVIEW' }
    ];

    const rows = buildStaffCreatorSubsNavRow(userId, 1, 1, mockItems);
    assert.equal(rows.length, 2);

    // Row 1: Item inspector buttons
    const inspectIds = rows[0].components.map((c) => c.data?.custom_id || c.customId);
    assert.ok(inspectIds.some((id) => id.includes('admin_sub_view:sub_1:cr:user_123')));
    assert.ok(inspectIds.some((id) => id.includes('admin_sub_view:sub_2:cr:user_123')));

    // Row 2: Navigation buttons
    const navIds = rows[1].components.map((c) => c.data?.custom_id || c.customId);
    assert.ok(navIds.includes(staffIds.crView(userId)), 'Must have Back to Creator button');
    assert.ok(navIds.includes(staffIds.crHub()), 'Must have Creator Hub button');
  });

  await t.test('buildStaffCreatorDetailRow contains Creator Hub button', () => {
    const userId = 'user_456';
    const [row1, row2] = buildStaffCreatorDetailRow(userId, 'ACTIVE');
    const allIds = [...row1.components, ...row2.components].map((c) => c.data?.custom_id || c.customId);
    assert.ok(allIds.includes(staffIds.crHub()), 'Creator detail view must have Creator Hub button');
  });

  await t.test('buildStaffSubmissionDetailRow with fromCreatorId provides return to creator subs and hub', () => {
    const sub = {
      id: 'sub_999',
      status: 'UNDER_REVIEW',
      url: 'https://instagram.com/reel/xyz',
      platform: 'INSTAGRAM'
    };

    const rows = buildStaffSubmissionDetailRow(sub, 'UNDER_REVIEW', 'https://instagram.com/reel/xyz', 'INSTAGRAM', 'user_789');
    const actionRow = rows[1];
    const compIds = actionRow.components.map((c) => c.data?.custom_id || c.customId);

    assert.ok(compIds.includes(staffIds.crSubs('user_789', 1)), 'Must link back to creator submissions');
    assert.ok(compIds.includes(staffIds.crHub()), 'Must link back to creator hub');
  });

  await t.test('buildStaffCreatorSubsListEmbed formats list correctly', () => {
    const user = { displayName: 'TopClipper', username: 'topclipper' };
    const mockItems = [
      { id: 'sub_1', platform: 'INSTAGRAM', url: 'https://instagram.com/p/1', durationSeconds: 30, status: 'APPROVED', campaign: { name: 'Spring Launch' } }
    ];
    const embed = buildStaffCreatorSubsListEmbed(user, mockItems, 1, 1);
    assert.ok(embed.data.title.includes('TopClipper'));
    assert.ok(embed.data.description.includes('Spring Launch'));
    assert.ok(embed.data.description.includes('sub_1'));
  });
});

test('Channel Back / Reset Suite: serverProvisioner.reconcileSingleChannel', async (t) => {
  await t.test('reconciles #creators channel message', async () => {
    let sentPayload = null;
    let editedPayload = null;

    const mockChannel = {
      id: 'ch_creators_1',
      name: 'creators',
      guild: {
        id: 'guild_1',
        client: { user: { id: 'bot_1' } }
      },
      send: async (payload) => {
        sentPayload = payload;
        return { id: 'msg_new_1', ...payload };
      },
      messages: {
        fetch: async () => [
          {
            id: 'msg_existing_1',
            author: { id: 'bot_1' },
            embeds: [{ title: 'STAFF MODERATION HUB — REVIEW QUEUE' }],
            edit: async (payload) => {
              editedPayload = payload;
              return true;
            }
          }
        ]
      }
    };

    const res = await serverProvisioner.reconcileSingleChannel(mockChannel);
    assert.ok(res !== null, 'Reconciliation should succeed');
    assert.ok(editedPayload !== null, 'Should have edited the existing message');
    assert.ok(editedPayload.embeds[0].data.title.includes('CREATOR MANAGEMENT'), 'Should restore Creator Management title');
  });

  await t.test('reconciles #review-queue channel message', async () => {
    let editedPayload = null;
    const mockChannel = {
      id: 'ch_rq_1',
      name: 'review-queue',
      guild: {
        id: 'guild_1',
        client: { user: { id: 'bot_1' } }
      },
      send: async (payload) => ({ id: 'msg_new_2', ...payload }),
      messages: {
        fetch: async () => [
          {
            id: 'msg_existing_2',
            author: { id: 'bot_1' },
            embeds: [{ title: 'STAFF MODERATION HUB — REVIEW QUEUE' }],
            edit: async (payload) => {
              editedPayload = payload;
              return true;
            }
          }
        ]
      }
    };

    const res = await serverProvisioner.reconcileSingleChannel(mockChannel);
    assert.ok(res !== null);
    assert.ok(editedPayload !== null);
    assert.ok(editedPayload.embeds[0].data.title.includes('REVIEW QUEUE'));
  });

  await t.test('returns null for unknown channel', async () => {
    const mockChannel = {
      id: 'ch_random',
      name: 'random-chat',
      guild: { id: 'guild_1', client: { user: { id: 'bot_1' } } },
      messages: { fetch: async () => [] }
    };

    const res = await serverProvisioner.reconcileSingleChannel(mockChannel);
    assert.equal(res, null);
  });
});

test('Channel Back / Reset Suite: /admin reset-channel command execution', async (t) => {
  await t.test('executes /admin reset-channel and resets #creators', async () => {
    let replyPayload = null;
    let deferred = false;
    let editedMsg = null;

    const mockInteraction = {
      id: 'int_123',
      user: { id: 'admin_user_1' },
      channel: {
        id: 'ch_creators_1',
        name: 'creators',
        guild: { id: 'guild_1', client: { user: { id: 'bot_1' } } },
        send: async (payload) => ({ id: 'msg_new_1', ...payload }),
        messages: {
          fetch: async () => [
            {
              id: 'msg_existing_1',
              author: { id: 'bot_1' },
              embeds: [{ title: 'STAFF MODERATION HUB — REVIEW QUEUE' }],
              edit: async (payload) => {
                editedMsg = payload;
                return true;
              }
            }
          ]
        }
      },
      guild: {
        id: 'guild_1',
        members: {
          me: { id: 'bot_1', permissions: { has: () => true } }
        }
      },
      member: {
        permissions: { has: () => true },
        roles: { cache: new Map() }
      },
      options: {
        getSubcommandGroup: () => null,
        getSubcommand: () => 'reset-channel'
      },
      deferReply: async (opts) => {
        deferred = true;
      },
      editReply: async (payload) => {
        replyPayload = payload;
      }
    };

    await executeAdminCommand(mockInteraction);

    assert.ok(deferred, 'Should defer reply');
    assert.ok(editedMsg !== null, 'Should have edited channel message');
    assert.ok(editedMsg.embeds[0].data.title.includes('CREATOR MANAGEMENT'));
    assert.ok(replyPayload.content.includes('Successfully reset **#creators**'));
  });
});
