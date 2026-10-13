import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { Admin } from './pages/Admin';
import { Approvals } from './pages/Approvals';
import { ChangePassword, Login, TotpPrompt } from './pages/Auth';
import { Day } from './pages/Day';
import { Home } from './pages/Home';
import { Install } from './pages/Install';
import { Inventory } from './pages/Inventory';
import { Investor } from './pages/Investor';
import { MoneyPage } from './pages/Money';
import { Notifications } from './pages/Notifications';
import { Owner } from './pages/Owner';
import { Pos } from './pages/Pos';
import { Reports } from './pages/Reports';
import { Settings } from './pages/Settings';
import { Spend } from './pages/Spend';
import { useSession } from './session';

export function App() {
  const s = useSession();
  if (s.loading) return <Loading />;
  if (!s.me) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  if (s.me.totpRequired) return <TotpPrompt />;
  if (s.me.mustChangePassword) return <ChangePassword first />;
  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="pos" element={<Pos />} />
        <Route path="day" element={<Day />} />
        <Route path="days/:id" element={<Day />} />
        <Route path="spend" element={<Spend />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="money/*" element={<MoneyPage />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="approvals/:id" element={<Approvals />} />
        <Route path="reports" element={<Reports />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="investor" element={<Investor />} />
        <Route path="admin" element={<Admin />} />
        <Route path="owner" element={<Owner />} />
        <Route path="settings" element={<Settings />} />
        <Route path="install" element={<Install />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
