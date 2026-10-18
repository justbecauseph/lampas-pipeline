import { DEFAULT_OPERATION_TIMEOUT_MS, withAbortTimeout } from "./utils";

export const MODRINTH_API = "https://api.modrinth.com/v2";
export const MODRINTH_USER_AGENT = "Lampas-Pipeline/2.0 (contact@lampas.town)";

const MAX_RETRIES = 5;
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 60_000;
// At or above `check`'s 12 workers, so requests already in flight fit in the remaining quota.
const LOW_REMAINING = 15;

interface RateLimitClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: RateLimitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let clock: RateLimitClock = realClock;
let pausedUntil = 0;

/** For tests only: replaces the clock that times rate-limit pauses. */
export function setModrinthRateLimitClock(next: RateLimitClock): void {
  clock = next;
}

/** For tests only: restores the real clock and clears any active pause. */
export function resetModrinthRateLimit(): void {
  clock = realClock;
  pausedUntil = 0;
}

function headerNumber(res: Response, name: string): number | undefined {
  const raw = res.headers.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function rateLimitWaitMs(res: Response, retry: number, nowMs: number): number {
  const seconds = headerNumber(res, "Retry-After");
  // Date.parse accepts bare numbers, so only try a date when the header is not numeric.
  const retryDate = seconds === undefined ? Date.parse(res.headers.get("Retry-After") ?? "") : NaN;
  const reset = headerNumber(res, "X-Ratelimit-Reset");
  let wait: number;
  if (seconds !== undefined && seconds >= 0) wait = seconds * 1000;
  else if (Number.isFinite(retryDate)) wait = retryDate - nowMs;
  else if (reset !== undefined && reset >= 0) wait = reset * 1000;
  else wait = 1000 * 2 ** retry;
  return Math.min(Math.max(wait, MIN_WAIT_MS), MAX_WAIT_MS);
}

export async function modrinthFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", MODRINTH_USER_AGENT);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");

  for (let retry = 0; ; retry++) {
    while (clock.now() < pausedUntil) {
      await clock.sleep(pausedUntil - clock.now());
    }

    // Buffer the body inside the timeout so callers' res.json() cannot stall.
    const res = await withAbortTimeout(
      `fetching Modrinth ${url}`,
      async (signal) => {
        const raw = await fetch(url, { ...init, headers, signal });
        const body = await raw.arrayBuffer();
        return new Response(body, { status: raw.status, statusText: raw.statusText, headers: raw.headers });
      },
      timeoutMs
    );

    if (res.status !== 429) {
      const remaining = headerNumber(res, "X-Ratelimit-Remaining");
      const reset = headerNumber(res, "X-Ratelimit-Reset");
      if (remaining !== undefined && remaining <= LOW_REMAINING && reset !== undefined && reset >= 0) {
        pausedUntil = Math.max(pausedUntil, clock.now() + Math.min(reset * 1000, MAX_WAIT_MS));
      }
      return res;
    }

    const wait = rateLimitWaitMs(res, retry, clock.now());
    pausedUntil = Math.max(pausedUntil, clock.now() + wait);
    if (retry >= MAX_RETRIES) return res;
    console.warn(`[Modrinth] HTTP 429 for ${url}; waiting ${Math.ceil(wait / 1000)}s (retry ${retry + 1}/${MAX_RETRIES}).`);
  }
}
