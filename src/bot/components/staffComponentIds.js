/**
 * Single source of truth for all staff component custom IDs.
 * Used across:
 * - Staff Component Builders
 * - Server Provisioning (Staff & System Canonical Messages)
 * - Interaction Router
 */

export const STAFF_COMPONENTS = {
  // Staff Control Center (#dashboard)
  HOME: 'admin_dash_home',
  BACK: 'admin_dash_back',
  REFRESH: 'admin_dash_refresh',
  REVIEW_QUEUE: 'admin_dash_reviews',
  PAYOUT_QUEUE: 'admin_dash_payouts',
  CAMPAIGNS: 'admin_dash_campaigns',
  CREATORS: 'admin_dash_creators',
  REPORTS: 'admin_dash_reports',
  SUSPICIOUS: 'admin_dash_suspicious',
  TRACKING: 'admin_dash_tracking',
  DELETIONS: 'admin_dash_deletions',
  MONITORING: 'admin_dash_monitoring',

  // Review Queue Workspace (#review-queue)
  RQ_HUB: 'admin_rq_hub',
  RQ_REFRESH: 'admin_rq_refresh',
  RQ_VIEW: 'admin_rq_view',
  SUB_APPROVE: 'admin_sub_approve',
  SUB_KEEP_REVIEW: 'admin_sub_keep_review',
  SUB_REJECT_BTN: 'admin_sub_reject_btn',
  SUB_REJECT_MODAL: 'admin_sub_reject_modal',
  SUB_VIEW: 'admin_sub_view',
  SUB_FLAG: 'admin_sub_flag',
  SUB_REVERIFY: 'admin_sub_reverify',
  SUB_REGISTRY: 'admin_sub_registry',
  SUB_REG_LIST: 'admin_sub_reg_list',
  SUB_FILTER_PLAT: 'admin_sub_filter_plat',
  SUB_FILTER_STATUS: 'admin_sub_filter_status',
  SUB_SEARCH_BTN: 'admin_sub_search_btn',
  SUB_SEARCH_MODAL: 'admin_sub_search_modal',
  SUB_REFRESH_METRICS: 'admin_sub_refresh_metrics',
  SUB_MANUAL_METRICS: 'admin_sub_manual_metrics',
  SUB_MANUAL_MODAL: 'admin_sub_manual_modal',
  SUB_ANALYTICS: 'admin_sub_analytics',
  SUB_AUDIT: 'admin_sub_audit',

  // Creator Management Workspace (#creators)
  CR_HUB: 'admin_cr_hub',
  CR_REFRESH: 'admin_cr_refresh',
  CR_LIST: 'admin_cr_list',
  CR_SEARCH_BTN: 'admin_cr_search_btn',
  CR_SEARCH_MODAL: 'admin_cr_search_modal',
  CR_VIEW: 'admin_cr_view',
  CR_STATUS: 'admin_cr_status',
  CR_SUBS: 'admin_cr_subs',
  CR_EARNINGS: 'admin_cr_earnings',
  CR_PAYOUTS: 'admin_cr_payouts',

  // Campaign Operations Workspace (#campaign-management)
  CMP_HUB: 'admin_cmp_hub',
  CMP_REFRESH: 'admin_cmp_refresh',
  CMP_LIST: 'admin_cmp_list',
  CMP_CREATE_BTN: 'admin_cmp_create_btn',
  CMP_CREATE_MODAL: 'admin_cmp_create_modal',
  CMP_VIEW: 'admin_cmp_view',
  CMP_STATUS: 'admin_cmp_status',
  CMP_REPORT: 'admin_cmp_report',
  CMP_CREATORS: 'admin_cmp_creators',

  // Payout Financial Workspace (#payout-queue)
  PQ_HUB: 'admin_pq_hub',
  PQ_REFRESH: 'admin_pq_refresh',
  PQ_VIEW: 'admin_pq_view',
  PQ_HISTORY: 'admin_pq_history',
  PQ_VIEW_REQ: 'admin_pq_view_req',
  PAYOUT_APPROVE: 'admin_payout_approve',
  PAYOUT_REJECT_BTN: 'admin_payout_reject_btn',
  PAYOUT_REJECT_MODAL: 'admin_payout_reject_modal',
  PAYOUT_PROCESS: 'admin_payout_process',
  EV_REVIEW: 'admin_pq_ev_review',
  EV_ACCEPT: 'admin_pq_ev_accept',
  EV_REJECT_BTN: 'admin_pq_ev_reject_btn',
  EV_REJECT_MODAL: 'admin_pq_ev_reject_modal',

  // Audit Log Workspace (#audit-log)
  AUDIT_HUB: 'admin_audit_hub',
  AUDIT_REFRESH: 'admin_audit_refresh',
  AUDIT_LIST: 'admin_audit_list',

  // System Channels (#bot-status & #bot-errors)
  SYS_STATUS_REFRESH: 'sys_status_refresh',
  SYS_ERRORS_REFRESH: 'sys_errors_refresh',

  // Universal Channel Reset
  CHANNEL_RESET: 'admin_channel_reset'
};

/**
 * Helper functions to construct dynamic staff component IDs.
 */
export const staffIds = {
  // Control Center
  home: () => STAFF_COMPONENTS.HOME,
  refresh: () => STAFF_COMPONENTS.REFRESH,
  reviewQueue: (page = 1) => `${STAFF_COMPONENTS.REVIEW_QUEUE}:${page}`,
  payoutQueue: (page = 1) => `${STAFF_COMPONENTS.PAYOUT_QUEUE}:${page}`,
  campaigns: (page = 1) => `${STAFF_COMPONENTS.CAMPAIGNS}:${page}`,
  creators: (page = 1) => `${STAFF_COMPONENTS.CREATORS}:${page}`,
  reports: () => STAFF_COMPONENTS.REPORTS,
  suspicious: (page = 1) => `${STAFF_COMPONENTS.SUSPICIOUS}:${page}`,
  tracking: (page = 1) => `${STAFF_COMPONENTS.TRACKING}:${page}`,
  deletions: (page = 1) => `${STAFF_COMPONENTS.DELETIONS}:${page}`,
  monitoring: (page = 1) => `${STAFF_COMPONENTS.MONITORING}:${page}`,
  back: (backTarget = STAFF_COMPONENTS.HOME) => backTarget,

  // Review Queue
  rqHub: () => STAFF_COMPONENTS.RQ_HUB,
  rqRefresh: () => STAFF_COMPONENTS.RQ_REFRESH,
  rqView: (page = 1) => `${STAFF_COMPONENTS.RQ_VIEW}:${page}`,
  subApprove: (submissionId) => `${STAFF_COMPONENTS.SUB_APPROVE}:${submissionId}`,
  subKeepReview: (submissionId) => `${STAFF_COMPONENTS.SUB_KEEP_REVIEW}:${submissionId}`,
  subRejectBtn: (submissionId) => `${STAFF_COMPONENTS.SUB_REJECT_BTN}:${submissionId}`,
  subRejectModal: (submissionId) => `${STAFF_COMPONENTS.SUB_REJECT_MODAL}:${submissionId}`,
  subView: (submissionId) => `${STAFF_COMPONENTS.SUB_VIEW}:${submissionId}`,
  subFlag: (submissionId) => `${STAFF_COMPONENTS.SUB_FLAG}:${submissionId}`,
  subReverify: (submissionId) => `${STAFF_COMPONENTS.SUB_REVERIFY}:${submissionId}`,
  subRegistry: (page = 1, platform = 'ALL', status = 'ALL') => `${STAFF_COMPONENTS.SUB_REG_LIST}:${page}:${platform}:${status}`,
  subFilterPlat: (page = 1, currentStatus = 'ALL') => `${STAFF_COMPONENTS.SUB_FILTER_PLAT}:${page}:${currentStatus}`,
  subFilterStatus: (page = 1, currentPlatform = 'ALL') => `${STAFF_COMPONENTS.SUB_FILTER_STATUS}:${page}:${currentPlatform}`,
  subSearchBtn: () => STAFF_COMPONENTS.SUB_SEARCH_BTN,
  subSearchModal: () => STAFF_COMPONENTS.SUB_SEARCH_MODAL,
  subRefreshMetrics: (submissionId) => `${STAFF_COMPONENTS.SUB_REFRESH_METRICS}:${submissionId}`,
  subManualMetrics: (submissionId) => `${STAFF_COMPONENTS.SUB_MANUAL_METRICS}:${submissionId}`,
  subManualModal: (submissionId) => `${STAFF_COMPONENTS.SUB_MANUAL_MODAL}:${submissionId}`,
  subAnalytics: (submissionId, page = 1) => `${STAFF_COMPONENTS.SUB_ANALYTICS}:${submissionId}:${page}`,
  subAudit: (submissionId, page = 1) => `${STAFF_COMPONENTS.SUB_AUDIT}:${submissionId}:${page}`,

  // Creators
  crHub: () => STAFF_COMPONENTS.CR_HUB,
  crRefresh: () => STAFF_COMPONENTS.CR_REFRESH,
  crList: (page = 1) => `${STAFF_COMPONENTS.CR_LIST}:${page}`,
  crSearchBtn: () => STAFF_COMPONENTS.CR_SEARCH_BTN,
  crSearchModal: () => STAFF_COMPONENTS.CR_SEARCH_MODAL,
  crView: (userId) => `${STAFF_COMPONENTS.CR_VIEW}:${userId}`,
  crStatus: (userId, status) => `${STAFF_COMPONENTS.CR_STATUS}:${userId}:${status}`,
  crSubs: (userId, page = 1) => `${STAFF_COMPONENTS.CR_SUBS}:${userId}:${page}`,
  crEarnings: (userId) => `${STAFF_COMPONENTS.CR_EARNINGS}:${userId}`,
  crPayouts: (userId, page = 1) => `${STAFF_COMPONENTS.CR_PAYOUTS}:${userId}:${page}`,

  // Campaigns
  cmpHub: () => STAFF_COMPONENTS.CMP_HUB,
  cmpRefresh: () => STAFF_COMPONENTS.CMP_REFRESH,
  cmpList: (page = 1) => `${STAFF_COMPONENTS.CMP_LIST}:${page}`,
  cmpCreateBtn: () => STAFF_COMPONENTS.CMP_CREATE_BTN,
  cmpCreateModal: () => STAFF_COMPONENTS.CMP_CREATE_MODAL,
  cmpView: (campaignId) => `${STAFF_COMPONENTS.CMP_VIEW}:${campaignId}`,
  cmpStatus: (campaignId, status) => `${STAFF_COMPONENTS.CMP_STATUS}:${campaignId}:${status}`,
  cmpReport: (campaignId, subview = 'overview') => `${STAFF_COMPONENTS.CMP_REPORT}:${campaignId}:${subview}`,
  cmpCreators: (campaignId, page = 1) => `${STAFF_COMPONENTS.CMP_CREATORS}:${campaignId}:${page}`,

  // Payouts
  pqHub: () => STAFF_COMPONENTS.PQ_HUB,
  pqRefresh: () => STAFF_COMPONENTS.PQ_REFRESH,
  pqView: (page = 1) => `${STAFF_COMPONENTS.PQ_VIEW}:${page}`,
  pqHistory: (page = 1) => `${STAFF_COMPONENTS.PQ_HISTORY}:${page}`,
  pqViewReq: (payoutId) => `${STAFF_COMPONENTS.PQ_VIEW_REQ}:${payoutId}`,
  payoutApprove: (payoutId) => `${STAFF_COMPONENTS.PAYOUT_APPROVE}:${payoutId}`,
  payoutRejectBtn: (payoutId) => `${STAFF_COMPONENTS.PAYOUT_REJECT_BTN}:${payoutId}`,
  payoutRejectModal: (payoutId) => `${STAFF_COMPONENTS.PAYOUT_REJECT_MODAL}:${payoutId}`,
  payoutProcess: (payoutId) => `${STAFF_COMPONENTS.PAYOUT_PROCESS}:${payoutId}`,
  evReview: (payoutId) => `${STAFF_COMPONENTS.EV_REVIEW}:${payoutId}`,
  evAccept: (evidenceId) => `${STAFF_COMPONENTS.EV_ACCEPT}:${evidenceId}`,
  evRejectBtn: (evidenceId) => `${STAFF_COMPONENTS.EV_REJECT_BTN}:${evidenceId}`,
  evRejectModal: (evidenceId) => `${STAFF_COMPONENTS.EV_REJECT_MODAL}:${evidenceId}`,

  // Audit
  auditHub: () => STAFF_COMPONENTS.AUDIT_HUB,
  auditRefresh: () => STAFF_COMPONENTS.AUDIT_REFRESH,
  auditList: (page = 1) => `${STAFF_COMPONENTS.AUDIT_LIST}:${page}`,

  // System
  sysStatusRefresh: () => STAFF_COMPONENTS.SYS_STATUS_REFRESH,
  sysErrorsRefresh: () => STAFF_COMPONENTS.SYS_ERRORS_REFRESH,

  // Universal Channel Reset
  channelReset: () => STAFF_COMPONENTS.CHANNEL_RESET
};
