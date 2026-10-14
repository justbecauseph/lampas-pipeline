import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeManifestDiff, diffManifests, type DiffResult } from "../src/diff";
import {
  comparePortalRelease,
  printPortalComparison,
  type ComparePortalReleaseOptions,
  type PortalComparison,
} from "../src/portal-compare";
import type { ManifestFile, PackManifest, ReleaseDescriptor } from "../src/types";

const PORTAL = "https://dev.lampas.town";
const VERSION = "2.3.33";
const OLDER_VERSION = "2.3.32";
const PUBLISHED_AT = "2026-10-14T08:27:51.253Z";

const EMPTY_DIFF: DiffResult = { added: [], removed: [], modified: [], totalSizeDelta: 0, changedFields: [] };

/** The local release descriptor that the comparisons publish. */
const RELEASE: ReleaseDescriptor = {
  schemaVersion: 1,
  pack: "Lampas 2",
  version: VERSION,
  minecraft: "26.2",
  loader: { type: "fabric", version: "0.19.3" },
  minimumLauncherVersion: "1.2.0",
  protocol: 2,
  gitCommit: "9f2c1ab",
  created: PUBLISHED_AT,
  clientManifest: `/api/v1/releases/${VERSION}/client-manifest`,
  serverManifest: `/api/v1/releases/${VERSION}/server-manifest`,
  launch: { autoConnect: true, server: "play.lampas.town" },
};

/** The descriptor the Portal serves for VERSION. It matches RELEASE field for field. */
const STORED_RELEASE = {
  schemaVersion: 1,
  pack: "Lampas 2",
  version: VERSION,
  minecraft: "26.2",
  loader: { type: "fabric", version: "0.19.3" },
  minimumLauncherVersion: "1.2.0",
  protocol: 2,
  status: "STABLE",
  gitCommit: "9f2c1ab",
  launch: { autoConnect: true, server: "play.lampas.town" },
  signature: null,
  created: PUBLISHED_AT,
};

function file(filePath: string, size: number, sha256: string, downloadUrl = `${PORTAL}/blobs/${sha256}`): ManifestFile {
  return {
    path: filePath,
    size,
    hashes: { sha256 },
    download: { url: downloadUrl, provider: "lampas" },
    policy: "MANAGED",
  };
}

function manifest(
  target: "client" | "server",
  files: ManifestFile[],
  overrides: Partial<PackManifest> = {},
  version = VERSION
): PackManifest {
  return {
    schemaVersion: 2,
    pack: "Lampas 2",
    version,
    target,
    minecraft: "26.2",
    loader: { type: "fabric", version: "0.19.3" },
    protocol: 2,
    files,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

type Route = () => Response;

/** Serves the routes by exact URL and records every requested URL in order. */
function installFetch(routes: Record<string, Route>): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const key = url.toString();
    requested.push(key);
    const handler = routes[key];
    return handler ? handler() : notFound();
  }) as any;
  return requested;
}

/** Channel routes that all point at `version`. */
function channelRoutes(version: string): Record<string, Route> {
  return {
    [`${PORTAL}/api/v1/channels/dev`]: () => json({ channel: "dev", version }),
    [`${PORTAL}/api/v1/channels/beta`]: () => json({ channel: "beta", version }),
    [`${PORTAL}/api/v1/channels/stable`]: () => json({ channel: "stable", version }),
  };
}

/** Portal routes for a release at VERSION that serves `served` as its client and server manifests. */
function standardRoutes(
  served: { client: PackManifest; server: PackManifest },
  overrides: Record<string, Route> = {}
): Record<string, Route> {
  return {
    ...channelRoutes(VERSION),
    [`${PORTAL}/api/v1/releases/${VERSION}`]: () => json(STORED_RELEASE),
    [`${PORTAL}/api/v1/releases/${VERSION}/client-manifest`]: () => json(served.client),
    [`${PORTAL}/api/v1/releases/${VERSION}/server-manifest`]: () => json(served.server),
    ...overrides,
  };
}

function compareOptions(
  client: PackManifest,
  server: PackManifest,
  channel: ComparePortalReleaseOptions["channel"] = "stable",
  release: ReleaseDescriptor = RELEASE
): ComparePortalReleaseOptions {
  return { portalUrl: PORTAL, channel, client, server, release };
}

/** Captures what printPortalComparison writes to stdout and stderr. */
function printed(c: PortalComparison): { logs: string[]; warnings: string[] } {
  const logs: string[] = [];
  const warnings: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    printPortalComparison(c);
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
  return { logs, warnings };
}

/** Starts a Portal stub whose manifest bodies stall after the first bytes. */
function startStallingPortal(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const pathname = new URL(req.url).pathname;
      if (pathname.startsWith("/api/v1/channels/")) {
        return json({ channel: pathname.split("/").pop(), version: VERSION });
      }
      if (pathname === `/api/v1/releases/${VERSION}`) {
        return json(STORED_RELEASE);
      }
      if (pathname.endsWith("-manifest")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"schemaVersion":2,"files":['));
          },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return notFound();
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const clientFiles = [file("mods/shared.jar", 1000, "shared-hash"), file("config/options.txt", 20, "options-hash")];
const serverFiles = [file("mods/shared.jar", 1000, "shared-hash"), file("mods/server-only.jar", 2048, "server-hash")];

afterEach(() => {
  mock.restore();
});

describe("computeManifestDiff", () => {
  test("reports added, removed, and modified paths and the net size delta", () => {
    const from = manifest("client", [
      file("mods/keep.jar", 100, "keep-hash"),
      file("mods/bump.jar", 200, "bump-old"),
      file("mods/gone.jar", 50, "gone-hash"),
    ]);
    const to = manifest("client", [
      file("mods/keep.jar", 100, "keep-hash"),
      file("mods/bump.jar", 260, "bump-new"),
      file("mods/new.jar", 1000, "new-hash"),
    ]);

    const diff = computeManifestDiff(from, to);

    expect(diff.added.map((f) => f.path)).toEqual(["mods/new.jar"]);
    expect(diff.removed.map((f) => f.path)).toEqual(["mods/gone.jar"]);
    expect(diff.modified).toEqual([
      { path: "mods/bump.jar", oldSize: 200, newSize: 260, oldHash: "bump-old", newHash: "bump-new" },
    ]);
    // +1000 for mods/new.jar, +60 for mods/bump.jar, -50 for mods/gone.jar
    expect(diff.totalSizeDelta).toBe(1010);
    // File changes alone do not produce changedFields entries.
    expect(diff.changedFields).toEqual([]);
  });

  test("changedFields reports a loader version change", () => {
    const from = manifest("server", [file("mods/a.jar", 10, "a-hash")]);
    const to = manifest("server", [file("mods/a.jar", 10, "a-hash")], {
      loader: { type: "fabric", version: "0.19.4" },
    });

    expect(computeManifestDiff(from, to).changedFields).toEqual(["loader"]);
  });

  test("changedFields ignores object key order", () => {
    const from = manifest("client", [], {
      mods: [{ id: "a", name: "A", side: "client", filename: "a.jar", size: 10 }],
    });
    const to: PackManifest = {
      files: [],
      protocol: 2,
      loader: { version: "0.19.3", type: "fabric" },
      minecraft: "26.2",
      target: "client",
      version: VERSION,
      pack: "Lampas 2",
      schemaVersion: 2,
      mods: [{ size: 10, filename: "a.jar", side: "client", name: "A", id: "a" }],
    };

    expect(computeManifestDiff(from, to).changedFields).toEqual([]);
  });

  test("changedFields lists top-level keys present on one side only, sorted", () => {
    const from = manifest("client", [file("mods/a.jar", 10, "a-hash")]);
    const to = manifest("client", [file("mods/a.jar", 10, "a-hash")], {
      version: "2.3.34",
      mods: [{ id: "a", name: "A", side: "client", filename: "a.jar", size: 10 }],
    });

    expect(computeManifestDiff(from, to).changedFields).toEqual(["mods", "version"]);
  });

  test("identical manifests produce an empty diff", () => {
    const m = manifest("server", [file("mods/a.jar", 10, "a-hash")], {
      mods: [{ id: "a", name: "A", side: "server", filename: "a.jar", size: 10 }],
    });
    const copy: PackManifest = JSON.parse(JSON.stringify(m));

    expect(computeManifestDiff(m, copy)).toEqual({
      added: [],
      removed: [],
      modified: [],
      totalSizeDelta: 0,
      changedFields: [],
    });
  });

  test("does not write to the console", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const from = manifest("client", [file("mods/a.jar", 10, "a-hash")]);
    const to = manifest("client", [file("mods/b.jar", 20, "b-hash")]);

    computeManifestDiff(from, to);

    expect(log).not.toHaveBeenCalled();
  });
});

describe("comparePortalRelease", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("reports identical targets and no publish conflict when the Portal serves the same manifests", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    installFetch(standardRoutes({ client, server }));

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.channels).toEqual({ dev: VERSION, beta: VERSION, stable: VERSION });
    expect(c.channelErrors).toEqual({});
    expect(c.localPublished).toEqual({ published: true, created: PUBLISHED_AT });
    expect(c.compareVersion).toBe(VERSION);
    expect(c.error).toBeUndefined();
    expect(c.targets.map((t) => t.target)).toEqual(["client", "server"]);
    for (const t of c.targets) {
      expect(t.error).toBeUndefined();
      expect(t.diff).toEqual(EMPTY_DIFF);
      expect(t.contentIdentical).toBe(true);
    }
    expect(c.publishConflict).toBe(false);
    expect(c.publishConflictFields).toEqual([]);
    expect(c.publishConflictError).toBeUndefined();
  });

  test("reports an unpublished local version and a file added to the server manifest", async () => {
    const client = manifest("client", clientFiles);
    const portalServer = manifest("server", serverFiles);
    const localServer = manifest("server", [...serverFiles, file("mods/new-feature.jar", 4096, "new-hash")]);
    installFetch(
      standardRoutes(
        { client, server: portalServer },
        { [`${PORTAL}/api/v1/releases/${VERSION}`]: notFound }
      )
    );

    const c = await comparePortalRelease(compareOptions(client, localServer));

    expect(c.localPublished).toEqual({ published: false });
    expect(c.targets[0].diff).toEqual(EMPTY_DIFF);
    const serverDiff = c.targets[1].diff;
    expect(serverDiff?.added.map((f) => f.path)).toEqual(["mods/new-feature.jar"]);
    expect(serverDiff?.removed).toEqual([]);
    expect(serverDiff?.modified).toEqual([]);
    expect(serverDiff?.totalSizeDelta).toBe(4096);
    expect(serverDiff?.changedFields).toEqual([]);
    expect(c.publishConflict).toBe(false);
  });

  test("an unpublished local version with different content prints no publish warning", async () => {
    const client = manifest("client", clientFiles);
    const portalServer = manifest("server", serverFiles);
    const localServer = manifest("server", [...serverFiles, file("mods/new-feature.jar", 4096, "new-hash")]);
    installFetch(
      standardRoutes({ client, server: portalServer }, { [`${PORTAL}/api/v1/releases/${VERSION}`]: notFound })
    );

    const c = await comparePortalRelease(compareOptions(client, localServer));
    const output = printed(c);

    expect(c.publishConflict).toBe(false);
    expect(output.warnings).toEqual([]);
    expect(output.logs.join("\n")).not.toContain("409");
  });

  test("a channel endpoint returning 500 marks only that channel unavailable", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    installFetch(
      standardRoutes(
        { client, server },
        { [`${PORTAL}/api/v1/channels/beta`]: () => json({ error: "internal" }, 500) }
      )
    );

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.channels).toEqual({ dev: VERSION, beta: null, stable: VERSION });
    expect(Object.keys(c.channelErrors)).toEqual(["beta"]);
    expect(c.channelErrors.beta).toContain("HTTP 500");
    expect(c.compareVersion).toBe(VERSION);
    expect(c.error).toBeUndefined();
    expect(c.targets.map((t) => t.error)).toEqual([undefined, undefined]);
    expect(c.targets.map((t) => t.diff)).toEqual([EMPTY_DIFF, EMPTY_DIFF]);
  });

  test("a channel endpoint returning 400 keeps its reason", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    installFetch(
      standardRoutes(
        { client, server },
        { [`${PORTAL}/api/v1/channels/beta`]: () => new Response("bad channel", { status: 400 }) }
      )
    );

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.channels.beta).toBeNull();
    expect(c.channelErrors.beta).toContain("HTTP 400");
  });

  test("never throws when every request fails, and records the errors", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as any;
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.channels).toEqual({ dev: null, beta: null, stable: null });
    expect(c.channelErrors).toEqual({ dev: "fetch failed", beta: "fetch failed", stable: "fetch failed" });
    expect(c.localPublished).toBeNull();
    expect(c.localPublishedError).toBe("fetch failed");
    expect(c.publishConflict).toBeNull();
    expect(c.compareVersion).toBeNull();
    expect(c.targets).toEqual([]);
    expect(c.error).toContain("'stable'");
    expect(c.error).toContain("fetch failed");
  });

  test("a failed target fetch sets that target's error and keeps the other target", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    installFetch(
      standardRoutes(
        { client, server },
        { [`${PORTAL}/api/v1/releases/${VERSION}/client-manifest`]: () => json({ error: "boom" }, 500) }
      )
    );

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.targets[0].target).toBe("client");
    expect(c.targets[0].diff).toBeNull();
    expect(c.targets[0].contentIdentical).toBe(false);
    expect(c.targets[0].error).toContain("HTTP 500");
    expect(c.targets[1].target).toBe("server");
    expect(c.targets[1].diff).toEqual(EMPTY_DIFF);
    expect(c.targets[1].contentIdentical).toBe(true);
    expect(c.targets[1].error).toBeUndefined();
    // The client manifest is unknown, so the publish check cannot pass.
    expect(c.publishConflict).toBeNull();
    expect(c.publishConflictError).toContain("client manifest:");
  });

  test("a published version whose manifests differ from the channel's release is a publish conflict", async () => {
    const client = manifest("client", clientFiles);
    const localServer = manifest("server", [...serverFiles, file("mods/new-feature.jar", 4096, "new-hash")]);
    const portalServer = manifest("server", serverFiles);
    installFetch(standardRoutes({ client, server: portalServer }));

    const c = await comparePortalRelease(compareOptions(client, localServer));

    expect(c.localPublished).toEqual({ published: true, created: PUBLISHED_AT });
    expect(c.compareVersion).toBe(VERSION);
    expect(c.targets[0].diff).toEqual(EMPTY_DIFF);
    expect(c.targets[1].diff?.added.map((f) => f.path)).toEqual(["mods/new-feature.jar"]);
    expect(c.publishConflict).toBe(true);
    expect(c.publishConflictFields).toEqual(["serverManifest"]);
  });

  test("channel on an older version: publish check fetches the local version's manifests", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    const olderServer = manifest("server", [...serverFiles, file("mods/old-only.jar", 5, "old-hash")], {}, OLDER_VERSION);
    const requested = installFetch({
      [`${PORTAL}/api/v1/channels/dev`]: () => json({ channel: "dev", version: OLDER_VERSION }),
      [`${PORTAL}/api/v1/channels/beta`]: () => json({ channel: "beta", version: OLDER_VERSION }),
      [`${PORTAL}/api/v1/channels/stable`]: () => json({ channel: "stable", version: OLDER_VERSION }),
      [`${PORTAL}/api/v1/releases/${OLDER_VERSION}`]: () => json({ version: OLDER_VERSION, created: "2026-10-01T00:00:00Z" }),
      [`${PORTAL}/api/v1/releases/${OLDER_VERSION}/client-manifest`]: () => json(manifest("client", clientFiles, {}, OLDER_VERSION)),
      [`${PORTAL}/api/v1/releases/${OLDER_VERSION}/server-manifest`]: () => json(olderServer),
      [`${PORTAL}/api/v1/releases/${VERSION}`]: () => json(STORED_RELEASE),
      [`${PORTAL}/api/v1/releases/${VERSION}/client-manifest`]: () => json(client),
      [`${PORTAL}/api/v1/releases/${VERSION}/server-manifest`]: () => json(server),
    });

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.compareVersion).toBe(OLDER_VERSION);
    // The diff is against the older release: its extra file counts as removed.
    expect(c.targets[1].diff?.removed.map((f) => f.path)).toEqual(["mods/old-only.jar"]);
    expect(c.publishConflict).toBe(false);
    expect(requested).toContain(`${PORTAL}/api/v1/releases/${VERSION}/client-manifest`);
    expect(requested).toContain(`${PORTAL}/api/v1/releases/${VERSION}/server-manifest`);
  });

  test("channel on an older version and the local version published with different content is a publish conflict", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    const publishedServer = manifest("server", [...serverFiles, file("mods/published-only.jar", 7, "pub-hash")]);
    installFetch({
      [`${PORTAL}/api/v1/channels/dev`]: () => json({ channel: "dev", version: OLDER_VERSION }),
      [`${PORTAL}/api/v1/channels/beta`]: () => json({ channel: "beta", version: OLDER_VERSION }),
      [`${PORTAL}/api/v1/channels/stable`]: () => json({ channel: "stable", version: OLDER_VERSION }),
      [`${PORTAL}/api/v1/releases/${OLDER_VERSION}`]: () => json({ version: OLDER_VERSION, created: "2026-10-01T00:00:00Z" }),
      [`${PORTAL}/api/v1/releases/${OLDER_VERSION}/client-manifest`]: () => json(manifest("client", clientFiles, {}, OLDER_VERSION)),
      [`${PORTAL}/api/v1/releases/${OLDER_VERSION}/server-manifest`]: () => json(manifest("server", serverFiles, {}, OLDER_VERSION)),
      [`${PORTAL}/api/v1/releases/${VERSION}`]: () => json(STORED_RELEASE),
      [`${PORTAL}/api/v1/releases/${VERSION}/client-manifest`]: () => json(client),
      [`${PORTAL}/api/v1/releases/${VERSION}/server-manifest`]: () => json(publishedServer),
    });

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.compareVersion).toBe(OLDER_VERSION);
    // The diffs are against the older release. Its manifests differ from the local ones only in their version
    // string: the published server's extra file is not in the diff.
    expect(c.targets.map((t) => t.error)).toEqual([undefined, undefined]);
    expect(c.targets.map((t) => t.diff)).toEqual([
      { ...EMPTY_DIFF, changedFields: ["version"] },
      { ...EMPTY_DIFF, changedFields: ["version"] },
    ]);
    // The published server manifest has mods/published-only.jar, which the local server manifest lacks.
    expect(c.publishConflict).toBe(true);
    expect(c.publishConflictFields).toEqual(["serverManifest"]);
  });

  test("a download.url change leaves the files identical, so the target is not contentIdentical and publish conflicts", async () => {
    const localClient = manifest("client", [
      file("mods/shared.jar", 1000, "shared-hash", `${PORTAL}/mirror/shared.jar`),
      file("config/options.txt", 20, "options-hash"),
    ]);
    const server = manifest("server", serverFiles);
    installFetch(standardRoutes({ client: manifest("client", clientFiles), server }));

    const c = await comparePortalRelease(compareOptions(localClient, server));

    expect(c.targets[0].diff).toEqual(EMPTY_DIFF);
    expect(c.targets[0].contentIdentical).toBe(false);
    expect(c.targets[1].contentIdentical).toBe(true);
    expect(c.publishConflict).toBe(true);
    expect(c.publishConflictFields).toEqual(["clientManifest"]);

    const output = printed(c);
    expect(output.logs).toContain("  client: identical files; other manifest metadata differs (e.g. download URLs or ordering)");
    expect(output.logs).toContain("  server: identical");
  });

  test("a 410 from the release endpoint marks the local version as published and revoked", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    installFetch(
      standardRoutes(
        { client, server },
        { [`${PORTAL}/api/v1/releases/${VERSION}`]: () => new Response("Gone", { status: 410 }) }
      )
    );

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.localPublished).toEqual({ published: true, revoked: true });
    expect(c.localPublishedError).toBeUndefined();
    expect(printed(c).logs).toContain(" Local version on Portal: published (revoked)");
  });

  test("a 200 HTML body from the release endpoint leaves the published check null with a reason", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    installFetch(
      standardRoutes(
        { client, server },
        {
          [`${PORTAL}/api/v1/releases/${VERSION}`]: () =>
            new Response("<!doctype html><html></html>", { status: 200, headers: { "Content-Type": "text/html" } }),
        }
      )
    );

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.localPublished).toBeNull();
    expect(c.localPublishedError).toContain("body is not valid JSON");
    // The selected channel points at the local version, so it still counts as published. Its manifests match,
    // but the stored release fields could not be read, so the publish check stays unknown.
    expect(c.publishConflict).toBeNull();
    expect(c.publishConflictFields).toEqual([]);
    expect(c.publishConflictError).toContain("release fields not checked: Invalid response for release v2.3.33");
    expect(c.publishConflictError).toContain("body is not valid JSON");
    const output = printed(c);
    expect(output.logs.join("\n")).toContain(" Local version on Portal: published (status check failed:");
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toMatch(
      /^v2\.3\.33 is already published; publish conflicts could not be fully checked \(release fields not checked: Invalid response for release v2\.3\.33 from .*: body is not valid JSON \(.*\)\)\.$/
    );
  });

  test("a local mods entry with description: undefined matches a Portal manifest without the key", async () => {
    const localClient = manifest("client", clientFiles, {
      mods: [{ id: "a", name: "A", side: "client", filename: "a.jar", size: 10, description: undefined }],
    });
    const portalClient = manifest("client", clientFiles, {
      mods: [{ id: "a", name: "A", side: "client", filename: "a.jar", size: 10 }],
    });
    const server = manifest("server", serverFiles);
    installFetch(standardRoutes({ client: portalClient, server }));

    const c = await comparePortalRelease(compareOptions(localClient, server));

    expect(c.targets[0].diff).toEqual(EMPTY_DIFF);
    expect(c.targets[0].contentIdentical).toBe(true);
    expect(c.publishConflict).toBe(false);
    expect(printed(c).logs).toContain("  client: identical");
  });

  test("an unavailable channel still checks the local version's publish state", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    const requested = installFetch(
      standardRoutes(
        { client, server },
        {
          [`${PORTAL}/api/v1/channels/dev`]: () => json({ error: "internal" }, 500),
          [`${PORTAL}/api/v1/channels/beta`]: () => json({ error: "internal" }, 500),
          [`${PORTAL}/api/v1/channels/stable`]: () => json({ error: "internal" }, 500),
        }
      )
    );

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.compareVersion).toBeNull();
    expect(c.error).toContain("'stable'");
    expect(c.error).toContain("HTTP 500");
    expect(c.targets).toEqual([]);
    expect(c.publishConflict).toBe(false);
    expect(requested).toContain(`${PORTAL}/api/v1/releases/${VERSION}/client-manifest`);
  });

  test("a manifest body that stalls after the headers times out and comparePortalRelease resolves", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    const stub = startStallingPortal();
    try {
      const c = await comparePortalRelease({
        portalUrl: stub.url,
        channel: "stable",
        client,
        server,
        release: RELEASE,
        timeoutMs: 200,
      });

      expect(c.compareVersion).toBe(VERSION);
      expect(c.targets.map((t) => t.error)).toEqual([
        "Timed out after 200ms while fetching client manifest for v2.3.33",
        "Timed out after 200ms while fetching server manifest for v2.3.33",
      ]);
      expect(c.publishConflict).toBeNull();
      expect(c.publishConflictFields).toEqual([]);
      expect(c.publishConflictError).toContain("Timed out after 200ms");
    } finally {
      stub.stop();
    }
  });

  test("identical release and manifests report no conflict and say publishing only moves channel pointers", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    installFetch(standardRoutes({ client, server }));

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.publishConflict).toBe(false);
    expect(c.publishConflictFields).toEqual([]);
    expect(printed(c).logs).toContain(
      "v2.3.33 is already published with identical manifests; publishing it again only moves channel pointers."
    );
  });

  test("a stored minimumLauncherVersion that differs is a publish conflict on that field", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    installFetch(
      standardRoutes(
        { client, server },
        { [`${PORTAL}/api/v1/releases/${VERSION}`]: () => json({ ...STORED_RELEASE, minimumLauncherVersion: "1.1.0" }) }
      )
    );

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.publishConflict).toBe(true);
    expect(c.publishConflictFields).toEqual(["minimumLauncherVersion"]);
  });

  test("a stored status other than STABLE is a publish conflict on status", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    installFetch(
      standardRoutes(
        { client, server },
        { [`${PORTAL}/api/v1/releases/${VERSION}`]: () => json({ ...STORED_RELEASE, status: "BETA" }) }
      )
    );

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.publishConflict).toBe(true);
    expect(c.publishConflictFields).toEqual(["status"]);
  });

  test("stored launch settings that differ only in key order do not conflict", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    installFetch(
      standardRoutes(
        { client, server },
        {
          [`${PORTAL}/api/v1/releases/${VERSION}`]: () =>
            json({ ...STORED_RELEASE, launch: { server: "play.lampas.town", autoConnect: true } }),
        }
      )
    );

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.publishConflict).toBe(false);
    expect(c.publishConflictFields).toEqual([]);
  });

  test("stored launch settings that differ in value are a publish conflict on launch", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    installFetch(
      standardRoutes(
        { client, server },
        {
          [`${PORTAL}/api/v1/releases/${VERSION}`]: () =>
            json({ ...STORED_RELEASE, launch: { autoConnect: false, server: "play.lampas.town" } }),
        }
      )
    );

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.publishConflict).toBe(true);
    expect(c.publishConflictFields).toEqual(["launch"]);
  });

  test("stored loader, Minecraft, protocol, git commit, and signature are each compared, in report order", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    installFetch(
      standardRoutes(
        { client, server },
        {
          [`${PORTAL}/api/v1/releases/${VERSION}`]: () =>
            json({
              ...STORED_RELEASE,
              minecraft: "26.1",
              loader: { type: "fabric", version: "0.19.4" },
              protocol: 3,
              gitCommit: "other1",
              signature: "sig-abc",
            }),
        }
      )
    );

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.publishConflict).toBe(true);
    expect(c.publishConflictFields).toEqual(["minecraft", "loader.version", "protocol", "gitCommit", "signature"]);
  });

  test("a local release without a git commit matches a stored null gitCommit", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    installFetch(
      standardRoutes(
        { client, server },
        { [`${PORTAL}/api/v1/releases/${VERSION}`]: () => json({ ...STORED_RELEASE, gitCommit: null }) }
      )
    );

    const c = await comparePortalRelease(compareOptions(client, server, "stable", { ...RELEASE, gitCommit: undefined }));

    expect(c.publishConflict).toBe(false);
    expect(c.publishConflictFields).toEqual([]);
  });

  test("a revoked local version is a publish conflict and its manifests are not fetched for the check", async () => {
    const client = manifest("client", clientFiles);
    const server = manifest("server", serverFiles);
    const requested = installFetch({
      ...channelRoutes(OLDER_VERSION),
      [`${PORTAL}/api/v1/releases/${OLDER_VERSION}`]: () => json({ version: OLDER_VERSION, created: "2026-10-01T00:00:00Z" }),
      [`${PORTAL}/api/v1/releases/${OLDER_VERSION}/client-manifest`]: () => json(manifest("client", clientFiles, {}, OLDER_VERSION)),
      [`${PORTAL}/api/v1/releases/${OLDER_VERSION}/server-manifest`]: () => json(manifest("server", serverFiles, {}, OLDER_VERSION)),
      [`${PORTAL}/api/v1/releases/${VERSION}`]: () => new Response("Gone", { status: 410 }),
    });

    const c = await comparePortalRelease(compareOptions(client, server));

    expect(c.localPublished).toEqual({ published: true, revoked: true });
    expect(c.compareVersion).toBe(OLDER_VERSION);
    expect(c.publishConflict).toBe(true);
    expect(c.publishConflictFields).toEqual(["status"]);
    expect(requested).not.toContain(`${PORTAL}/api/v1/releases/${VERSION}/client-manifest`);
    expect(requested).not.toContain(`${PORTAL}/api/v1/releases/${VERSION}/server-manifest`);
    expect(printed(c).warnings).toEqual([
      "⚠ v2.3.33 is revoked on the Portal; publishing it will be rejected (409). Bump [pack] version in pack.toml before publishing.",
    ]);
  });
});

describe("printPortalComparison", () => {
  test("warns when the local version is already published and its manifests differ", () => {
    const comparison: PortalComparison = {
      portalUrl: PORTAL,
      channel: "stable",
      localVersion: VERSION,
      channels: { dev: VERSION, beta: VERSION, stable: VERSION },
      channelErrors: {},
      localPublished: { published: true, created: PUBLISHED_AT },
      compareVersion: VERSION,
      targets: [
        { target: "client", diff: EMPTY_DIFF, contentIdentical: true },
        {
          target: "server",
          diff: {
            added: [file("mods/new.jar", 10, "new-hash")],
            removed: [],
            modified: [],
            totalSizeDelta: 10,
            changedFields: [],
          },
          contentIdentical: false,
        },
      ],
      publishConflict: true,
      publishConflictFields: ["serverManifest"],
    };

    const output = printed(comparison);

    expect(output.warnings).toEqual([
      "⚠ v2.3.33 is already published on the Portal with different content (serverManifest); publishing it will be rejected (409). Bump [pack] version in pack.toml before publishing.",
    ]);
    expect(output.logs).toContain("  client: identical");
    expect(output.logs).toContain("  server: +1 added, -0 removed, ~0 updated, net +10 B");
    expect(output.logs).toContain("    + mods/new.jar (10 B)");
  });

  test("says publishing only moves channel pointers when the published manifests match", () => {
    const comparison: PortalComparison = {
      portalUrl: PORTAL,
      channel: "stable",
      localVersion: VERSION,
      channels: { dev: VERSION, beta: VERSION, stable: VERSION },
      channelErrors: {},
      localPublished: { published: true, created: PUBLISHED_AT },
      compareVersion: VERSION,
      targets: [
        { target: "client", diff: EMPTY_DIFF, contentIdentical: true },
        { target: "server", diff: EMPTY_DIFF, contentIdentical: true },
      ],
      publishConflict: false,
      publishConflictFields: [],
    };

    const output = printed(comparison);

    expect(output.warnings).toEqual([]);
    expect(output.logs).toContain(
      "v2.3.33 is already published with identical manifests; publishing it again only moves channel pointers."
    );
  });

  test("reports an unknown publish conflict while published, with the reason", () => {
    const comparison: PortalComparison = {
      portalUrl: PORTAL,
      channel: "stable",
      localVersion: VERSION,
      channels: { dev: VERSION, beta: VERSION, stable: VERSION },
      channelErrors: {},
      localPublished: { published: true },
      compareVersion: VERSION,
      targets: [
        { target: "client", diff: EMPTY_DIFF, contentIdentical: true },
        { target: "server", diff: null, contentIdentical: false, error: "HTTP 500 " },
      ],
      publishConflict: null,
      publishConflictFields: [],
      publishConflictError: "server manifest: HTTP 500",
    };

    const output = printed(comparison);

    expect(output.warnings).toEqual([
      "v2.3.33 is already published; publish conflicts could not be fully checked (server manifest: HTTP 500).",
    ]);
  });

  test("reports an unknown publish status with the reason and does not claim a conflict check", () => {
    const comparison: PortalComparison = {
      portalUrl: PORTAL,
      channel: "stable",
      localVersion: VERSION,
      channels: { dev: VERSION, beta: VERSION, stable: VERSION },
      channelErrors: {},
      localPublished: null,
      localPublishedError: "HTTP 503 Service Unavailable",
      compareVersion: "2.3.32",
      targets: [],
      publishConflict: null,
      publishConflictFields: [],
    };

    const output = printed(comparison);

    expect(output.logs).toContain(" Local version on Portal: unknown (HTTP 503 Service Unavailable)");
    expect(output.warnings).toEqual([
      "v2.3.33 publish status is unknown (HTTP 503 Service Unavailable); publish conflicts were not checked.",
    ]);
  });

  test("lists unavailable channels with their reasons on the skipped line", () => {
    const comparison: PortalComparison = {
      portalUrl: PORTAL,
      channel: "stable",
      localVersion: VERSION,
      channels: { dev: VERSION, beta: null, stable: null },
      channelErrors: { beta: "HTTP 500", stable: "HTTP 404" },
      localPublished: null,
      localPublishedError: "HTTP 500",
      compareVersion: null,
      targets: [],
      publishConflict: null,
      publishConflictFields: [],
      error: "Portal channel 'stable' is unavailable: HTTP 404",
    };

    const output = printed(comparison);

    expect(output.logs).toContain(" Portal channels:  dev=2.3.33, beta=unavailable, stable=unavailable");
    expect(output.warnings).toEqual([
      "[Portal] Comparison skipped: Portal channel 'stable' is unavailable: HTTP 404. Other unavailable channels: beta: HTTP 500",
      "v2.3.33 publish status is unknown (HTTP 500); publish conflicts were not checked.",
    ]);
  });

  test("prints the revoked state in the local version line and warns that publishing is rejected", () => {
    const comparison: PortalComparison = {
      portalUrl: PORTAL,
      channel: "stable",
      localVersion: VERSION,
      channels: { dev: VERSION, beta: VERSION, stable: VERSION },
      channelErrors: {},
      localPublished: { published: true, revoked: true },
      compareVersion: VERSION,
      targets: [
        { target: "client", diff: EMPTY_DIFF, contentIdentical: true },
        { target: "server", diff: EMPTY_DIFF, contentIdentical: true },
      ],
      publishConflict: true,
      publishConflictFields: ["status"],
    };

    const output = printed(comparison);

    expect(output.logs).toContain(" Local version on Portal: published (revoked)");
    expect(output.warnings).toEqual([
      "⚠ v2.3.33 is revoked on the Portal; publishing it will be rejected (409). Bump [pack] version in pack.toml before publishing.",
    ]);
  });
});

describe("diffManifests console output", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lampasctl-diff-test-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("prints the summary and the added, removed, and updated file lines", async () => {
    const from = manifest("client", [
      file("mods/keep.jar", 100, "keep-hash"),
      file("mods/bump.jar", 200, "bump-old"),
      file("mods/gone.jar", 100, "gone-hash"),
    ], {}, OLDER_VERSION);
    const to = manifest("client", [
      file("mods/keep.jar", 100, "keep-hash"),
      file("mods/bump.jar", 260, "bump-new"),
      file("mods/new.jar", 500, "new-hash"),
    ]);
    const fromPath = path.join(dir, "from.json");
    const toPath = path.join(dir, "to.json");
    fs.writeFileSync(fromPath, JSON.stringify(from), "utf-8");
    fs.writeFileSync(toPath, JSON.stringify(to), "utf-8");

    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await diffManifests({ fromManifestPath: fromPath, toManifestPath: toPath });
    } finally {
      log.mockRestore();
    }

    expect(logs).toContain(" Pack Manifest Diff: 2.3.32 -> 2.3.33 (client)");
    expect(logs).toContain("  + mods/new.jar (500 B)");
    expect(logs).toContain("  - mods/gone.jar (100 B)");
    expect(logs).toContain("  ~ mods/bump.jar (200 B -> 260 B, delta: +60 B)");
    expect(logs).toContain(" Summary: +1 added, -1 removed, ~1 updated.");
    // 500 - 100 + 60
    expect(logs).toContain(" Net Size Delta: +460 B");
  });
});
