import { useCallback, useEffect, useState } from "react";

export type AuthStatus = "checking" | "authenticated" | "unauthenticated";

export interface UseAuthReturn {
  status: AuthStatus;
  error: string | null;
  isLoggingIn: boolean;
  checkAuth: () => Promise<void>;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  markUnauthorized: () => void;
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const bodyText = await response.text();
    if (!bodyText) {
      return fallback;
    }

    try {
      const json = JSON.parse(bodyText) as { error?: string };
      return json.error || bodyText;
    } catch {
      return bodyText;
    }
  } catch {
    return fallback;
  }
}

export function useAuth(): UseAuthReturn {
  const [status, setStatus] = useState<AuthStatus>("checking");
  const [error, setError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const forceResetToRoot = useCallback((): boolean => {
    const { pathname, search, hash } = window.location;
    if (pathname !== "/" || search !== "" || hash !== "") {
      window.location.replace("/");
      return true;
    }
    return false;
  }, []);

  const checkAuth = useCallback(async () => {
    setStatus("checking");
    setError(null);

    try {
      const response = await fetch("/api/auth/check");
      if (response.ok) {
        setStatus("authenticated");
        return;
      }

      if (response.status === 401) {
        if (forceResetToRoot()) {
          return;
        }
        setStatus("unauthenticated");
        return;
      }

      const message = await readErrorMessage(response, "Failed to check authentication status");
      setStatus("unauthenticated");
      setError(message);
    } catch (err) {
      setStatus("unauthenticated");
      setError(err instanceof Error ? err.message : "Failed to check authentication status");
    }
  }, [forceResetToRoot]);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    setError(null);
    setIsLoggingIn(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        setStatus("authenticated");
        return true;
      }

      const message = await readErrorMessage(response, "Login failed");
      setStatus("unauthenticated");
      setError(message);
      return false;
    } catch (err) {
      setStatus("unauthenticated");
      setError(err instanceof Error ? err.message : "Login failed");
      return false;
    } finally {
      setIsLoggingIn(false);
    }
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    // Keep the redirect/state reset behavior even if logout request fails.
    if (forceResetToRoot()) {
      return;
    }
    setError(null);
    setStatus("unauthenticated");
  }, [forceResetToRoot]);

  const markUnauthorized = useCallback(() => {
    if (forceResetToRoot()) {
      return;
    }
    setError(null);
    setStatus("unauthenticated");
  }, [forceResetToRoot]);

  return {
    status,
    error,
    isLoggingIn,
    checkAuth,
    login,
    logout,
    markUnauthorized,
  };
}
