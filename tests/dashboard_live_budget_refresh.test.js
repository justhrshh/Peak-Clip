import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CampaignService } from '../src/modules/campaigns/campaign.service.js';
import { buildCreatorDashboardEmbed } from '../src/bot/embeds/dashboard.embeds.js';
import { buildFulfillmentBar } from '../src/bot/embeds/campaign.embeds.js';

describe('User Dashboard Live Campaign Budget Refresh', () => {
  test('buildFulfillmentBar creates correct visual representation', () => {
    const bar0 = buildFulfillmentBar(0);
    assert.match(bar0, /░░░░░░░░░░ 0\.0%/);

    const bar50 = buildFulfillmentBar(50);
    assert.match(bar50, /▓▓▓▓▓░░░░░ 50\.0%/);

    const bar100 = buildFulfillmentBar(100);
    assert.match(bar100, /▓▓▓▓▓▓▓▓▓▓ 100\.0%/);
  });

  test('CampaignService.getCampaignLiveBudget computes live views and percentage accurately', async () => {
    const mockDb = {
      campaign: {
        findUnique: async () => ({
          id: 'camp-test-1',
          name: 'Test Live Campaign',
          slug: 'test-live-campaign',
          status: 'ACTIVE',
          currency: 'USD',
          payRate: '1.20',
          totalBudget: '3000.00',
          consumedBudget: '0.00',
          submissions: [
            {
              id: 'sub-1',
              status: 'APPROVED',
              snapshots: [{ views: 1690n }]
            },
            {
              id: 'sub-2',
              status: 'APPROVED',
              snapshots: [{ views: 1169n }]
            }
          ]
        }),
        update: async () => ({})
      }
    };

    const service = new CampaignService({ db: mockDb });
    const liveBudget = await service.getCampaignLiveBudget('camp-test-1');

    assert.equal(liveBudget.id, 'camp-test-1');
    assert.equal(liveBudget.name, 'Test Live Campaign');
    assert.equal(liveBudget.totalBudget, 3000);
    assert.equal(liveBudget.approvedViews, 2859n);
    // 2859 views * $1.20 / 1000 = $3.4308 -> 3.4308
    assert.equal(Number(liveBudget.consumedBudget).toFixed(2), '3.43');
    // remaining = 3000 - 3.4308 = 2996.5692 -> 2996.57
    assert.equal(Number(liveBudget.remainingBudget).toFixed(2), '2996.57');
    // fulfillmentPercent = (3.4308 / 3000) * 100 = 0.11436% -> 0.11%
    assert.equal(Number(liveBudget.fulfillmentPercent).toFixed(2), '0.11');
  });

  test('buildCreatorDashboardEmbed includes live campaign consumed budget and percentage', () => {
    const dashboardData = {
      availableBalance: '25.00',
      currency: 'USD',
      activeClipsCount: 2,
      approvedClipsCount: 2,
      underReviewClipsCount: 0,
      totalViews: 2859n,
      eligibleViews: 2859n,
      activePayout: null,
      campaigns: [
        {
          id: 'camp-test-1',
          name: 'Test Live Campaign',
          totalBudget: 3000,
          consumedBudget: 3.43,
          remainingBudget: 2996.57,
          fulfillmentPercent: 0.11,
          isMember: true
        }
      ],
      isRefresh: true
    };

    const discordUser = { username: 'clipper_pro' };
    const embed = buildCreatorDashboardEmbed(dashboardData, discordUser);

    const campField = embed.data.fields.find(f => f.name.includes('Campaign Consumed Budget'));
    assert.ok(campField, 'Should have Campaign Consumed Budget field');
    assert.match(campField.value, /Test Live Campaign/);
    assert.match(campField.value, /\$3\.43/);
    assert.match(campField.value, /\$3000\.00/);
    assert.match(campField.value, /0\.11%/);
    assert.match(campField.value, /Remaining: \*\*\$2996\.57\*\*/);

    assert.ok(embed.data.footer.text.includes('Live Refreshed'), 'Footer should indicate live refresh');
  });
});
