import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, MessageFlags, ComponentType } from 'discord.js';
import { STAFF_COMPONENTS, staffIds } from '../src/bot/components/staffComponentIds.js';
import { buildCampaignCreateModal } from '../src/bot/components/staff.modals.js';
import {
  handleStaffCampaignReport,
  handleStaffCampaignCreateModalSubmit
} from '../src/bot/interactions/staff.interactions.js';
import { handleInteraction } from '../src/bot/interactions/router.js';
import { adminCampaignService } from '../src/modules/admin/admin.campaign.service.js';
import { campaignCreateSchema } from '../src/modules/campaigns/campaign.validation.js';
import { prisma } from '../src/database/client.js';

describe('Campaign Report & Creation Enhancements', () => {
  let origGetCampaignDetails;
  let origMemberCount;
  let origSubmissionCount;
  let origSubmissionFindMany;
  let origEarningAggregate;
  let origCreateCampaign;

  beforeEach(() => {
    origGetCampaignDetails = adminCampaignService.getCampaignDetails;
    origCreateCampaign = adminCampaignService.createCampaign;
    origMemberCount = prisma.campaignMember.count;
    origSubmissionCount = prisma.submission.count;
    origSubmissionFindMany = prisma.submission.findMany;
    origEarningAggregate = prisma.earning.aggregate;
  });

  afterEach(() => {
    adminCampaignService.getCampaignDetails = origGetCampaignDetails;
    adminCampaignService.createCampaign = origCreateCampaign;
    prisma.campaignMember.count = origMemberCount;
    prisma.submission.count = origSubmissionCount;
    prisma.submission.findMany = origSubmissionFindMany;
    prisma.earning.aggregate = origEarningAggregate;
  });

  test('1. buildCampaignCreateModal contains strictly type-4 components across all action rows (Discord modal limits)', () => {
    const modal = buildCampaignCreateModal();
    assert.equal(modal.data.custom_id, STAFF_COMPONENTS.CMP_CREATE_MODAL);
    assert.equal(modal.components.length, 5, 'Modal must have exactly 5 action rows (Discord max)');

    // Verify every action row contains only 1 component, and every component is strictly type 4 (TextInput)
    for (let i = 0; i < modal.components.length; i++) {
      const row = modal.components[i];
      assert.equal(row.components.length, 1, `Action row ${i} must contain exactly 1 component`);
      const component = row.components[0];
      assert.equal(
        component.data.type,
        4,
        `Action row ${i} component must be TextInput (type 4, got ${component.data.type})`
      );
      assert.equal(
        component.data.type,
        ComponentType.TextInput,
        `Action row ${i} component must match ComponentType.TextInput`
      );
    }

    const customIds = modal.components.map((row) => row.components[0].data.custom_id);
    assert.ok(customIds.includes('name'), 'Must include name field');
    assert.ok(customIds.includes('client'), 'Must include client field');
    assert.ok(customIds.includes('cpm_budget'), 'Must include cpm_budget field');
    assert.ok(customIds.includes('platforms'), 'Must include platforms field');
    assert.ok(customIds.includes('description'), 'Must include description field');

    const platformComponent = modal.components[3].components[0];
    assert.equal(platformComponent.data.custom_id, 'platforms');
    assert.equal(platformComponent.data.type, 4, 'Platforms field must be TextInput (type 4)');
    assert.ok(platformComponent.data.label.toLowerCase().includes('platform'));
  });

  test('2. handleStaffCampaignCreateModalSubmit parses platforms from text input and handles aliases/delimiters', async () => {
    let capturedCreatePayload = null;
    adminCampaignService.createCampaign = async (payload, actor) => {
      capturedCreatePayload = payload;
      return {
        id: 'camp_test_create_1',
        name: payload.name,
        clientName: payload.clientName
      };
    };

    let replyData = null;
    const mockInteraction = {
      isModalSubmit: () => true,
      customId: STAFF_COMPONENTS.CMP_CREATE_MODAL,
      user: { id: 'staff_admin_1', username: 'Admin' },
      member: { permissions: PermissionsBitField.Flags.Administrator },
      fields: {
        getTextInputValue: (field) => {
          switch (field) {
            case 'name':
              return 'Gaming Clips Blitz';
            case 'client':
              return 'Streamer Co';
            case 'cpm_budget':
              return '1.50 / 4500';
            case 'platforms':
              return 'youtube, tiktok';
            case 'description':
              return 'Produce top 10 moments and funny clips from our stream broadcasts.';
            default:
              return null;
          }
        }
      },
      deferReply: async () => {},
      editReply: async (payload) => {
        replyData = payload;
      }
    };

    await handleStaffCampaignCreateModalSubmit(mockInteraction);

    assert.ok(capturedCreatePayload);
    assert.equal(capturedCreatePayload.name, 'Gaming Clips Blitz');
    assert.equal(capturedCreatePayload.clientName, 'Streamer Co');
    assert.equal(capturedCreatePayload.payRate, 1.5);
    assert.equal(capturedCreatePayload.totalBudget, 4500);
    assert.deepEqual(capturedCreatePayload.requirements.allowedPlatforms, ['youtube', 'tiktok']);
    assert.equal(
      capturedCreatePayload.description,
      'Produce top 10 moments and funny clips from our stream broadcasts.'
    );
    assert.ok(replyData?.content?.includes('Gaming Clips Blitz'));
    assert.ok(replyData?.content?.includes('YOUTUBE, TIKTOK'));
  });

  test('2b. Blank optional dates do not cause "endsAt must be after startsAt" Zod error', () => {
    const baseCampaign = {
      name: 'Autumn Clipping Drive',
      slug: 'autumn-clipping-drive',
      description: 'Official clipping drive for creators to earn payouts.',
      clientName: 'Autumn Studios',
      payRate: 2.0,
      totalBudget: 5000,
      requirements: { allowedPlatforms: ['youtube'] }
    };

    // 1. Both blank strings
    const parsedBothBlank = campaignCreateSchema.parse({
      ...baseCampaign,
      startsAt: '',
      endsAt: ''
    });
    assert.ok(parsedBothBlank.startsAt instanceof Date, 'startsAt must be coerced to Date');
    assert.ok(parsedBothBlank.endsAt instanceof Date, 'endsAt must be coerced to Date');
    assert.ok(parsedBothBlank.endsAt > parsedBothBlank.startsAt, 'endsAt must default to after startsAt');

    // 2. Both null
    const parsedBothNull = campaignCreateSchema.parse({
      ...baseCampaign,
      startsAt: null,
      endsAt: null
    });
    assert.ok(parsedBothNull.startsAt instanceof Date);
    assert.ok(parsedBothNull.endsAt instanceof Date);
    assert.ok(parsedBothNull.endsAt > parsedBothNull.startsAt);

    // 3. Both undefined
    const parsedBothUndefined = campaignCreateSchema.parse({
      ...baseCampaign
    });
    assert.ok(parsedBothUndefined.startsAt instanceof Date);
    assert.ok(parsedBothUndefined.endsAt instanceof Date);
    assert.ok(parsedBothUndefined.endsAt > parsedBothUndefined.startsAt);

    // 4. startsAt specified, endsAt blank
    const specifiedStart = new Date('2026-11-01T00:00:00.000Z');
    const parsedStartOnly = campaignCreateSchema.parse({
      ...baseCampaign,
      startsAt: specifiedStart,
      endsAt: ''
    });
    assert.equal(parsedStartOnly.startsAt.getTime(), specifiedStart.getTime());
    assert.ok(parsedStartOnly.endsAt > parsedStartOnly.startsAt);

    // 5. Inverted dates still correctly rejected
    assert.throws(
      () => {
        campaignCreateSchema.parse({
          ...baseCampaign,
          startsAt: '2026-12-01',
          endsAt: '2026-11-01'
        });
      },
      /Campaign endsAt must be chronologically after startsAt/
    );
  });

  test('3. handleStaffCampaignReport renders live clippers, clips, and live consumed calculation', async () => {
    const mockCampaign = {
      id: 'camp_rep_test',
      name: 'Apex Legends Sprint',
      clientName: 'EA Games',
      slug: 'apex-legends-sprint',
      status: 'ACTIVE',
      payRate: 2.0,
      totalBudget: 5000.0,
      consumedBudget: '0.00',
      creatorEarningCap: 600.0,
      currency: 'USD',
      minClipDurationSeconds: 15,
      maxClipDurationSeconds: 60,
      retentionRequired: false,
      description: 'Create viral Apex gameplay clips.',
      requirements: { allowedPlatforms: ['youtube', 'tiktok', 'instagram'] }
    };

    adminCampaignService.getCampaignDetails = async () => mockCampaign;
    prisma.campaignMember.findMany = async () => [
      {
        id: 'mem_1',
        userId: 'user_1',
        status: 'ACTIVE',
        joinedAt: new Date(),
        user: { id: 'user_1', discordId: '12345678', username: 'apex_pro' }
      }
    ];
    prisma.submission.findMany = async () => [
      {
        id: 'sub_1',
        userId: 'user_1',
        campaignId: 'camp_rep_test',
        platform: 'YOUTUBE',
        status: 'APPROVED',
        url: 'https://youtube.com/shorts/abc',
        snapshots: [{ views: 50000n }],
        user: { username: 'apex_pro' }
      },
      {
        id: 'sub_2',
        userId: 'user_1',
        campaignId: 'camp_rep_test',
        platform: 'TIKTOK',
        status: 'APPROVED',
        url: 'https://tiktok.com/@u/video/123',
        snapshots: [{ views: 25000n }],
        user: { username: 'apex_pro' }
      }
    ]; // 75,000 views total -> at $2.00/1k CPM = $150.00 live consumed!
    prisma.earning.aggregate = async () => ({
      _sum: { grossAmount: 50.0, eligibleViews: 25000n }
    });

    let editPayload = null;
    const mockInteraction = {
      user: { id: 'staff_admin_1', username: 'Admin' },
      member: { permissions: PermissionsBitField.Flags.Administrator },
      deferUpdate: async () => {},
      editReply: async (payload) => {
        editPayload = payload;
      }
    };

    await handleStaffCampaignReport(mockInteraction, 'camp_rep_test');

    assert.ok(editPayload);
    assert.ok(editPayload.embeds?.length > 0);
    const embed = editPayload.embeds[0];

    // Check title & description
    assert.ok(embed.data.title.includes('Live Campaign Report'));
    assert.ok(embed.data.title.includes('Apex Legends Sprint'));
    assert.ok(embed.data.description.includes('EA Games'));
    assert.ok(embed.data.description.includes('YOUTUBE, TIKTOK, INSTAGRAM'));

    // Check clippers field
    const clippersField = embed.data.fields.find((f) => f.name.includes('Clippers Joined'));
    assert.ok(clippersField, 'Must have Clippers Joined field');
    assert.ok(clippersField.value.includes('apex_pro'));
    assert.ok(clippersField.value.includes('75,000'));

    // Check clips list field
    const clipsField = embed.data.fields.find((f) => f.name.includes('Uploaded Clips'));
    assert.ok(clipsField, 'Must have Uploaded Clips field');
    assert.ok(clipsField.value.includes('YOUTUBE'));
    assert.ok(clipsField.value.includes('TIKTOK'));

    // Check live financial calculation ($150.00 from 75k views at $2/1k)
    const finField = embed.data.fields.find((f) => f.name.includes('Financial Progress (Live Calculation)'));
    assert.ok(finField, 'Must have Financial Progress field');
    assert.ok(finField.value.includes('$5000.00')); // total budget
    assert.ok(finField.value.includes('$150.00'), 'Live consumed should be calculated from views');

    // Check direct review buttons
    assert.ok(editPayload.components?.length >= 2);
    const clipRow = editPayload.components[0];
    assert.equal(clipRow.components.length, 2, 'Must have review buttons for the 2 submissions');
    assert.ok(clipRow.components[0].data.custom_id.includes('sub_1'));
    assert.ok(clipRow.components[1].data.custom_id.includes('sub_2'));

    // Check navigation buttons (Back to Campaign & Refresh Report)
    const navRow = editPayload.components[1];
    assert.equal(navRow.components[0].data.label, '◀ Back to Campaign');
    assert.equal(navRow.components[1].data.label, '🔄 Refresh Report');
  });

  test('4. Router properly dispatches admin_cmp_report:<campaignId>:overview', async () => {
    let reportHandledId = null;
    adminCampaignService.getCampaignDetails = async (id) => {
      reportHandledId = id;
      return {
        id,
        name: 'Route Test Campaign',
        clientName: 'Client',
        status: 'ACTIVE',
        payRate: 1.0,
        totalBudget: 1000.0,
        requirements: { allowedPlatforms: ['youtube'] }
      };
    };
    prisma.campaignMember.findMany = async () => [];
    prisma.submission.findMany = async () => [];
    prisma.earning.aggregate = async () => ({ _sum: { grossAmount: 0, eligibleViews: 0n } });

    const interaction = {
      id: 'int_report_test_1',
      guildId: '1551276972703744060',
      user: { id: 'staff_123', username: 'Staff' },
      member: { permissions: PermissionsBitField.Flags.Administrator },
      customId: 'admin_cmp_report:camp_route_test:overview',
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => false,
      deferUpdate: async () => {},
      editReply: async () => {}
    };

    await handleInteraction(interaction);
    assert.equal(reportHandledId, 'camp_route_test', 'Router must route CMP_REPORT to handler with campaignId');
  });
});
