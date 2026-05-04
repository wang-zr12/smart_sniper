import { randomUUID } from 'node:crypto';

export const LOCAL_TENANT_ID = 'local-user';

export const ErrorCodes = Object.freeze([
  'acquire_failed',
  'acquire_expired',
  'stock_sold_out',
  'price_guard_violated',
  'variant_unavailable',
  'payment_failed',
  'payment_timeout',
  'payment_declined',
  'payment_otp_timeout',
  'auction_ended',
  'bid_amount_too_low',
  'bid_amount_exceeds_budget',
  'network_error',
  'rate_limited',
  'session_expired',
  'time_drift_excessive',
  'flow_outdated',
  'flow_version_unsupported',
  'flow_validation_failed',
  'flow_step_timeout',
  'adapter_not_found',
  'captcha_encountered',
  'fingerprint_inconsistent',
  'vault_unavailable',
  'credential_not_found',
  'credential_invalid',
  'no_acquire_slot',
  'payment_channel_full',
  'payment_channel_frozen',
  'user_cancelled',
  'user_confirmation_timeout',
  'task_already_terminal',
  'budget_exceeded',
  'payment_overdue',
  'notification_dispatch_failed',
  // v0.5+ error-handling refinements
  'auth_required',                    // 1.1 — token expired / re-login needed
  'account_blocked',                  // 2.3 — banned / suspended / KYC failed (terminal)
  'payment_3ds_required',             // 3.1 — issuer challenge: SMS / push / app confirm
  'insufficient_funds',               // 3.4 — card declined for funds (manual)
  'payment_declined_hard',            // 3.4 — bank declined (lost/stolen/expired)
  'payment_refunded_by_vendor',       // 3.3 — order auto-cancelled / oversold (manual)
  'stock_phantom_read',               // 4.1 — pre-pay recheck failed: variant gone
  'internal_error'
]);

export const ERROR_META = Object.freeze({
  acquire_failed:               { recovery: 'retry',    severity: 'warn',  userMessage: '锁单失败，请稍后重试' },
  acquire_expired:              { recovery: 'terminal', severity: 'warn',  userMessage: '订单超时被释放，请重新触发' },
  stock_sold_out:               { recovery: 'terminal', severity: 'info',  userMessage: '商品已售罄' },
  price_guard_violated:         { recovery: 'terminal', severity: 'info',  userMessage: '当前价格超出您设置的上限' },
  variant_unavailable:          { recovery: 'terminal', severity: 'info',  userMessage: '指定规格暂不可用' },
  payment_failed:               { recovery: 'retry',    severity: 'error', userMessage: '支付失败，请稍后重试' },
  payment_timeout:              { recovery: 'terminal', severity: 'error', userMessage: '支付超时，订单已重置' },
  payment_declined:             { recovery: 'manual',   severity: 'error', userMessage: '支付被拒绝，请检查支付方式' },
  payment_declined_hard:        { recovery: 'manual',   severity: 'error', userMessage: '银行拒绝该卡，请更换支付方式' },
  insufficient_funds:           { recovery: 'manual',   severity: 'error', userMessage: '卡内余额不足，请换卡或充值' },
  payment_otp_timeout:          { recovery: 'manual',   severity: 'warn',  userMessage: '验证码超时，请重试支付' },
  payment_3ds_required:         { recovery: 'manual',   severity: 'error', userMessage: '银行要求二次验证，请前往手机银行或短信确认' },
  payment_refunded_by_vendor:   { recovery: 'manual',   severity: 'error', userMessage: '商家退款 — 抢购失败但款项被占用，资金会原路退回' },
  auction_ended:                { recovery: 'terminal', severity: 'info',  userMessage: '拍卖已结束' },
  bid_amount_too_low:           { recovery: 'retry',    severity: 'warn',  userMessage: '出价低于最低加价，已自动调整' },
  bid_amount_exceeds_budget:    { recovery: 'terminal', severity: 'warn',  userMessage: '出价超出您设置的预算' },
  network_error:                { recovery: 'retry',    severity: 'warn',  userMessage: '网络错误，重试中' },
  rate_limited:                 { recovery: 'retry',    severity: 'warn',  userMessage: '请求过频，已暂停' },
  session_expired:              { recovery: 'retry',    severity: 'warn',  userMessage: '登录会话已过期' },
  auth_required:                { recovery: 'manual',   severity: 'error', userMessage: '登录已失效，请重新登录账号' },
  account_blocked:              { recovery: 'terminal', severity: 'error', userMessage: '账号被站方限制，已停止该任务' },
  time_drift_excessive:         { recovery: 'manual',   severity: 'error', userMessage: '本地时间与服务器偏差过大，请同步系统时间' },
  flow_outdated:                { recovery: 'manual',   severity: 'error', userMessage: '页面流程已变更，请更新流程脚本' },
  flow_version_unsupported:     { recovery: 'manual',   severity: 'error', userMessage: '流程脚本版本不兼容' },
  flow_validation_failed:       { recovery: 'manual',   severity: 'error', userMessage: '流程脚本校验未通过' },
  flow_step_timeout:            { recovery: 'retry',    severity: 'warn',  userMessage: '步骤执行超时' },
  adapter_not_found:            { recovery: 'manual',   severity: 'error', userMessage: '该站点暂未支持' },
  captcha_encountered:          { recovery: 'manual',   severity: 'warn',  userMessage: '遇到人机验证，需手动通过' },
  fingerprint_inconsistent:     { recovery: 'retry',    severity: 'warn',  userMessage: '请求指纹不一致，已重试' },
  vault_unavailable:            { recovery: 'retry',    severity: 'error', userMessage: '凭据服务不可用' },
  credential_not_found:         { recovery: 'manual',   severity: 'error', userMessage: '凭据不存在' },
  credential_invalid:           { recovery: 'manual',   severity: 'error', userMessage: '凭据无效，请重新登录' },
  no_acquire_slot:              { recovery: 'retry',    severity: 'warn',  userMessage: '锁单通道繁忙' },
  payment_channel_full:         { recovery: 'retry',    severity: 'warn',  userMessage: '支付队列已满，等待中' },
  payment_channel_frozen:       { recovery: 'retry',    severity: 'info',  userMessage: '支付通道已暂停（人机验证或风控）' },
  user_cancelled:               { recovery: 'terminal', severity: 'info',  userMessage: '已取消' },
  user_confirmation_timeout:    { recovery: 'terminal', severity: 'info',  userMessage: '等待用户确认超时，已回到监控状态' },
  task_already_terminal:        { recovery: 'terminal', severity: 'error', userMessage: '该任务已结束，无法继续操作' },
  budget_exceeded:              { recovery: 'terminal', severity: 'warn',  userMessage: '预算不足' },
  payment_overdue:              { recovery: 'manual',   severity: 'warn',  userMessage: '付款已超过截止时间' },
  stock_phantom_read:           { recovery: 'terminal', severity: 'warn',  userMessage: '下单前复检发现库存/规格已变化，已中断付款' },
  notification_dispatch_failed: { recovery: 'retry',    severity: 'warn',  userMessage: '通知发送失败' },
  internal_error:               { recovery: 'retry',    severity: 'error', userMessage: '内部错误' }
});

export function userMessageFor(code) {
  return ERROR_META[code]?.userMessage ?? code;
}

export const PollingTiers = Object.freeze([
  'cold',
  'warm',
  'hot',
  'strike',
  'post',
  'idle',
  'hint',
  'detected'
]);

export const SniperScopes = Object.freeze(['sniper1', 'sniper2', 'sniper3']);
export const Platforms = Object.freeze(['web', 'mobile-android']);
export const DeploymentForms = Object.freeze(['local', 'saas']);

export function isErrorCode(value) {
  return ErrorCodes.includes(value);
}

export function errorMeta(code) {
  if (!isErrorCode(code)) return ERROR_META.internal_error;
  return ERROR_META[code];
}

export function ok(value) {
  return { ok: true, value };
}

export function fail(error, message, cause) {
  return { ok: false, error: isErrorCode(error) ? error : 'internal_error', message, cause };
}

export function assertMoney(value, name = 'money') {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer number of cents`);
  }
  return value;
}

export function dollarsToCents(value) {
  if (typeof value === 'string') value = Number(value);
  if (!Number.isFinite(value) || value < 0) throw new TypeError('USD value must be non-negative');
  return Math.round(value * 100);
}

export function centsToDollars(cents) {
  assertMoney(cents, 'cents');
  return cents / 100;
}

export function makeId(prefix) {
  return `${prefix}:${randomUUID()}`;
}

export function makeItemId() {
  return makeId('item');
}

export function makeTaskId() {
  return makeId('task');
}

export function makeWatchId() {
  return makeId('watch');
}

export function makeCredentialRef() {
  return makeId('cred');
}

export function makeFlowRef(flowId, version) {
  if (!flowId || !Number.isInteger(version) || version < 1) {
    throw new TypeError('flowRef requires a flow id and positive integer version');
  }
  return `${flowId}@${version}`;
}

export function parseFlowRef(ref) {
  const [flowId, versionText] = String(ref).split('@');
  const version = Number(versionText);
  if (!flowId || !Number.isInteger(version)) throw new TypeError(`Invalid flow ref: ${ref}`);
  return { flowId, version };
}

export function utcDate(input = Date.now()) {
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid date');
  return date;
}

export function nowUtc() {
  return new Date();
}

export function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
