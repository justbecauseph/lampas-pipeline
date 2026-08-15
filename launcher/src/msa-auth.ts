import { shell } from "electron";
import { ConfigManager } from "./config";

const DEFAULT_MSA_CLIENT_ID = "86c6c39b-d08e-4157-93a3-544bff1403a2";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
}

export interface MinecraftAccount {
  uuid: string;
  username: string;
  accessToken: string;
  msRefreshToken?: string;
  expiresAt: number;
  skinUrl?: string;
}

export class MsaAuth {
  private static async requestDeviceCode(clientId = DEFAULT_MSA_CLIENT_ID): Promise<DeviceCodeResponse> {
    const params = new URLSearchParams({
      client_id: clientId,
      scope: "XboxLive.signin offline_access",
    });

    const res = await fetch("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!res.ok) {
      throw new Error(`Failed to request device code (${res.status}): ${await res.text()}`);
    }

    return res.json();
  }

  private static async pollForMsToken(
    clientId: string,
    deviceCode: string,
    intervalSec: number
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const tokenUrl = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
    const startTime = Date.now();
    const timeoutMs = 15 * 60 * 1000; // 15 minutes

    while (Date.now() - startTime < timeoutMs) {
      await new Promise((r) => setTimeout(r, (intervalSec || 5) * 1000));

      const params = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: deviceCode,
      });

      const res = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });

      const json = await res.json();

      if (json.access_token) {
        return {
          accessToken: json.access_token,
          refreshToken: json.refresh_token,
          expiresIn: json.expires_in,
        };
      }

      if (json.error === "authorization_pending") {
        continue;
      }

      if (json.error === "slow_down") {
        intervalSec += 5;
        continue;
      }

      throw new Error(`Microsoft Login Error: ${json.error_description || json.error}`);
    }

    throw new Error("Microsoft login timed out.");
  }

  private static async authenticateXboxLive(msAccessToken: string): Promise<{ token: string; userHash: string }> {
    const res = await fetch("https://user.auth.xboxlive.com/user/authenticate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        Properties: {
          AuthMethod: "RPS",
          SiteName: "user.auth.xboxlive.com",
          RpsTicket: `d=${msAccessToken}`,
        },
        RelyingParty: "http://auth.xboxlive.com",
        TokenType: "JWT",
      }),
    });

    if (!res.ok) {
      throw new Error(`Xbox Live authentication failed: ${await res.text()}`);
    }

    const data = await res.json();
    const userHash = data.DisplayClaims?.xui?.[0]?.uhs;
    if (!userHash) {
      throw new Error("Failed to extract Xbox user hash.");
    }

    return {
      token: data.Token,
      userHash,
    };
  }

  private static async authenticateXsts(xblToken: string): Promise<string> {
    const res = await fetch("https://xsts.auth.xboxlive.com/xsts/authorize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        Properties: {
          SandboxId: "RETAIL",
          UserTokens: [xblToken],
        },
        RelyingParty: "rp://api.minecraftservices.com/",
        TokenType: "JWT",
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      if (errData.XErr === 2148916233) {
        throw new Error("This Microsoft account does not have an Xbox account.");
      } else if (errData.XErr === 2148916238) {
        throw new Error("This account is under 18 and requires adult verification in Xbox Family.");
      }
      throw new Error(`XSTS authentication failed (${res.status}): ${JSON.stringify(errData)}`);
    }

    const data = await res.json();
    return data.Token;
  }

  private static async loginWithMinecraftServices(userHash: string, xstsToken: string): Promise<{ token: string; expiresIn: number }> {
    const res = await fetch("https://api.minecraftservices.com/authentication/login_with_xbox", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        identityToken: `XBL3.0 x=${userHash};${xstsToken}`,
      }),
    });

    if (!res.ok) {
      throw new Error(`Minecraft Services login failed: ${await res.text()}`);
    }

    const data = await res.json();
    return {
      token: data.access_token,
      expiresIn: data.expires_in,
    };
  }

  private static async fetchMinecraftProfile(mcAccessToken: string): Promise<{ id: string; name: string; skinUrl?: string }> {
    const res = await fetch("https://api.minecraftservices.com/minecraft/profile", {
      headers: {
        Authorization: `Bearer ${mcAccessToken}`,
      },
    });

    if (!res.ok) {
      if (res.status === 404) {
        throw new Error("This Microsoft Account does not own Minecraft Java Edition.");
      }
      throw new Error(`Failed to fetch Minecraft profile: ${await res.text()}`);
    }

    const profile = await res.json();
    const skinUrl = profile.skins?.find((s: any) => s.state === "ACTIVE")?.url;

    return {
      id: profile.id,
      name: profile.name,
      skinUrl,
    };
  }

  static async loginWithDeviceCode(
    onPrompt: (prompt: { userCode: string; verificationUri: string }) => void
  ): Promise<MinecraftAccount> {
    const deviceCodeData = await this.requestDeviceCode();

    onPrompt({
      userCode: deviceCodeData.user_code,
      verificationUri: deviceCodeData.verification_uri,
    });

    // Open browser for user
    shell.openExternal(deviceCodeData.verification_uri);

    // Poll for Microsoft Access Token
    const msTokens = await this.pollForMsToken(
      DEFAULT_MSA_CLIENT_ID,
      deviceCodeData.device_code,
      deviceCodeData.interval
    );

    // Xbox Live -> XSTS -> Minecraft Token -> Profile
    const { token: xblToken, userHash } = await this.authenticateXboxLive(msTokens.accessToken);
    const xstsToken = await this.authenticateXsts(xblToken);
    const mcAuth = await this.loginWithMinecraftServices(userHash, xstsToken);
    const profile = await this.fetchMinecraftProfile(mcAuth.token);

    const account: MinecraftAccount = {
      uuid: profile.id,
      username: profile.name,
      accessToken: mcAuth.token,
      msRefreshToken: msTokens.refreshToken,
      expiresAt: Date.now() + mcAuth.expiresIn * 1000,
      skinUrl: profile.skinUrl,
    };

    // Save in Config
    ConfigManager.set({
      token: mcAuth.token,
      offlineUsername: profile.name,
    });

    return account;
  }
}
