import React from 'react';
import { useTranslation } from 'react-i18next';
import { Routes, Route, Navigate } from 'react-router-dom';

import { AuthProvider } from './context/AuthContext';
import { RealtimeProvider } from './context/RealtimeContext';
import { CallProvider } from './context/CallContext';
import RequireAuth from './components/RequireAuth';
import Navbar from './components/Navbar';
import IncomingCallDialog from './components/IncomingCallDialog';
import CallPanel from './components/CallPanel';
import LoginPage from './pages/LoginPage';
import MessengerPage from './pages/MessengerPage';
import DashboardPage from './pages/DashboardPage';
import ProfilePage from './pages/ProfilePage';
import { useAuth } from './context/auth';

/**
 * Where "/" goes, which depends on who is asking: the conversation list for an
 * ordinary account, the dashboard for anybody with something to administer.
 * Kept as a component rather than a redirect in the route table because the
 * answer is not known until the session is.
 */
function Home() {
  const { homePath } = useAuth();
  return <Navigate to={homePath} replace />;
}

export default function App() {
  const { t } = useTranslation();

  return (
    <AuthProvider>
      {/* Inside the auth provider: the socket is reopened when the identity
          changes, and the header needs the unread count on every page. */}
      <RealtimeProvider>
      {/* Inside the socket provider, and outside the routes: a call has to
          ring wherever the person is, and survive them navigating. */}
      <CallProvider>
      <div className="app-root">
        <Navbar />
        <IncomingCallDialog />
        <CallPanel />
        <main className="main-content">
          <Routes>
            <Route path="/login" element={<LoginPage />} />

            {/* Everything below redirects to /login until there is a session.

                "/" is not a page: it sends each account to whichever of the two
                is theirs. The dashboard routes then check for themselves, so an
                ordinary account typing the address is turned away rather than
                shown a page with nothing on it — hiding the header link is only
                half of an access rule. */}
            <Route path="/" element={<RequireAuth><Home /></RequireAuth>} />
            <Route path="/chats" element={<RequireAuth><MessengerPage /></RequireAuth>} />
            <Route
              path="/dashboard"
              element={<RequireAuth administrative><DashboardPage /></RequireAuth>}
            />
            <Route
              path="/dashboard/:model"
              element={<RequireAuth administrative><DashboardPage /></RequireAuth>}
            />
            <Route path="/profile" element={<RequireAuth><ProfilePage /></RequireAuth>} />

            {/* Legacy links from before the dashboard existed. */}
            <Route path="/admin/users" element={<Navigate to="/dashboard/users" replace />} />
            <Route path="/admin/roles" element={<Navigate to="/dashboard/roles" replace />} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <footer className="footer">{t('common.footer')}</footer>
      </div>
      </CallProvider>
      </RealtimeProvider>
    </AuthProvider>
  );
}
