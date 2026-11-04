import { z } from "zod";
import { IntegrationError, fetchJson, parseResponse, type JsonRequestInit } from "./integration-http.js";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Drafts and sends (compose), search (readonly), and calendar event writes. */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().positive().default(3_600),
});

/** Refresh this long before Google's stated expiry. */
const EXPIRY_MARGIN_MS = 60_000;

interface GoogleClientOptions {
  credentials: GoogleCredentials;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Exchanges the founders' OAuth refresh token for short-lived access tokens,
 * caches each until shortly before it expires, and signs Google API calls.
 * Tokens are never logged or put in error messages.
 */
export class GoogleClient {
  private cached: { token: string; expiresAt: number } | undefined;
  private pending: Promise<string> | undefined;

  public constructor(private readonly options: GoogleClientOptions) {}

  public async accessToken(): Promise<string> {
    const now = this.now();
    if (this.cached && this.cached.expiresAt > now) return this.cached.token;
    this.pending ??= this.refresh().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** Calls a Google REST endpoint; a 401 drops the cached token and retries once. */
  public async request(service: string, url: string, init: JsonRequestInit = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.accessToken();
      try {
        return await fetchJson(service, url, {
          ...init,
          ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
          headers: { ...init.headers, Authorization: `Bearer ${token}` },
        });
      } catch (error) {
        if (attempt === 0 && error instanceof IntegrationError && error.status === 401) {
          this.cached = undefined;
          continue;
        }
        throw error;
      }
    }
  }

  private async refresh(): Promise<string> {
    const { clientId, clientSecret, refreshToken } = this.options.credentials;
    const startedAt = this.now();
    let payload: unknown;
    try {
      payload = await fetchJson("Google sign-in", GOOGLE_TOKEN_URL, {
        method: "POST",
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
        ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
      });
    } catch (error) {
      if (error instanceof IntegrationError && (error.status === 400 || error.status === 401)) {
        throw new IntegrationError(
          "Google",
          "Google sign-in was rejected (the refresh token may be revoked or expired); run `npm run google-auth` again",
          error.status,
        );
      }
      throw error;
    }
    const token = parseResponse("Google sign-in", tokenSchema, payload);
    this.cached = {
      token: token.access_token,
      expiresAt: startedAt + token.expires_in * 1_000 - EXPIRY_MARGIN_MS,
    };
    return token.access_token;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
