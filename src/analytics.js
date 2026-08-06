const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "::1"];

function isLocalhost() {
  return LOCAL_HOSTNAMES.includes(globalThis.location?.hostname);
}

// Thin wrapper around the GA4 gtag() global (loaded in index.html) so feature usage
// can be reported from anywhere without duplicating the "is gtag loaded" check, and
// so tests/environments without gtag don't need to stub it out.
export function trackEvent(name, params = {}) {
  if (isLocalhost()) return;

  if (typeof globalThis.gtag === "function") {
    globalThis.gtag("event", name, params);
  }
}
