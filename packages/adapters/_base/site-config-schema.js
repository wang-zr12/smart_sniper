const VALID_AUCTION_FAMILIES = ['html-auction', 'api-auction'];
const VALID_CAPTCHA_FLAVORS = ['none', 'cloudflare-turnstile', 'hcaptcha', 'recaptcha-v2', 'recaptcha-v3', 'press-and-hold'];
const VALID_POLL_PROFILES = ['conservative', 'balanced', 'aggressive'];

export function validateAuctionSiteConfig(config) {
  const errors = [];
  if (!config?.siteId) errors.push('siteId required');
  if (!VALID_AUCTION_FAMILIES.includes(config?.family)) {
    errors.push(`family must be one of ${VALID_AUCTION_FAMILIES.join(' | ')}`);
  }
  if (!Array.isArray(config?.identifyHosts) || config.identifyHosts.length === 0) {
    errors.push('identifyHosts must be a non-empty array of host substrings');
  }
  if (!config?.urls?.snapshot) errors.push('urls.snapshot required');
  if (!config?.urls?.bid) errors.push('urls.bid required');
  if (!config?.urls?.payPage) errors.push('urls.payPage required (Sniper1 user-pay link)');
  if (!config?.parsers?.currentPriceCents) errors.push('parsers.currentPriceCents required');
  if (!config?.parsers?.endsAt) errors.push('parsers.endsAt required');
  if (typeof config?.businessRules?.paymentDeadlineDays !== 'number' || !(config.businessRules.paymentDeadlineDays > 0)) {
    errors.push('businessRules.paymentDeadlineDays must be a positive number');
  }
  if (config?.businessRules?.captchaFlavor && !VALID_CAPTCHA_FLAVORS.includes(config.businessRules.captchaFlavor)) {
    errors.push(`unknown captchaFlavor: ${config.businessRules.captchaFlavor}`);
  }
  if (config?.businessRules?.pollProfile && !VALID_POLL_PROFILES.includes(config.businessRules.pollProfile)) {
    errors.push(`unknown pollProfile: ${config.businessRules.pollProfile}`);
  }
  const caps = config?.capabilities;
  if (!caps?.siteId) errors.push('capabilities.siteId required');
  if (caps?.siteId && config?.siteId && caps.siteId !== config.siteId) {
    errors.push(`capabilities.siteId must equal config.siteId (got ${caps.siteId} vs ${config.siteId})`);
  }
  if (!Array.isArray(caps?.supportedFlowVersions)) {
    errors.push('capabilities.supportedFlowVersions must be an array');
  }
  if (caps && !caps.supportsHttpStrategy && !caps.supportsBrowserStrategy && !caps.supportsMobileStrategy) {
    errors.push('capabilities must declare at least one execution strategy');
  }
  if (caps?.supportsMobileStrategy && caps?.mobile?.supportedPaths?.some((path) => String(path).includes('ios'))) {
    errors.push('iOS mobile path is not supported');
  }
  return { ok: errors.length === 0, errors };
}

export function validateOrderingSiteConfig(config) {
  const errors = [];
  if (!config?.siteId) errors.push('siteId required');
  if (!Array.isArray(config?.identifyHosts) || config.identifyHosts.length === 0) {
    errors.push('identifyHosts must be a non-empty array');
  }
  // ordering family-specific fields validated in the per-family base later
  return { ok: errors.length === 0, errors };
}

const VALID_MOBILE_FAMILIES = ['mobile-flow'];

export function validateMobileFlowSiteConfig(config) {
  const errors = [];
  if (!config?.siteId) errors.push('siteId required');
  if (!VALID_MOBILE_FAMILIES.includes(config?.family)) {
    errors.push(`family must be one of ${VALID_MOBILE_FAMILIES.join(' | ')}`);
  }
  if (!Array.isArray(config?.identifyHosts) || config.identifyHosts.length === 0) {
    errors.push('identifyHosts must be a non-empty array of host substrings');
  }
  if (!config?.app?.androidPackage) errors.push('app.androidPackage required');
  const caps = config?.capabilities;
  if (!caps?.siteId || caps.siteId !== config?.siteId) {
    errors.push('capabilities.siteId must equal config.siteId');
  }
  if (!caps?.supportsMobileStrategy) {
    errors.push('mobile-flow site must declare capabilities.supportsMobileStrategy: true');
  }
  if (caps?.mobile?.supportedPaths?.some((p) => String(p).includes('ios'))) {
    errors.push('iOS mobile path is not supported');
  }
  if (typeof caps?.reservationTypicalTtlMs !== 'number' || !(caps.reservationTypicalTtlMs > 0)) {
    errors.push('capabilities.reservationTypicalTtlMs must be a positive number');
  }
  return { ok: errors.length === 0, errors };
}
