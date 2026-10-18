import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  modrinthFetch,
  resetModrinthRateLimit,
  setModrinthRateLimitClock,
} from "../src/modrinth-http";

const API = "https://api.modrinth.com/v2";
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

let t = 0;
const slept: number[] = [];
const calls: Array<{ url: string; headers: Headers; at: number }> = [];

function mockFetch(respond: (index: number, url: string) => Response): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const index = calls.length;
    calls.push({ url, headers: new Headers(init?.headers), at: t });
    return respond(index, url);
  }) as typeof fetch;
}

function json(headers: Record<string, string> = {}): Response {
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json", ...headers } });
}

function limited(headers: Record<string, string> = {}): Response {
  return new Response("rate limited", { status: 429, headers });
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
}

beforeEach(() => {
  t = 0;
  slept.length = 0;
  calls.length = 0;
  console.warn = () => {};
  setModrinthRateLimitClock({
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  resetModrinthRateLimit();
});

describe("modrinthFetch 429 handling", () => {
  test("waits out Retry-After and retries with the Modrinth headers", async () => {
    mockFetch((i) => (i === 0 ? limited({ "Retry-After": "2" }) : json()));
    const res = await modrinthFetch(`${API}/project/example`);
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(slept).toEqual([2000]);
    for (const call of calls) {
      expect(call.headers.get("User-Agent")).toBe("Lampas-Pipeline/2.0 (contact@lampas.town)");
      expect(call.headers.get("Accept")).toBe("application/json");
    }
  });

  test("falls back to X-Ratelimit-Reset when Retry-After is absent", async () => {
    mockFetch((i) => (i === 0 ? limited({ "X-Ratelimit-Reset": "7" }) : json()));
    const res = await modrinthFetch(`${API}/project/example`);
    expect(res.status).toBe(200);
    expect(slept).toEqual([7000]);
  });

  test("honors an HTTP-date Retry-After relative to the clock", async () => {
    t = 1_700_000_000_000;
    mockFetch((i) => (i === 0 ? limited({ "Retry-After": new Date(t + 5000).toUTCString() }) : json()));
    const res = await modrinthFetch(`${API}/project/example`);
    expect(res.status).toBe(200);
    expect(slept).toEqual([5000]);
  });

  test("caps a long Retry-After at 60 seconds", async () => {
    mockFetch((i) => (i === 0 ? limited({ "Retry-After": "600" }) : json()));
    const res = await modrinthFetch(`${API}/project/example`);
    expect(res.status).toBe(200);
    expect(slept).toEqual([60000]);
  });

  test("returns the 429 after six requests when every attempt is limited", async () => {
    mockFetch(() => limited());
    const res = await modrinthFetch(`${API}/project/example`);
    expect(res.status).toBe(429);
    expect(calls.length).toBe(6);
    expect(slept).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  test("the final 429 still pauses the next request", async () => {
    mockFetch((i) => (i < 6 ? limited({ "Retry-After": "3" }) : json()));
    expect((await modrinthFetch(`${API}/project/example`)).status).toBe(429);
    expect((await modrinthFetch(`${API}/project/example`)).status).toBe(200);
    expect(calls[6].at - calls[5].at).toBe(3000);
  });

  test("waits at least one second when Retry-After is 0", async () => {
    mockFetch((i) => (i === 0 ? limited({ "Retry-After": "0" }) : json()));
    await modrinthFetch(`${API}/project/example`);
    expect(slept).toEqual([1000]);
  });

  test("ignores a negative Retry-After and uses X-Ratelimit-Reset", async () => {
    mockFetch((i) => (i === 0 ? limited({ "Retry-After": "-5", "X-Ratelimit-Reset": "20" }) : json()));
    await modrinthFetch(`${API}/project/example`);
    expect(slept).toEqual([20000]);
  });
});

describe("modrinthFetch proactive pause", () => {
  test("caps the low-quota pause at 60 seconds", async () => {
    mockFetch(() => json({ "X-Ratelimit-Remaining": "0", "X-Ratelimit-Reset": "300" }));
    await modrinthFetch(`${API}/project/example`);
    await modrinthFetch(`${API}/project/example`);
    expect(slept).toEqual([60000]);
  });

  test("keeps the caller's headers and resends a POST body on retry", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), at: t });
      bodies.push(String(init?.body));
      return calls.length === 1 ? limited({ "Retry-After": "1" }) : json();
    }) as typeof fetch;
    const res = await modrinthFetch(`${API}/version_files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hashes: ["abc"], algorithm: "sha512" }),
    });
    expect(res.status).toBe(200);
    expect(bodies).toEqual(['{"hashes":["abc"],"algorithm":"sha512"}', '{"hashes":["abc"],"algorithm":"sha512"}']);
    for (const call of calls) expect(call.headers.get("Content-Type")).toBe("application/json");
  });

  test("pauses the next call when remaining requests are at or below 15", async () => {
    mockFetch(() => json({ "X-Ratelimit-Remaining": "15", "X-Ratelimit-Reset": "10" }));
    await modrinthFetch(`${API}/project/example`);
    expect(slept).toEqual([]);
    await modrinthFetch(`${API}/project/example`);
    expect(slept).toEqual([10000]);
    expect(calls[1].at).toBe(10000);
  });

  test("does not pause when more than 15 requests remain", async () => {
    mockFetch(() => json({ "X-Ratelimit-Remaining": "16", "X-Ratelimit-Reset": "10" }));
    await modrinthFetch(`${API}/project/example`);
    await modrinthFetch(`${API}/project/example`);
    expect(slept).toEqual([]);
  });

  test("concurrent callers wait for a pause another caller set", async () => {
    const waiters: Array<{ until: number; wake: () => void }> = [];
    setModrinthRateLimitClock({
      now: () => t,
      sleep: (ms) =>
        new Promise<void>((wake) => {
          slept.push(ms);
          waiters.push({ until: t + ms, wake });
        }),
    });
    mockFetch((i) => (i === 0 ? limited({ "Retry-After": "3" }) : json()));

    const first = modrinthFetch(`${API}/project/a`);
    await until(() => slept.length === 1);
    const second = modrinthFetch(`${API}/project/b`);
    await until(() => slept.length === 2);
    expect(calls.map((call) => call.url)).toEqual([`${API}/project/a`]);

    t = 3000;
    for (const waiter of waiters.splice(0)) waiter.wake();
    const [a, b] = await Promise.all([first, second]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(slept).toEqual([3000, 3000]);
    const firstLimited = calls[0];
    const bRequest = calls.find((call) => call.url === `${API}/project/b`);
    expect(bRequest).toBeDefined();
    expect(bRequest!.at).toBeGreaterThanOrEqual(firstLimited.at + 3000);
  });
});

describe("modrinthFetch timeout", () => {
  test("times out when the response body stalls after the headers arrive", async () => {
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    await expect(modrinthFetch(`${API}/project/stall`, {}, 50)).rejects.toThrow("Timed out after 50ms");
  });
});
