// tests/helpers/async.js
'use strict';

/** Ждёт события emitter'а, отклоняется по таймауту. */
function waitEvent(emitter, event, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`waitEvent: timeout waiting for "${event}"`)), timeout);
    emitter.once(event, (...args) => {
      clearTimeout(t);
      resolve(args);
    });
  });
}

/** Опрашивает predicate() до true или до истечения таймаута. */
function waitFor(predicate, { timeout = 2000, interval = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function tick() {
      let ok;
      try { ok = predicate(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('waitFor: timeout'));
      setTimeout(tick, interval);
    })();
  });
}

module.exports = { waitEvent, waitFor };
