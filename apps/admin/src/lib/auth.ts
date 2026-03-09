import { useEffect, useState } from "react";
import { apiGet, apiPost } from "./api";

interface AuthState {
  authenticated: boolean;
  loading: boolean;
  user: string | null;
}

interface SessionResponse {
  authenticated: boolean;
  user: string | null;
}

export function useAuth(): AuthState & {
  login: (user: string, pass: string) => Promise<boolean>;
  logout: () => Promise<void>;
} {
  const [state, setState] = useState<AuthState>({
    authenticated: false,
    loading: true,
    user: null,
  });

  useEffect(() => {
    void refreshSession();
  }, []);

  async function refreshSession(): Promise<void> {
    try {
      const session = await apiGet<SessionResponse>("/auth/session");
      setState({
        authenticated: session.authenticated,
        loading: false,
        user: session.user,
      });
    } catch {
      setState({ authenticated: false, loading: false, user: null });
    }
  }

  async function login(user: string, pass: string): Promise<boolean> {
    setState((current) => ({ ...current, loading: true }));

    try {
      const session = await apiPost<SessionResponse>("/auth/login", {
        pass,
        user,
      });
      setState({
        authenticated: session.authenticated,
        loading: false,
        user: session.user,
      });
      return session.authenticated;
    } catch {
      setState({ authenticated: false, loading: false, user: null });
      return false;
    }
  }

  async function logout(): Promise<void> {
    try {
      await apiPost<void>("/auth/logout");
    } finally {
      setState({ authenticated: false, loading: false, user: null });
    }
  }

  return { ...state, login, logout };
}
