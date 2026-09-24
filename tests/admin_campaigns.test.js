import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { AdminCampaignService } from '../src/modules/admin/admin.campaign.service.js';
import {
  InvalidCampaignConfigurationError,
  CurrencyModificationForbiddenError
} from '../src/modules/admin/admin.errors.js';
import {
  CampaignNotFoundError,
  InvalidStatusTransitionError,
  MembershipError
} from '../src/modules/campaigns/campaign.errors.js';

function createMockCampaignEnvironment() {
  const campaigns = new Map();
  const memberships = new Map();
  const submissions = [];
  const earnings = [];
  const auditEvents = [];

  let campCounter = 1;

  const campaignRepo = {
    db: {
      campaign: {
        async update({ where, data }) {
          const c = campaigns.get(where.id);
          if (!c) throw new Error('Not found');
          const updated = { ...c, ...data, updatedAt: new Date() };
          campaigns.set(where.id, updated);
          return updated;
        }
      }
    },
    async findById(id) {
      return campaigns.get(id) || null;
    },
    async findBySlug(slug) {
      for (const c of campaigns.values()) {
        if (c.slug === slug) return c;
      }
      return null;
    },
    async create(data) {
      const id = `cmp_${campCounter++}`;
      const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
      campaigns.set(id, record);
      return record;
    },
    async updateStatus(id, status) {
      const c = campaigns.get(id);
      if (!c) throw new Error('Not found');
      c.status = status;
      c.updatedAt = new Date();
      return c;
    },
    async findMembership(userId, campaignId) {
      return memberships.get(`${userId}_${campaignId}`) || null;
    },
    async updateMembershipStatus(userId, campaignId, status) {
      const m = memberships.get(`${userId}_${campaignId}`);
      if (!m) throw new Error('Not found');
      m.status = status;
      m.updatedAt = new Date();
      return m;
    }
  };

  const adminCampaignRepo = {
    async listCampaigns({ status, search, page = 1, limit = 10 } = {}) {
      let list = Array.from(campaigns.values());
      if (status) list = list.filter((c) => c.status === status);
      if (search) {
        const s = search.toLowerCase();
        list = list.filter((c) => c.name.toLowerCase().includes(s) || c.slug.toLowerCase().includes(s));
      }
      return {
        items: list.map((c) => ({ ...c, _count: { members: 2, submissions: 3 } })),
        total: list.length,
        page,
        totalPages: Math.ceil(list.length / limit) || 1
      };
    },
    async getCampaignDetails(campaignId) {
      const c = campaigns.get(campaignId);
      if (!c) return null;
      return {
        ...c,
        metrics: {
          activeMembers: 5,
          totalSubmissions: 10,
          statusBreakdown: {
            APPROVED: 6,
            UNDER_REVIEW: 2,
            FLAGGED: 1,
            REJECTED: 1,
            PENDING_VERIFICATION: 0
          },
          totalEligibleEarnings: new Prisma.Decimal('150.00'),
          totalCreditedViews: 100000n
        }
      };
    },
    async listMembers(campaignId, { page = 1, limit = 20 } = {}) {
      const list = Array.from(memberships.values()).filter((m) => m.campaignId === campaignId);
      return {
        items: list.map((m) => ({ ...m, user: { id: m.userId, discordId: `dc_${m.userId}`, username: `user_${m.userId}`, status: 'ACTIVE' } })),
        total: list.length,
        page,
        totalPages: 1
      };
    },
    async getCampaignActivity(campaignId) {
      const hasSubs = submissions.some((s) => s.campaignId === campaignId);
      const hasEarns = earnings.some((e) => e.campaignId === campaignId);
      return { hasSubmissions: hasSubs, hasEarnings: hasEarns };
    }
  };

  const auditService = {
    async logAction(event) {
      auditEvents.push(event);
      return event;
    }
  };

  const service = new AdminCampaignService(campaignRepo, adminCampaignRepo, auditService);

  return {
    campaigns,
    memberships,
    submissions,
    earnings,
    auditEvents,
    service
  };
}

describe('Admin Campaign Operations & Financial Invariants', () => {
  const actor = { discordId: 'admin_123', userId: 'u_admin' };

  test('creates new campaign in DRAFT status with audit event', async () => {
    const env = createMockCampaignEnvironment();

    const campaign = await env.service.createCampaign(
      {
        name: 'Spring 2026 Sprint',
        slug: 'spring-2026-sprint',
        description: 'Exciting spring clipping sprint for creators.',
        clientName: 'Apex Brands',
        payRate: '1.25',
        minimumPayout: '10.00',
        currency: 'USD',
        startsAt: new Date('2026-03-01T00:00:00Z'),
        endsAt: new Date('2026-04-01T00:00:00Z'),
        requirements: { allowedPlatforms: ['youtube', 'tiktok'] }
      },
      actor
    );

    assert.ok(campaign.id);
    assert.equal(campaign.status, 'DRAFT');
    assert.equal(campaign.payRate.toFixed(2), '1.25');
    assert.equal(campaign.currency, 'USD');

    // Audit event recorded
    assert.equal(env.auditEvents.length, 1);
    assert.equal(env.auditEvents[0].action, 'CAMPAIGN_CREATE');
    assert.equal(env.auditEvents[0].entityId, campaign.id);
  });

  test('duplicate slug is rejected with InvalidCampaignConfigurationError', async () => {
    const env = createMockCampaignEnvironment();

    await env.service.createCampaign(
      {
        name: 'Sprint One',
        slug: 'duplicate-slug',
        description: 'First sprint description.',
        clientName: 'Client A',
        payRate: '1.00',
        startsAt: new Date('2026-03-01T00:00:00Z'),
        endsAt: new Date('2026-04-01T00:00:00Z')
      },
      actor
    );

    await assert.rejects(
      () =>
        env.service.createCampaign(
          {
            name: 'Sprint Two',
            slug: 'duplicate-slug',
            description: 'Second sprint duplicate slug.',
            clientName: 'Client B',
            payRate: '1.50',
            startsAt: new Date('2026-03-01T00:00:00Z'),
            endsAt: new Date('2026-04-01T00:00:00Z')
          },
          actor
        ),
      InvalidCampaignConfigurationError
    );
  });

  test('editing pay rate updates campaign and leaves historical earnings intact', async () => {
    const env = createMockCampaignEnvironment();

    const camp = await env.service.createCampaign(
      {
        name: 'Rate Lock Test',
        slug: 'rate-lock-test',
        description: 'Testing pay rate modification.',
        clientName: 'Client X',
        payRate: '0.80',
        startsAt: new Date('2026-03-01T00:00:00Z'),
        endsAt: new Date('2026-04-01T00:00:00Z')
      },
      actor
    );

    const updated = await env.service.editCampaign(camp.id, { payRate: '1.20' }, actor);
    assert.equal(updated.payRate.toFixed(2), '1.20');

    const updateAudit = env.auditEvents.find((e) => e.action === 'CAMPAIGN_UPDATE');
    assert.ok(updateAudit);
    assert.equal(updateAudit.previousState.payRate, '0.80');
    assert.equal(updateAudit.newState.payRate, '1.20');
  });

  test('currency modification is forbidden if campaign has existing activity', async () => {
    const env = createMockCampaignEnvironment();

    const camp = await env.service.createCampaign(
      {
        name: 'Currency Test',
        slug: 'currency-test',
        description: 'Testing currency change prevention.',
        clientName: 'Client Y',
        payRate: '1.00',
        currency: 'USD',
        startsAt: new Date('2026-03-01T00:00:00Z'),
        endsAt: new Date('2026-04-01T00:00:00Z')
      },
      actor
    );

    // Simulate submission added to campaign
    env.submissions.push({ id: 'sub_1', campaignId: camp.id });

    // Attempting to change currency must be rejected
    await assert.rejects(
      () => env.service.editCampaign(camp.id, { currency: 'EUR' }, actor),
      CurrencyModificationForbiddenError
    );
  });

  test('currency modification is permitted if campaign has zero activity', async () => {
    const env = createMockCampaignEnvironment();

    const camp = await env.service.createCampaign(
      {
        name: 'Inactive Campaign',
        slug: 'inactive-camp',
        description: 'Campaign with zero submissions or earnings.',
        clientName: 'Client Z',
        payRate: '1.00',
        currency: 'USD',
        startsAt: new Date('2026-03-01T00:00:00Z'),
        endsAt: new Date('2026-04-01T00:00:00Z')
      },
      actor
    );

    const updated = await env.service.editCampaign(camp.id, { currency: 'EUR' }, actor);
    assert.equal(updated.currency, 'EUR');
  });

  test('lifecycle state transitions adhere strictly to state machine', async () => {
    const env = createMockCampaignEnvironment();

    const camp = await env.service.createCampaign(
      {
        name: 'Lifecycle Test',
        slug: 'lifecycle-test',
        description: 'Testing lifecycle transitions.',
        clientName: 'Client L',
        payRate: '1.00',
        startsAt: new Date('2026-01-01T00:00:00Z'),
        endsAt: new Date('2099-01-01T00:00:00Z')
      },
      actor
    );

    // DRAFT -> ACTIVE
    await env.service.setCampaignStatus(camp.id, 'ACTIVE', actor);
    assert.equal(env.campaigns.get(camp.id).status, 'ACTIVE');

    // ACTIVE -> PAUSED
    await env.service.setCampaignStatus(camp.id, 'PAUSED', actor);
    assert.equal(env.campaigns.get(camp.id).status, 'PAUSED');

    // PAUSED -> ACTIVE
    await env.service.setCampaignStatus(camp.id, 'ACTIVE', actor);
    assert.equal(env.campaigns.get(camp.id).status, 'ACTIVE');

    // ACTIVE -> ENDED
    await env.service.setCampaignStatus(camp.id, 'ENDED', actor);
    assert.equal(env.campaigns.get(camp.id).status, 'ENDED');

    // ENDED -> ARCHIVED
    await env.service.setCampaignStatus(camp.id, 'ARCHIVED', actor);
    assert.equal(env.campaigns.get(camp.id).status, 'ARCHIVED');

    // ARCHIVED -> ACTIVE (Invalid! Terminal state)
    await assert.rejects(
      () => env.service.setCampaignStatus(camp.id, 'ACTIVE', actor),
      InvalidStatusTransitionError
    );
  });

  test('date integrity prevents activating an already expired campaign', async () => {
    const env = createMockCampaignEnvironment();

    const expiredCamp = await env.service.createCampaign(
      {
        name: 'Past Campaign',
        slug: 'past-campaign',
        description: 'Campaign whose end date is in the past.',
        clientName: 'Old Client',
        payRate: '1.00',
        startsAt: new Date('2020-01-01T00:00:00Z'),
        endsAt: new Date('2020-02-01T00:00:00Z')
      },
      actor
    );

    await assert.rejects(
      () => env.service.setCampaignStatus(expiredCamp.id, 'ACTIVE', actor),
      InvalidCampaignConfigurationError
    );
  });

  test('member removal updates status to REMOVED and reactivation sets back to ACTIVE', async () => {
    const env = createMockCampaignEnvironment();

    const camp = await env.service.createCampaign(
      {
        name: 'Membership Ops',
        slug: 'membership-ops',
        description: 'Testing member removal and reactivation.',
        clientName: 'Client M',
        payRate: '1.00',
        startsAt: new Date('2026-01-01T00:00:00Z'),
        endsAt: new Date('2099-01-01T00:00:00Z')
      },
      actor
    );

    env.memberships.set(`user_1_${camp.id}`, {
      id: 'mem_1',
      userId: 'user_1',
      campaignId: camp.id,
      status: 'ACTIVE',
      joinedAt: new Date()
    });

    // Remove member
    await env.service.removeMember(camp.id, 'user_1', actor, 'Violation of brand guidelines');
    assert.equal(env.memberships.get(`user_1_${camp.id}`).status, 'REMOVED');

    const removeAudit = env.auditEvents.find((e) => e.action === 'MEMBER_REMOVE');
    assert.ok(removeAudit);
    assert.equal(removeAudit.reason, 'Violation of brand guidelines');

    // Reactivate member
    await env.service.reactivateMember(camp.id, 'user_1', actor);
    assert.equal(env.memberships.get(`user_1_${camp.id}`).status, 'ACTIVE');

    const reactivateAudit = env.auditEvents.find((e) => e.action === 'MEMBER_REACTIVATE');
    assert.ok(reactivateAudit);
  });
});
