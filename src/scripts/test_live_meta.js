import 'dotenv/config';
import { instagramProvider } from '../providers/instagram/instagram.provider.js';
import { facebookProvider } from '../providers/facebook/facebook.provider.js';

console.log('--- Testing Live Meta Credentials ---');
console.log('META_ACCESS_TOKEN configured:', Boolean(process.env.META_ACCESS_TOKEN));
console.log('META_INSTAGRAM_ACCOUNT_ID:', process.env.META_INSTAGRAM_ACCOUNT_ID);

async function testLive() {
  try {
    // 1. Test account validation via Graph API
    const testUrl = `https://graph.facebook.com/v19.0/${process.env.META_INSTAGRAM_ACCOUNT_ID}?fields=id,username,name&access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
    const res = await fetch(testUrl);
    const data = await res.json();

    if (!res.ok || data.error) {
      console.error('❌ Meta Graph API Error:', data.error);
      return;
    }

    console.log('✅ Linked Instagram Business Account Verified:');
    console.log(`   ID: ${data.id}`);
    console.log(`   Username: @${data.username || '(not set)'}`);
    console.log(`   Name: ${data.name || '(not set)'}`);

    // 2. Test Business Discovery on a well-known public creator account (e.g., natgeo or instagram)
    console.log('\n--- Testing Business Discovery Lookup (@natgeo) ---');
    const discoveryUrl = `https://graph.facebook.com/v19.0/${process.env.META_INSTAGRAM_ACCOUNT_ID}?fields=business_discovery.username(natgeo){id,username,followers_count,media.limit(2){id,like_count,comments_count,permalink}}&access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
    const discRes = await fetch(discoveryUrl);
    const discData = await discRes.json();

    if (!discRes.ok || discData.error) {
      console.warn('⚠️ Business Discovery Warning/Error:', discData.error);
    } else {
      console.log('✅ Business Discovery API is ACTIVE and WORKING:');
      const target = discData.business_discovery;
      console.log(`   Creator: @${target?.username} (${target?.followers_count?.toLocaleString()} followers)`);
      if (target?.media?.data?.length > 0) {
        const sample = target.media.data[0];
        console.log(`   Sample Post Likes: ${sample.like_count?.toLocaleString()}`);
        console.log(`   Sample Post Comments: ${sample.comments_count?.toLocaleString()}`);
        console.log(`   Sample Permalink: ${sample.permalink}`);

        console.log('\n--- Testing InstagramProvider.getCurrentMetrics() Live ---');
        const providerMetrics = await instagramProvider.getCurrentMetrics(sample.permalink);
        console.log('✅ Provider Result:', {
          status: providerMetrics.status,
          platform: providerMetrics.platform,
          likes: providerMetrics.likes?.toString(),
          comments: providerMetrics.comments?.toString(),
          views: providerMetrics.views,
          availability: providerMetrics.availability,
          metadata: {
            username: providerMetrics.metadata?.username,
            permalink: providerMetrics.metadata?.permalink,
            caption: providerMetrics.metadata?.caption?.slice(0, 50) + '...'
          }
        });
      }
    }
  } catch (err) {
    console.error('💥 Live validation exception:', err);
  }
}

testLive();
