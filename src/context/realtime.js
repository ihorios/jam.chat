import { createContext, useContext } from 'react';

/**
 * Kept apart from RealtimeContext.jsx so that file exports only a component —
 * mixing components and plain values in one module breaks Fast Refresh.
 */
export const RealtimeContext = createContext(null);

export function useRealtime() {
  const context = useContext(RealtimeContext);
  if (!context) throw new Error('useRealtime must be used inside a <RealtimeProvider>.');
  return context;
}
