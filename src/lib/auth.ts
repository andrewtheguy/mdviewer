import type { Request } from "express";
import bcrypt from "bcryptjs";

const SESSION_TTL_SECONDS = 60 * 60 * 24; // 1 day
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const PURGE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const COOKIE_NAME = "mdviewer_session";

interface SessionData {
  expiresAt: number;
  username: string;
}

interface AuthConfig {
  disabled: boolean;
  username: string;
  passwordHash: string;
}

const validTokens = new Map<string, SessionData>();
let authConfig: AuthConfig | null = null;

function isBcryptHash(value: string): boolean {
  return /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(value);
}

function purgeExpiredTokens(): void {
  const now = Date.now();
  for (const [token, data] of validTokens) {
    if (now >= data.expiresAt) {
      validTokens.delete(token);
    }
  }
}

setInterval(purgeExpiredTokens, PURGE_INTERVAL_MS).unref();

export function initAuthFromEnv(env: NodeJS.ProcessEnv = process.env): { disabled: boolean } {
  const disabled = env.AUTH_DISABLED === "true";

  if (disabled) {
    authConfig = {
      disabled: true,
      username: "",
      passwordHash: "",
    };
    return { disabled: true };
  }

  const encodedCredential = env.AUTH_CREDENTIAL_B64?.trim() || "";
  if (!encodedCredential) {
    throw new Error("AUTH_CREDENTIAL_B64 is required when auth is enabled");
  }

  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedCredential)) {
    throw new Error("AUTH_CREDENTIAL_B64 must be valid base64");
  }

  const decodedCredential = Buffer.from(encodedCredential, "base64").toString("utf-8");
  const separatorIndex = decodedCredential.indexOf(":");
  if (separatorIndex < 1 || separatorIndex === decodedCredential.length - 1) {
    throw new Error("AUTH_CREDENTIAL_B64 must decode to username:bcryptHash");
  }

  const username = decodedCredential.slice(0, separatorIndex).trim();
  const passwordHash = decodedCredential.slice(separatorIndex + 1);

  if (!username) {
    throw new Error("AUTH_CREDENTIAL_B64 contains an empty username");
  }

  if (!isBcryptHash(passwordHash)) {
    throw new Error("AUTH_CREDENTIAL_B64 must contain a bcrypt hash ($2a$, $2b$, or $2y$)");
  }

  authConfig = {
    disabled: false,
    username,
    passwordHash,
  };

  return { disabled: false };
}

export function isAuthDisabled(): boolean {
  if (authConfig === null) {
    throw new Error("Auth config not initialized");
  }
  return authConfig.disabled;
}

export async function verifyCredentials(username: string, password: string): Promise<boolean> {
  if (authConfig === null) {
    throw new Error("Auth config not initialized");
  }

  if (authConfig.disabled) {
    return true;
  }

  if (username !== authConfig.username) {
    return false;
  }

  return bcrypt.compare(password, authConfig.passwordHash);
}

export function createSession(username: string): string {
  purgeExpiredTokens();
  const token = crypto.randomUUID();
  validTokens.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, username });
  return token;
}

function isValidSession(token: string): boolean {
  const data = validTokens.get(token);
  if (data === undefined) {
    return false;
  }
  if (Date.now() >= data.expiresAt) {
    validTokens.delete(token);
    return false;
  }

  data.expiresAt = Date.now() + SESSION_TTL_MS;
  return true;
}

export function invalidateSession(token: string): void {
  validTokens.delete(token);
}

export function getSessionCookie(token: string, secure: boolean): string {
  let cookie = `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`;
  if (secure) {
    cookie += "; Secure";
  }
  return cookie;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function extractSessionToken(req: Request): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) {
      return rest.join("=");
    }
  }

  return null;
}

export function isRequestAuthenticated(req: Request): boolean {
  if (isAuthDisabled()) {
    return true;
  }

  const token = extractSessionToken(req);
  if (!token) {
    return false;
  }

  return isValidSession(token);
}
