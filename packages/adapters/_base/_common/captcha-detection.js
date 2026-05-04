import { detectGenericCaptcha } from './middleware.js';

const FLAVOR_PATTERNS = Object.freeze({
  'cloudflare-turnstile': /cf-chl|cloudflare|turnstile/i,
  'hcaptcha': /hcaptcha/i,
  'recaptcha-v2': /g-recaptcha|grecaptcha/i,
  'recaptcha-v3': /grecaptcha\.execute/i,
  'press-and-hold': /press.*hold|verify.*human/i
});

export function detectCaptcha(response, flavor = 'none') {
  if (!response) return false;
  if (flavor === 'none') return false;
  const generic = detectGenericCaptcha({
    bodyText: response.bodyText ?? '',
    headers: response.headers ?? {}
  });
  const flavorPattern = FLAVOR_PATTERNS[flavor];
  const flavored = flavorPattern ? flavorPattern.test(response.bodyText ?? '') : false;
  return generic || flavored;
}
