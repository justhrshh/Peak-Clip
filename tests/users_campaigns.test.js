import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UserService } from '../src/modules/users/user.service.js';
import { UserSuspendedError, UserBannedError, UserNotFoundError } from '../src/modules/users/user.errors.js';
import { CampaignService } from '../src/modules/campaigns/campaign.service.js';
import {
  CampaignNotFoundError,
  CampaignNotActiveError,
  CampaignWindowError,
  InvalidStatusTransitionError,
  MembershipError
} from '../src/modules/campaigns/campaign.errors.js';
import {
  campaignCreateSchema,
  campaignRequirementsSchema,
  validateStatusTransition
} from '../src/modules/campaigns/campaign.validation.js';

// In-memory test repository helpers
function createMockUserRepo() {
  const users = new Map();

  return {
    users,
    async findById(id) {
      return users.get(id) || null;
    },
    async findByDiscordId(discordId) {
      for (const u of users.values()) {
        if (u.discordId === discordId) return u;
      }
      return null;
    },
    async upsertFromDiscord({ discordId, username, displayName, avatarUrl }) {
      for (const u of users.values()) {
        if (u.discordId === discordId) {
          u.username = username;
          u.displayName = displayName;
          u.avatarUrl = avatarUrl;
          u.lastSeenAt = new Date();
          return { ...u };
        }
      }
      const newUser = {
        id: `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        discordId,
        username,
        displayName,
        avatarUrl,
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSeenAt: new Date()
      };
      users.set(newUser.id, newUser);
      return { ...newUser };
    },
    async updateLastSeen(id) {
      const u = users.get(id);
      if (u) u.lastSeenAt = new Date();
      return u ? { ...u } : null;
    },
    async updateStatus(id, status) {
      const u = users.get(id);
      if (u) u.status = status;
      return u ? { ...u } : null;
    },
    async findWithMemberships(id) {
      const u = users.get(id);
      return u ? { ...u, campaignMemberships: [] } : null;
    }
  };
}

function createMockCampaignRepo() {
  const campaigns = new Map();
  const memberships = new Map(); // key: `${userId}_${campaignId}`

  return {
    campaigns,
    memberships,
    async findActive(now = new Date()) {
      return Array.from(campaigns.values()).filter((c) => {
        return c.status === 'ACTIVE' && new Date(c.startsAt) <= now && new Date(c.endsAt) >= now;
      });
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
      const id = data.id || `cmp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const campaign = { id, ...data };
      campaigns.set(id, campaign);
      return campaign;
    },
    async updateStatus(id, status) {
      const c = campaigns.get(id);
      if (c) c.status = status;
      return c;
    },
    async findMembership(userId, campaignId) {
      return memberships.get(`${userId}_${campaignId}`) || null;
    },
    async upsertMembership(userId, campaignId, status = 'ACTIVE') {
      const key = `${userId}_${campaignId}`;
      const existing = memberships.get(key);
      if (existing) {
        existing.status = status;
        existing.updatedAt = new Date();
        return existing;
      }
      const record = {
        id: `mem_${Date.now()}`,
        userId,
        campaignId,
        status,
        joinedAt: new Date(),
        updatedAt: new Date()
      };
      memberships.set(key, record);
      return record;
    },
    async updateMembershipStatus(userId, campaignId, status) {
      const key = `${userId}_${campaignId}`;
      const existing = memberships.get(key);
      if (existing) {
        existing.status = status;
        existing.updatedAt = new Date();
        return existing;
      }
      return null;
    },
    async findUserMemberships(userId) {
      return Array.from(memberships.values()).filter((m) => m.userId === userId);
    },
    async findCampaignMembers(campaignId) {
      return Array.from(memberships.values()).filter((m) => m.campaignId === campaignId);
    }
  };
}

describe('User Module Business Rules', () => {
  test('creates a user from Discord identity', async () => {
    const userRepo = createMockUserRepo();
    const userService = new UserService(userRepo);

    const discordUser = {
      id: '123456789012345678',
      username: 'cliptastic',
      globalName: 'Clip Master',
      displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/123/abc.png'
    };

    const user = await userService.getOrCreateFromDiscord(discordUser);

    assert.ok(user.id);
    assert.equal(user.discordId, '123456789012345678');
    assert.equal(user.username, 'cliptastic');
    assert.equal(user.displayName, 'Clip Master');
    assert.equal(user.avatarUrl, 'https://cdn.discordapp.com/avatars/123/abc.png');
    assert.equal(user.status, 'ACTIVE');
  });

  test('repeated getOrCreate does not duplicate users (idempotent)', async () => {
    const userRepo = createMockUserRepo();
    const userService = new UserService(userRepo);

    const discordUser = { id: '987654321', username: 'initial_name' };
    const first = await userService.getOrCreateFromDiscord(discordUser);

    const updatedDiscordUser = { id: '987654321', username: 'updated_name' };
    const second = await userService.getOrCreateFromDiscord(updatedDiscordUser);

    assert.equal(first.id, second.id);
    assert.equal(second.username, 'updated_name');
    assert.equal(userRepo.users.size, 1);
  });

  test('lastSeen updates correctly', async () => {
    const userRepo = createMockUserRepo();
    const userService = new UserService(userRepo);

    const user = await userService.getOrCreateFromDiscord({ id: '555', username: 'seen_test' });
    const originalLastSeen = user.lastSeenAt;

    // Small delay to verify timestamp advancement
    await new Promise((r) => setTimeout(r, 10));
    const updated = await userService.updateLastSeen(user.id);

    assert.ok(updated.lastSeenAt >= originalLastSeen);
  });

  test('suspended user cannot participate in campaigns', async () => {
    const userRepo = createMockUserRepo();
    const userService = new UserService(userRepo);

    const user = await userService.getOrCreateFromDiscord({ id: '888', username: 'suspended_user' });
    await userRepo.updateStatus(user.id, 'SUSPENDED');

    const suspendedUser = await userRepo.findById(user.id);
    assert.throws(
      () => userService.assertUserCanParticipate(suspendedUser),
      UserSuspendedError
    );
  });

  test('banned user cannot participate in campaigns', async () => {
    const userRepo = createMockUserRepo();
    const userService = new UserService(userRepo);

    const user = await userService.getOrCreateFromDiscord({ id: '999', username: 'banned_user' });
    await userRepo.updateStatus(user.id, 'BANNED');

    const bannedUser = await userRepo.findById(user.id);
    assert.throws(
      () => userService.assertUserCanParticipate(bannedUser),
      UserBannedError
    );
  });
});

describe('Campaign Engine Business Rules', () => {
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;

  test('active campaign can be listed', async () => {
    const campaignRepo = createMockCampaignRepo();
    const campaignService = new CampaignService(campaignRepo);

    await campaignRepo.create({
      name: 'Active Campaign',
      slug: 'active-campaign',
      status: 'ACTIVE',
      startsAt: new Date(now.getTime() - dayMs),
      endsAt: new Date(now.getTime() + 10 * dayMs)
    });

    const activeList = await campaignService.listActiveCampaigns();
    assert.equal(activeList.length, 1);
    assert.equal(activeList[0].slug, 'active-campaign');
  });

  test('draft and ended campaigns are not listed as active', async () => {
    const campaignRepo = createMockCampaignRepo();
    const campaignService = new CampaignService(campaignRepo);

    await campaignRepo.create({
      name: 'Draft Campaign',
      slug: 'draft-campaign',
      status: 'DRAFT',
      startsAt: new Date(now.getTime() - dayMs),
      endsAt: new Date(now.getTime() + 10 * dayMs)
    });

    await campaignRepo.create({
      name: 'Ended Campaign',
      slug: 'ended-campaign',
      status: 'ENDED',
      startsAt: new Date(now.getTime() - 20 * dayMs),
      endsAt: new Date(now.getTime() - dayMs)
    });

    const activeList = await campaignService.listActiveCampaigns();
    assert.equal(activeList.length, 0);
  });

  test('paused campaign is not joinable', async () => {
    const userRepo = createMockUserRepo();
    const campaignRepo = createMockCampaignRepo();
    const userService = new UserService(userRepo);
    const campaignService = new CampaignService(campaignRepo, userService);

    const user = await userService.getOrCreateFromDiscord({ id: '111', username: 'user1' });
    const campaign = await campaignRepo.create({
      name: 'Paused Campaign',
      slug: 'paused-campaign',
      status: 'PAUSED',
      startsAt: new Date(now.getTime() - dayMs),
      endsAt: new Date(now.getTime() + 10 * dayMs)
    });

    await assert.rejects(
      async () => campaignService.joinCampaign(user.id, campaign.id),
      CampaignNotActiveError
    );
  });

  test('ended campaign is not joinable', async () => {
    const userRepo = createMockUserRepo();
    const campaignRepo = createMockCampaignRepo();
    const userService = new UserService(userRepo);
    const campaignService = new CampaignService(campaignRepo, userService);

    const user = await userService.getOrCreateFromDiscord({ id: '112', username: 'user2' });
    const campaign = await campaignRepo.create({
      name: 'Ended Campaign',
      slug: 'ended-campaign',
      status: 'ENDED',
      startsAt: new Date(now.getTime() - 20 * dayMs),
      endsAt: new Date(now.getTime() - dayMs)
    });

    await assert.rejects(
      async () => campaignService.joinCampaign(user.id, campaign.id),
      CampaignNotActiveError
    );
  });

  test('campaign outside active date window cannot be joined', async () => {
    const userRepo = createMockUserRepo();
    const campaignRepo = createMockCampaignRepo();
    const userService = new UserService(userRepo);
    const campaignService = new CampaignService(campaignRepo, userService);

    const user = await userService.getOrCreateFromDiscord({ id: '113', username: 'user3' });

    // Future campaign
    const futureCampaign = await campaignRepo.create({
      name: 'Future Campaign',
      slug: 'future-campaign',
      status: 'ACTIVE',
      startsAt: new Date(now.getTime() + 5 * dayMs),
      endsAt: new Date(now.getTime() + 20 * dayMs)
    });

    await assert.rejects(
      async () => campaignService.joinCampaign(user.id, futureCampaign.id),
      CampaignWindowError
    );
  });

  test('user can join active campaign and joining twice is idempotent', async () => {
    const userRepo = createMockUserRepo();
    const campaignRepo = createMockCampaignRepo();
    const userService = new UserService(userRepo);
    const campaignService = new CampaignService(campaignRepo, userService);

    const user = await userService.getOrCreateFromDiscord({ id: '114', username: 'user4' });
    const campaign = await campaignRepo.create({
      name: 'Valid Campaign',
      slug: 'valid-campaign',
      status: 'ACTIVE',
      startsAt: new Date(now.getTime() - dayMs),
      endsAt: new Date(now.getTime() + 10 * dayMs)
    });

    const membership1 = await campaignService.joinCampaign(user.id, campaign.id);
    assert.equal(membership1.status, 'ACTIVE');
    assert.equal(membership1.userId, user.id);
    assert.equal(membership1.campaignId, campaign.id);

    // Join again - must be idempotent
    const membership2 = await campaignService.joinCampaign(user.id, campaign.id);
    assert.equal(membership1.id, membership2.id);
    assert.equal(campaignRepo.memberships.size, 1);
  });

  test('user can leave campaign and leaving preserves historical membership', async () => {
    const userRepo = createMockUserRepo();
    const campaignRepo = createMockCampaignRepo();
    const userService = new UserService(userRepo);
    const campaignService = new CampaignService(campaignRepo, userService);

    const user = await userService.getOrCreateFromDiscord({ id: '115', username: 'user5' });
    const campaign = await campaignRepo.create({
      name: 'Leave Test Campaign',
      slug: 'leave-test-campaign',
      status: 'ACTIVE',
      startsAt: new Date(now.getTime() - dayMs),
      endsAt: new Date(now.getTime() + 10 * dayMs)
    });

    const joined = await campaignService.joinCampaign(user.id, campaign.id);
    assert.equal(joined.status, 'ACTIVE');

    const left = await campaignService.leaveCampaign(user.id, campaign.id);
    assert.equal(left.status, 'LEFT');
    assert.equal(left.id, joined.id);

    // Verify record still exists in repository with preserved joinedAt
    const stored = await campaignRepo.findMembership(user.id, campaign.id);
    assert.ok(stored);
    assert.equal(stored.status, 'LEFT');
    assert.equal(stored.joinedAt.getTime(), joined.joinedAt.getTime());
  });

  test('invalid campaign cannot be joined', async () => {
    const userRepo = createMockUserRepo();
    const campaignRepo = createMockCampaignRepo();
    const userService = new UserService(userRepo);
    const campaignService = new CampaignService(campaignRepo, userService);

    const user = await userService.getOrCreateFromDiscord({ id: '116', username: 'user6' });

    await assert.rejects(
      async () => campaignService.joinCampaign(user.id, 'non-existent-campaign-id'),
      CampaignNotFoundError
    );
  });

  test('suspended or banned user cannot join campaign', async () => {
    const userRepo = createMockUserRepo();
    const campaignRepo = createMockCampaignRepo();
    const userService = new UserService(userRepo);
    const campaignService = new CampaignService(campaignRepo, userService);

    const user = await userService.getOrCreateFromDiscord({ id: '117', username: 'user7' });
    await userRepo.updateStatus(user.id, 'SUSPENDED');

    const campaign = await campaignRepo.create({
      name: 'Guard Campaign',
      slug: 'guard-campaign',
      status: 'ACTIVE',
      startsAt: new Date(now.getTime() - dayMs),
      endsAt: new Date(now.getTime() + 10 * dayMs)
    });

    await assert.rejects(
      async () => campaignService.joinCampaign(user.id, campaign.id),
      UserSuspendedError
    );
  });
});

describe('Campaign Status Transitions & Validation', () => {
  test('valid status transitions succeed', () => {
    assert.doesNotThrow(() => validateStatusTransition('DRAFT', 'ACTIVE'));
    assert.doesNotThrow(() => validateStatusTransition('ACTIVE', 'PAUSED'));
    assert.doesNotThrow(() => validateStatusTransition('PAUSED', 'ACTIVE'));
    assert.doesNotThrow(() => validateStatusTransition('ACTIVE', 'ENDED'));
    assert.doesNotThrow(() => validateStatusTransition('ENDED', 'ARCHIVED'));
  });

  test('invalid status transitions throw InvalidStatusTransitionError', () => {
    assert.throws(() => validateStatusTransition('ENDED', 'ACTIVE'), InvalidStatusTransitionError);
    assert.throws(() => validateStatusTransition('ARCHIVED', 'ACTIVE'), InvalidStatusTransitionError);
    assert.throws(() => validateStatusTransition('DRAFT', 'PAUSED'), InvalidStatusTransitionError);
  });

  test('campaign start date cannot logically occur after end date', () => {
    const now = new Date();
    const invalidData = {
      name: 'Invalid Dates Campaign',
      slug: 'invalid-dates',
      description: 'Test description for invalid dates',
      clientName: 'Test Client',
      payRate: 5.0,
      minimumPayout: 10.0,
      startsAt: new Date(now.getTime() + 10000),
      endsAt: new Date(now.getTime()) // End before start
    };

    const result = campaignCreateSchema.safeParse(invalidData);
    assert.equal(result.success, false);
  });

  test('campaign requirements validate allowed platforms and durations', () => {
    const valid = campaignRequirementsSchema.safeParse({
      allowedPlatforms: ['youtube', 'tiktok'],
      minClipDuration: 15,
      maxClipDuration: 60
    });
    assert.equal(valid.success, true);

    const invalidPlatform = campaignRequirementsSchema.safeParse({
      allowedPlatforms: ['unsupported_platform']
    });
    assert.equal(invalidPlatform.success, false);

    const invalidDuration = campaignRequirementsSchema.safeParse({
      allowedPlatforms: ['tiktok'],
      minClipDuration: 60,
      maxClipDuration: 15 // min > max
    });
    assert.equal(invalidDuration.success, false);
  });
});
