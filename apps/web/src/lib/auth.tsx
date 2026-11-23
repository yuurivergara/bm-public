import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from 'react';
import { api, isUnauthenticated, onSessionExpired } from './api';
import type { Me, Permission } from './types';

export const ME_KEY = ['me'] as const;

/** Marca que a última saída foi por expiração (a tela de login mostra o aviso). */
let expiredFlag = false;
export function consumeExpiredFlag(): boolean {
  const v = expiredFlag;
  expiredFlag = false;
  return v;
}

interface AuthValue {
  me: Me | null | undefined;
  loading: boolean;
  can: (p: Permission) => boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

async function fetchMe(): Promise<Me | null> {
  try {
    return await api.get<Me>('/auth/me');
  } catch (err) {
    if (isUnauthenticated(err)) return null;
    throw err;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const meQuery = useQuery({ queryKey: ME_KEY, queryFn: fetchMe, staleTime: 5 * 60_000 });

  const reset = useCallback(() => {
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
    qc.setQueryData(ME_KEY, null);
  }, [qc]);

  useEffect(
    () =>
      onSessionExpired(() => {
        if (qc.getQueryData(ME_KEY)) expiredFlag = true;
        reset();
      }),
    [qc, reset],
  );

  const value = useMemo<AuthValue>(() => {
    const me = meQuery.data;
    const perms = new Set(me?.permissions ?? []);
    return {
      me,
      loading: meQuery.isPending,
      can: (p) => perms.has(p),
      logout: async () => {
        try {
          await api.post('/auth/logout');
        } finally {
          reset();
        }
      },
    };
  }, [meQuery.data, meQuery.isPending, reset]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth fora do AuthProvider');
  return v;
}
