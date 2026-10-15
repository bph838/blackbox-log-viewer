// Hand-off of the open log from the main Blackbox Explorer window to the Imagine tab.
//
// Protocol (same origin; every message is checked against our own origin):
//   1. The main window opens /imagine/ in a new tab and keeps the window reference.
//   2. Imagine posts {type: "imagine:ready"} to window.opener.
//   3. The main window answers with {type: "imagine:log", ...} carrying a copy of the raw log
//      bytes, the file name, the selected sub-log, the analyser in/out markers and a snapshot of
//      the craft config. Imagine parses the bytes itself with the shared FlightLog parser.
// Imagine can also be used on its own by opening a log file in it.

export const MSG_READY = "imagine:ready";
export const MSG_LOG = "imagine:log";

export function imagineUrl() {
  const base = import.meta.env?.BASE_URL ?? "/";
  return new URL(`${base}imagine/`, globalThis.location.href).toString();
}

let providerInstalled = false;
let payloadProvider = () => null;

/**
 * Main window side. Opens Imagine and answers its "ready" message with the current log.
 * @param {() => object|null} getPayload returns the payload for the currently open log
 */
export function openImagine(getPayload) {
  payloadProvider = getPayload;
  if (!providerInstalled) {
    providerInstalled = true;
    globalThis.addEventListener("message", (event) => {
      if (event.origin !== globalThis.location.origin) return;
      if (event.data?.type !== MSG_READY || !event.source) return;
      const payload = payloadProvider();
      if (!payload) return;
      // Copy the bytes so the main window keeps its own buffer, then transfer the copy.
      const bytes = payload.bytes.slice().buffer;
      event.source.postMessage({ type: MSG_LOG, ...payload, bytes }, globalThis.location.origin, [bytes]);
    });
  }
  // No "noopener": Imagine needs window.opener to ask for the log.
  return globalThis.open(imagineUrl(), "_blank");
}

/**
 * Imagine side. Asks the opener for its log.
 * @param {(payload:object) => void} onLog
 * @param {number} timeoutMs how long to wait before giving up (the caller shows a file picker)
 * @returns {Promise<boolean>} resolves true once a log arrived, false on timeout / no opener
 */
export function requestLogFromOpener(onLog, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const opener = globalThis.opener;
    if (!opener || opener.closed) {
      resolve(false);
      return;
    }

    let done = false;
    const listener = (event) => {
      if (event.origin !== globalThis.location.origin) return;
      if (event.source !== opener) return;
      if (event.data?.type !== MSG_LOG) return;
      done = true;
      globalThis.removeEventListener("message", listener);
      onLog(event.data);
      resolve(true);
    };
    globalThis.addEventListener("message", listener);

    try {
      opener.postMessage({ type: MSG_READY }, globalThis.location.origin);
    } catch {
      globalThis.removeEventListener("message", listener);
      resolve(false);
      return;
    }

    setTimeout(() => {
      if (!done) {
        globalThis.removeEventListener("message", listener);
        resolve(false);
      }
    }, timeoutMs);
  });
}
