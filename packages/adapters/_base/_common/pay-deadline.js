export function computePayDeadline(daysOrSpec, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now());
  if (typeof daysOrSpec === 'number' && Number.isFinite(daysOrSpec)) {
    return new Date(now.getTime() + daysOrSpec * 24 * 60 * 60 * 1000);
  }
  if (daysOrSpec && typeof daysOrSpec === 'object') {
    if (typeof daysOrSpec.days === 'number') return new Date(now.getTime() + daysOrSpec.days * 24 * 60 * 60 * 1000);
    if (typeof daysOrSpec.hours === 'number') return new Date(now.getTime() + daysOrSpec.hours * 60 * 60 * 1000);
  }
  return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
}
