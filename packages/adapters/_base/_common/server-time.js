/**
 * Compute (serverNow - localNow) in milliseconds. Caller can subtract this from
 * Date.now() to get an estimated server clock. Source dispatch is config-driven.
 */
export async function computeServerTimeOffsetMs(source, ctx = {}, config = {}) {
  if (!source || source === 'response-date-header') {
    const last = ctx.lastResponseDate ?? ctx.executionState?.lastResponse?.headers?.date;
    if (!last) return 0;
    const parsed = new Date(last);
    if (Number.isNaN(parsed.getTime())) return 0;
    return parsed.getTime() - Date.now();
  }
  if (source === 'ntp') {
    return ctx.ntpOffsetMs ?? 0;
  }
  if (source === 'custom-endpoint') {
    if (!config?.urls?.serverTime || !ctx.egress) return 0;
    const response = await ctx.egress.fetch({ method: 'GET', url: config.urls.serverTime });
    const raw = response.headers?.date ?? response.bodyText;
    if (!raw) return 0;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime() - Date.now();
  }
  return 0;
}
