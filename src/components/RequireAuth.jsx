import React from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '../context/auth';

/**
 * Gate for authenticated routes, and for the ones that also need the account to
 * have something to administer (`administrative`).
 *
 * This is a convenience, not a security boundary — the API enforces the same
 * rules server-side, so reaching a page around this component gets you one that
 * cannot load any data. What it is for is the other half of hiding a link: a
 * header without a Dashboard link still leaves /dashboard typeable, and an
 * account with nothing to manage there should not arrive at an empty page.
 */
export default function RequireAuth({ children, administrative = false }) {
  const { user, loading, canAdminister, homePath } = useAuth();
  const location = useLocation();
  const { t } = useTranslation();

  if (loading) return <div className="loading-state">{t('common.checkingSession')}</div>;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;

  // Sent to their own home rather than shown a refusal: for an ordinary account
  // this route does not exist as far as the app is concerned.
  if (administrative && !canAdminister) return <Navigate to={homePath} replace />;

  return children;
}
