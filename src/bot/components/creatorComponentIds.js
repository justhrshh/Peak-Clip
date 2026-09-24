/**
 * Single source of truth for all creator component custom IDs.
 * Used across:
 * - Component Builders
 * - Server Provisioning (Canonical Messages)
 * - Interaction Router
 */

export const CREATOR_COMPONENTS = {
  // Public Persistent Channel Buttons (all reply ephemerally)
  OPEN_DASHBOARD: 'dash_open',
  PUB_CAMPAIGNS: 'pub_dash_campaigns',
  PUB_CAMPAIGNS_REFRESH: 'pub_dash_campaigns_refresh',
  PUB_SUBMIT: 'pub_dash_submit',
  PUB_CLIPS: 'pub_dash_clips',
  PUB_SUBMISSIONS_REFRESH: 'pub_dash_submissions_refresh',
  PUB_STATS: 'pub_dash_stats',
  PUB_STATS_REFRESH: 'pub_dash_stats_refresh',
  PUB_EARNINGS: 'pub_dash_earnings',
  PUB_EARNINGS_REFRESH: 'pub_dash_earnings_refresh',
  PUB_PAYOUT_REQUEST: 'pub_dash_payout_request',
  PUB_PROFILE: 'pub_dash_profile',
  PUB_PAYOUT_HISTORY: 'pub_dash_payout_history',
  PUB_PAYOUTS_REFRESH: 'pub_dash_payouts_refresh',

  // Ephemeral In-Dashboard Navigation & Subviews
  DASH_HOME: 'dash_home',
  DASH_CAMPAIGNS: 'dash_campaigns',
  DASH_MY_CLIPS: 'dash_my_clips',
  DASH_CLIPS: 'dash_clips', // Legacy compatibility
  DASH_STATS: 'dash_stats',
  DASH_EARNINGS: 'dash_earnings',
  DASH_PAYOUT: 'dash_payout',
  DASH_PROFILE: 'dash_profile',
  DASH_REFRESH: 'dash_refresh',
  DASH_BACK: 'dash_back',

  // Subview Actions / Payout Profile
  DASH_PROFILE_SETUP: 'dash_profile_setup',
  DASH_PROFILE_VIEW: 'dash_profile_view',
  DASH_PROFILE_EDIT: 'dash_profile_edit',
  DASH_PAYOUT_REQUEST: 'dash_payout_request',
  DASH_CAMPAIGN_VIEW: 'dash_campaign_view',
  DASH_CLIP_VIEW: 'dash_clip_view',

  // Campaign Join / Refresh (routed through creator dashboard campaign detail)
  CAMP_JOIN: 'camp_join',
  CAMP_REFRESH: 'camp_refresh',

  // Payout Wizard
  PAYOUT_WIZ_STEP: 'payout_wiz_step',
  PAYOUT_WIZ_CONFIRM: 'payout_wiz_confirm',
  PAYOUT_WIZ_AMOUNT_MODAL: 'payout_wiz_amount_modal',
  PAYOUT_CANCEL_BTN: 'payout_cancel_btn',
  PAYOUT_CANCEL_CONFIRM: 'payout_cancel_confirm',
  PAYOUT_CANCEL_KEEP: 'payout_cancel_keep',

  // Phase 10H.8: Payout Evidence Workflow
  PAYOUT_EV_UPLOAD: 'payout_ev_upload',
  PAYOUT_EV_REVIEW: 'payout_ev_review',
  PAYOUT_EV_SUBMIT: 'payout_ev_submit',
  PAYOUT_EV_BACK: 'payout_ev_back',
  PAYOUT_EV_CANCEL: 'payout_ev_cancel',

  // Modals & Select Menus
  MODAL_SUBMIT: 'submit:modal',
  MODAL_PAYOUT: 'payout_modal',
  MODAL_PAYOUT_PROFILE: 'payout_profile_modal',
  SELECT_CAMPAIGN: 'campaign:select',
  SELECT_SUBMIT_CAMPAIGN: 'submit:campaign:select'
};

/**
 * Helper functions to construct dynamic component IDs.
 * Supports both clean non-user format and qualified userId format.
 */
export const creatorIds = {
  open: () => CREATOR_COMPONENTS.OPEN_DASHBOARD,
  home: (userId) => (userId ? `${CREATOR_COMPONENTS.DASH_HOME}:${userId}` : CREATOR_COMPONENTS.DASH_HOME),
  campaigns: (page = 1, userId) => (userId ? `${CREATOR_COMPONENTS.DASH_CAMPAIGNS}:${userId}:${page}` : `${CREATOR_COMPONENTS.DASH_CAMPAIGNS}:${page}`),
  myClips: (page = 1, userId) => (userId ? `${CREATOR_COMPONENTS.DASH_MY_CLIPS}:${userId}:${page}` : `${CREATOR_COMPONENTS.DASH_MY_CLIPS}:${page}`),
  clips: (page = 1, userId) => (userId ? `${CREATOR_COMPONENTS.DASH_CLIPS}:${userId}:${page}` : `${CREATOR_COMPONENTS.DASH_CLIPS}:${page}`),
  stats: (userId) => (userId ? `${CREATOR_COMPONENTS.DASH_STATS}:${userId}` : CREATOR_COMPONENTS.DASH_STATS),
  earnings: (userId) => (userId ? `${CREATOR_COMPONENTS.DASH_EARNINGS}:${userId}` : CREATOR_COMPONENTS.DASH_EARNINGS),
  payout: (userId) => (userId ? `${CREATOR_COMPONENTS.DASH_PAYOUT}:${userId}` : CREATOR_COMPONENTS.DASH_PAYOUT),
  profile: (userId) => (userId ? `${CREATOR_COMPONENTS.DASH_PROFILE}:${userId}` : CREATOR_COMPONENTS.DASH_PROFILE),
  refresh: (userId) => (userId ? `${CREATOR_COMPONENTS.DASH_REFRESH}:${userId}` : CREATOR_COMPONENTS.DASH_REFRESH),
  back: (backTarget = 'dash_home', userId) => (userId ? `${CREATOR_COMPONENTS.DASH_BACK}:${userId}:${backTarget}` : `${CREATOR_COMPONENTS.DASH_BACK}:${backTarget}`),
  campaignDetail: (campaignId, userId) => (userId ? `${CREATOR_COMPONENTS.DASH_CAMPAIGN_VIEW}:${userId}:${campaignId}` : `${CREATOR_COMPONENTS.DASH_CAMPAIGN_VIEW}:${campaignId}`),
  clipDetail: (submissionId, userId) => (userId ? `${CREATOR_COMPONENTS.DASH_CLIP_VIEW}:${userId}:${submissionId}` : `${CREATOR_COMPONENTS.DASH_CLIP_VIEW}:${submissionId}`),
  profileSetup: (userId) => (userId ? `${CREATOR_COMPONENTS.DASH_PROFILE_SETUP}:${userId}` : CREATOR_COMPONENTS.DASH_PROFILE_SETUP),
  profileView: (userId) => (userId ? `${CREATOR_COMPONENTS.DASH_PROFILE_VIEW}:${userId}` : CREATOR_COMPONENTS.DASH_PROFILE_VIEW),
  profileEdit: (userId) => (userId ? `${CREATOR_COMPONENTS.DASH_PROFILE_EDIT}:${userId}` : CREATOR_COMPONENTS.DASH_PROFILE_EDIT),
  payoutRequest: (userId) => (userId ? `${CREATOR_COMPONENTS.DASH_PAYOUT_REQUEST}:${userId}` : CREATOR_COMPONENTS.DASH_PAYOUT_REQUEST),
  campJoin: (campaignId) => `${CREATOR_COMPONENTS.CAMP_JOIN}:${campaignId}`
};
