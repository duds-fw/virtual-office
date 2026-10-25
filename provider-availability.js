'use strict';
/**
 * provider-availability.js — decides when the owner is told that the office
 * can or cannot serve work.
 *
 * Blindness is a state, not an event. The rules, in the order they are
 * applied:
 *
 *   1. A state that has not changed says nothing.
 *   2. Blindness is announced once. A provider that refuses and recovers
 *      inside the quiet window is flapping, not news: the pair is dropped,
 *      so the owner is not told "stopped" and "working again" every few
 *      minutes.
 *   3. A recovery is announced only when the owner was told about the
 *      blindness — an orphan "it works again" tells the owner nothing.
 *
 * The rule lives here, apart from the channel, because the rule is the thing
 * worth testing: a provider that refuses for an hour must produce one
 * message, not thirty.
 */

const DEFAULT_QUIET_MS = 30 * 60 * 1000;   // a flap inside this window is not news

function createAvailability({ send, quietMs = DEFAULT_QUIET_MS, now = () => Date.now(), log = () => {} } = {}) {
  let state = 'working';
  let blindAnnounced = false;
  let lastNoticeAt = 0;

  async function report(nextState, { reason = '', queued = 0 } = {}) {
    if (nextState !== 'working' && nextState !== 'blind') {
      throw new Error(`unknown provider state: ${nextState}`);
    }
    if (nextState === state) return { sent: false, reason: 'same_state' };
    state = nextState;

    if (nextState === 'blind') {
      const ts = now();
      if (lastNoticeAt && ts - lastNoticeAt < quietMs) {
        return { sent: false, reason: 'flapping' };
      }
      const delivered = await deliver([
        '<b>The office has stopped working.</b>',
        '',
        reason,
        '',
        `Queued work: ${queued} item(s) — nothing is lost, it resumes automatically when a provider frees up.`,
        'The board, metrics and budget keep running.',
      ].join('\n'));
      if (!delivered) return { sent: false, reason: 'not_configured' };
      lastNoticeAt = ts;
      blindAnnounced = true;
      return { sent: true, state: nextState };
    }

    if (!blindAnnounced) return { sent: false, reason: 'never_announced' };
    const delivered = await deliver([
      '<b>The office is working again.</b>',
      '',
      reason,
      '',
      `Queued work: ${queued} item(s) remaining.`,
    ].join('\n'));
    if (!delivered) return { sent: false, reason: 'not_configured' };
    blindAnnounced = false;
    lastNoticeAt = now();
    return { sent: true, state: nextState };
  }

  async function deliver(text) {
    const delivered = await send(text);
    if (delivered === false) return false;
    log('availability notice sent');
    return true;
  }

  return {
    report,
    current: () => state,
  };
}

module.exports = { createAvailability, DEFAULT_QUIET_MS };
