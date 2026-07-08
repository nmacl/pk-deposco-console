import axios from 'axios';
import { ipv4Agent } from './auth.js';
import type { DeposcoItem } from './types.js';

export interface DeposcoConfig {
  authUrl: string;
  apiBase: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  env: string;
  company: string;
}

interface DeposcoTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;

// Deposco uses the OAuth2 refresh_token grant for client apps. The refresh_token
// is generated when a Deposco user installs the app in an environment (one-time
// authorization-code flow) and is stable until the app config changes in the dev
// portal. Access tokens last ~1 hour; we cache them in-process.
export async function getDeposcoToken(cfg: DeposcoConfig): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt > now + 60_000) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: cfg.refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });

  const resp = await axios.post<DeposcoTokenResponse>(cfg.authUrl, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15_000,
    httpsAgent: ipv4Agent,
  });

  cached = {
    token: resp.data.access_token,
    expiresAt: now + resp.data.expires_in * 1000,
  };
  return cached.token;
}

export async function postItem(
  cfg: DeposcoConfig,
  payload: DeposcoItem,
): Promise<unknown> {
  const token = await getDeposcoToken(cfg);
  const resp = await axios.post(`${cfg.apiBase}/items`, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 30_000,
    httpsAgent: ipv4Agent,
  });
  return resp.data;
}

export async function getItemByNumber(
  cfg: DeposcoConfig,
  number: string,
): Promise<unknown> {
  const token = await getDeposcoToken(cfg);
  const resp = await axios.get(`${cfg.apiBase}/items`, {
    params: { number },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15_000,
    httpsAgent: ipv4Agent,
  });
  return resp.data;
}
