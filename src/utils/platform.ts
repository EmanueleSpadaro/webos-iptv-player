export function isWebOS(): boolean {
  return typeof navigator !== 'undefined' && /webOS|Web0S/i.test(navigator.userAgent);
}
