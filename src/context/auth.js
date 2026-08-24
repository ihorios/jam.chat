import { createContext, useContext } from 'react';

/**
 * Kept apart from AuthContext.jsx so that file exports only a component —
 * mixing components and plain values in one module breaks Fast Refresh.
 */
export const AuthContext = createContext(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an <AuthProvider>.');
  return context;
}
