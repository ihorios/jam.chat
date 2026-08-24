import { createContext, useContext } from 'react';

/**
 * Kept apart from CallContext.jsx so that file exports only a component —
 * mixing components and plain values in one module breaks Fast Refresh.
 */
export const CallContext = createContext(null);

export function useCall() {
  const context = useContext(CallContext);
  if (!context) throw new Error('useCall must be used inside a <CallProvider>.');
  return context;
}
