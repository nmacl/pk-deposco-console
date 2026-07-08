/**
 * Shared config loaders for the sync workers (po/co/to). Previously duplicated
 * verbatim in each monolith.
 */
import type { BcAuthConfig } from '../auth.js';
import type { DeposcoConfig } from '../deposco.js';

export interface SyncBcConfig extends BcAuthConfig {
  environment: string;
  company: string;
}

export function loadBcConfig(): SyncBcConfig {
  return {
    tenantId: process.env.BC_TENANT_ID!,
    clientId: process.env.BC_CLIENT_ID!,
    clientSecret: process.env.BC_CLIENT_SECRET!,
    environment: process.env.BC_ENVIRONMENT!,
    company: process.env.BC_COMPANY!,
  };
}

export function loadDeposcoConfig(): DeposcoConfig {
  return {
    authUrl: process.env.DEPOSCO_AUTH_URL!,
    apiBase: process.env.DEPOSCO_API_BASE!,
    clientId: process.env.DEPOSCO_CLIENT_ID!,
    clientSecret: process.env.DEPOSCO_CLIENT_SECRET!,
    refreshToken: process.env.DEPOSCO_REFRESH_TOKEN!,
    env: process.env.DEPOSCO_ENV!,
    company: process.env.DEPOSCO_COMPANY!,
  };
}
