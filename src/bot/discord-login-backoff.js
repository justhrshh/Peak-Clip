/**
 * Discord login with exponential backoff + jitter.
 *
 * Drop-in replacement for a bare `client.login(token)` call.
 * Prevents the failure mode from today: a fatal login error causing
 * process.exit(1), Render instantly restarting, and the new process
 * immediately re-hitting Discord's rate limit.
 *
 * Behavior:
 *  - Retries login attempts with exponential backoff (capped) + random jitter.
 *  - Distinguishes "permanent misconfiguration" errors (bad token, missing
 *    intents) from "transient" errors (429, network, timeout) — permanent
 *    errors still fail fast via process.exit(1), since retrying those is
 *    pointless. Transient errors retry in-process instead of crash-looping.
 *  - Still enforces your existing 30s per-attempt timeout.
 *  - After MAX_ATTEMPTS transient failures, exits with a distinct code so
 *    you can tell "gave up after backoff" apart from "misconfigured" in logs.
 */

const LOGIN_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 2_000;      // first retry delay
const MAX_DELAY_MS = 5 * 60_000;  // cap at 5 minutes between attempts

function isPermanentError(err) {
  const msg = String(err?.message || err);
  // Discord.js throws these for genuinely bad config — no point retrying.
  return (
    msg.includes('TOKEN_INVALID') ||
    msg.includes('An invalid token was provided') ||
    msg.includes('DISALLOWED_INTENTS') ||
    msg.includes('Used disallowed intents')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt) {
  const exp = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  const jitter = Math.random() * exp * 0.3; // up to 30% jitter
  return Math.round(exp + jitter);
}

/**
 * @param {import('discord.js').Client} client
 * @param {string} token
 */
async function loginWithBackoff(client, token) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[login] attempt ${attempt}/${MAX_ATTEMPTS}`);

    try {
      await Promise.race([
        client.login(token),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Login timed out after ${LOGIN_TIMEOUT_MS}ms`)),
            LOGIN_TIMEOUT_MS
          )
        ),
      ]);

      console.log('[login] success');
      return; // logged in, done
    } catch (err) {
      console.error(`[login] attempt ${attempt} failed:`, err?.message || err);

      if (isPermanentError(err)) {
        console.error('[login] fatal misconfiguration, not retrying');
        process.exit(1);
      }

      if (attempt === MAX_ATTEMPTS) {
        console.error(`[login] gave up after ${MAX_ATTEMPTS} attempts`);
        process.exit(2); // distinct code: exhausted backoff, not misconfig
      }

      const delay = backoffDelay(attempt);
      console.log(`[login] retrying in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }
  }
}

module.exports = { loginWithBackoff };
