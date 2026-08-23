import * as http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { shell } from "electron";
import { ConfigManager } from "./config";
import type { UserProfile } from "./types";

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePkce() {
  const verifier = base64Url(randomBytes(32));
  const hash = createHash("sha256").update(verifier).digest();
  const challenge = base64Url(hash);
  return { verifier, challenge };
}

export class LauncherAuth {
  static async loginWithPortal(portalUrlOverride?: string): Promise<{ token: string; user: UserProfile }> {
    const config = ConfigManager.get();
    const portalUrl = (portalUrlOverride || config.portalUrl || "https://dev.lampas.town").replace(/\/+$/, "");
    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString("hex");

    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url || "", `http://${req.headers.host}`);
          if (reqUrl.pathname === "/callback") {
            const code = reqUrl.searchParams.get("code");
            const returnedState = reqUrl.searchParams.get("state");

            if (!code || returnedState !== state) {
              res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
              res.end("<h3>Authentication Failed: Invalid code or state mismatch.</h3>");
              server.close();
              reject(new Error("State mismatch or missing auth code"));
              return;
            }

            // Render success page in browser
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`
              <!DOCTYPE html>
              <html>
                <head>
                  <title>Lampas Launcher - Logged In</title>
                  <style>
                    body { background: #030712; color: #f9fafb; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                    .card { background: #111827; border: 1px solid #1f2937; padding: 2.5rem; border-radius: 1.5rem; text-align: center; max-width: 400px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
                    .check { color: #10b981; font-size: 3rem; margin-bottom: 0.5rem; }
                    h2 { margin: 0 0 0.5rem 0; font-size: 1.25rem; font-weight: 700; }
                    p { color: #9ca3af; font-size: 0.875rem; margin: 0; }
                  </style>
                </head>
                <body>
                  <div class="card">
                    <div class="check">✓</div>
                    <h2>Logged in to Lampas!</h2>
                    <p>You can close this tab and return to the launcher.</p>
                  </div>
                  <script>setTimeout(() => window.close(), 2500);</script>
                </body>
              </html>
            `);

            server.close();

            // Exchange authorization code for token
            const exchangeUrl = `${portalUrl}/api/v1/auth/exchange`;
            const resp = await fetch(exchangeUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code, code_verifier: verifier }),
            });

            if (!resp.ok) {
              let errMsg = `Token exchange failed (${resp.status})`;
              try {
                const errJson = await resp.json();
                if (errJson?.error) errMsg = errJson.error;
              } catch {
                try {
                  const errText = await resp.text();
                  if (errText) errMsg = `${errMsg}: ${errText}`;
                } catch {}
              }
              throw new Error(errMsg);
            }

            const json = await resp.json();
            const user = json.user;
            if (!user?.minecraftUuid || user.minecraftUuid === "00000000-0000-0000-0000-000000000000" || !user?.minecraftUsername) {
              throw new Error("Minecraft account not bound: Please link your Minecraft Java account on the Lampas Portal dashboard.");
            }

            ConfigManager.set({
              token: json.token,
              refreshToken: json.refreshToken || undefined,
              minecraftAccessToken: user?.minecraftAccessToken || json.minecraftAccessToken,
            });

            resolve({
              token: json.token,
              user,
            });
          }
        } catch (err: any) {
          server.close();
          reject(err);
        }
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as any;
        const port = address.port;
        const authUrl = `${portalUrl}/auth/launcher?code_challenge=${encodeURIComponent(challenge)}&port=${port}&state=${encodeURIComponent(state)}`;
        shell.openExternal(authUrl);
      });

      // Timeout after 3 minutes
      setTimeout(() => {
        server.close();
        reject(new Error("Login timed out after 3 minutes"));
      }, 180000);
    });
  }

  static async refreshSession(portalUrlOverride?: string): Promise<{ valid: boolean; user?: UserProfile; token?: string }> {
    const config = ConfigManager.get();
    if (!config.token && !config.refreshToken) {
      return { valid: false };
    }

    const portalUrl = (portalUrlOverride || config.portalUrl || "https://dev.lampas.town").replace(/\/+$/, "");

    // 1. Attempt token refresh via /api/v1/auth/refresh
    try {
      const refreshUrl = `${portalUrl}/api/v1/auth/refresh`;
      const resp = await fetch(refreshUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        },
        body: JSON.stringify({
          refreshToken: config.refreshToken,
          token: config.token,
        }),
      });

      if (resp.ok) {
        const json = await resp.json();
        const user = json.user;

        if (!user?.minecraftUuid || user.minecraftUuid === "00000000-0000-0000-0000-000000000000" || !user?.minecraftUsername) {
          ConfigManager.set({ token: undefined, refreshToken: undefined, minecraftAccessToken: undefined });
          return { valid: false };
        }

        const newToken = json.token || config.token;
        const newRefreshToken = json.refreshToken || config.refreshToken;
        const newMcToken = user?.minecraftAccessToken || json.minecraftAccessToken || config.minecraftAccessToken;

        ConfigManager.set({
          token: newToken,
          refreshToken: newRefreshToken,
          minecraftAccessToken: newMcToken,
        });

        return {
          valid: true,
          token: newToken,
          user,
        };
      }
    } catch {
      // Fall through to verifySession
    }

    // 2. Fallback to /api/v1/auth/verify
    return this.verifySession(portalUrl);
  }

  static async verifySession(portalUrlOverride?: string): Promise<{ valid: boolean; user?: UserProfile }> {
    const config = ConfigManager.get();
    if (!config.token && !config.refreshToken) {
      return { valid: false };
    }

    const portalUrl = (portalUrlOverride || config.portalUrl || "https://dev.lampas.town").replace(/\/+$/, "");
    const verifyUrl = `${portalUrl}/api/v1/auth/verify`;

    try {
      const resp = await fetch(verifyUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
        },
      });

      if (!resp.ok) {
        // If 401 and refresh token exists, attempt refresh
        if (resp.status === 401 && config.refreshToken) {
          try {
            const refreshUrl = `${portalUrl}/api/v1/auth/refresh`;
            const refreshResp = await fetch(refreshUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ refreshToken: config.refreshToken }),
            });
            if (refreshResp.ok) {
              const json = await refreshResp.json();
              const user = json.user;
              if (!user?.minecraftUuid || user.minecraftUuid === "00000000-0000-0000-0000-000000000000" || !user?.minecraftUsername) {
                ConfigManager.set({ token: undefined, refreshToken: undefined, minecraftAccessToken: undefined });
                return { valid: false };
              }
              ConfigManager.set({
                token: json.token,
                refreshToken: json.refreshToken || config.refreshToken,
                minecraftAccessToken: user?.minecraftAccessToken || json.minecraftAccessToken,
              });
              return { valid: true, user };
            }
          } catch {}
        }

        ConfigManager.set({ token: undefined, refreshToken: undefined, minecraftAccessToken: undefined });
        return { valid: false };
      }

      const json = await resp.json();
      const user = json.user;
      if (!json.valid || !user?.minecraftUuid || user.minecraftUuid === "00000000-0000-0000-0000-000000000000" || !user?.minecraftUsername) {
        ConfigManager.set({ token: undefined, refreshToken: undefined, minecraftAccessToken: undefined });
        return { valid: false };
      }

      if (user?.minecraftAccessToken) {
        ConfigManager.set({
          minecraftAccessToken: user.minecraftAccessToken,
        });
      }
      return {
        valid: true,
        user,
      };
    } catch {
      return { valid: false };
    }
  }

  static logout() {
    ConfigManager.set({ token: undefined, refreshToken: undefined, minecraftAccessToken: undefined });
  }
}
