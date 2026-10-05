import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { api, clearSessionUser, getUserId, setSessionUser, type Me, type PublicUser } from "./api";

interface Session {
  me: Me | null;
  users: PublicUser[];
  /** True when nobody is signed in: the shell shows the sign-in page. */
  signedOut: boolean;
  can: (permission: string) => boolean;
  switchUser: (id: string) => Promise<void>;
  signOut: () => void;
  refresh: () => Promise<void>;
  error: string | null;
}

const Ctx = createContext<Session>({
  me: null, users: [], signedOut: false, can: () => false, switchUser: async () => {}, signOut: () => {},
  refresh: async () => {}, error: null,
});

export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get<Me>("/me"));
      setSignedOut(false);
      setError(null);
    } catch (e) {
      // An unknown or deactivated user lands back on sign-in, not on an error page.
      clearSessionUser();
      setMe(null);
      setSignedOut(true);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const switchUser = useCallback(async (id: string) => {
    setSessionUser(id);
    await refresh();
  }, [refresh]);

  const signOut = useCallback(() => {
    clearSessionUser();
    setMe(null);
    setSignedOut(true);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setUsers(await api.get<PublicUser[]>("/users/public"));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (getUserId()) {
        await refresh();
      } else {
        setSignedOut(true);
      }
    })();
  }, [refresh]);

  const can = useCallback((p: string) => !!me?.permissions.includes(p), [me]);

  return (
    <Ctx.Provider value={{ me, users, signedOut, can, switchUser, signOut, refresh, error }}>
      {children}
    </Ctx.Provider>
  );
}

/** Fetch-on-mount with loading, error and reload. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { me } = useSession();

  const load = useCallback(async () => {
    if (!path || !me) return;
    setLoading(true);
    try {
      setData(await api.get<T>(path));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, me?.user.user_id, ...deps]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, error, loading, reload: load, setData };
}
