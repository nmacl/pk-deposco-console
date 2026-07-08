import axios from 'axios';
import https from 'node:https';

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface BcAuthConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

// The VPN blocks IPv6. Force IPv4 so Node doesn't waste time on
// EHOSTUNREACH/ETIMEDOUT attempts against unroutable IPv6 addresses.
export const ipv4Agent = new https.Agent({ family: 4, keepAlive: true });

let cached: CachedToken | null = null;

const TOKEN_RETRIES = 3;
const TOKEN_TIMEOUT_MS = 30_000;

export async function getBcToken(config: BcAuthConfig): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt > now + 60_000) {
    return cached.token;
  }

  const tokenUrl = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: 'https://api.businesscentral.dynamics.com/.default',
  });

  let lastErr: unknown;
  for (let attempt = 1; attempt <= TOKEN_RETRIES; attempt++) {
    try {
      const resp = await axios.post<TokenResponse>(tokenUrl, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: TOKEN_TIMEOUT_MS,
        httpsAgent: ipv4Agent,
      });
      cached = {
        token: resp.data.access_token,
        expiresAt: now + resp.data.expires_in * 1000,
      };
      return cached.token;
    } catch (err) {
      lastErr = err;
      if (axios.isAxiosError(err) && err.response && err.response.status < 500) {
        throw new Error(
          `BC token request rejected: HTTP ${err.response.status} body=${JSON.stringify(err.response.data)}`,
        );
      }
      if (attempt < TOKEN_RETRIES) {
        const backoff = 3000 * attempt;
        console.log(`[auth] token attempt ${attempt}/${TOKEN_RETRIES} failed, retrying in ${backoff}ms ...`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(`BC token request failed after ${TOKEN_RETRIES} attempts`);
}
