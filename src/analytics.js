// Thin wrapper around the GA4 gtag() global (loaded in index.html) so feature usage
// can be reported from anywhere without duplicating the "is gtag loaded" check, and
// so tests/environments without gtag don't need to stub it out.
export function trackEvent(name, params = {}) {
  if (typeof globalThis.gtag === "function") {
    globalThis.gtag("event", name, params);
  }
}
