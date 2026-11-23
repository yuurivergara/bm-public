import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { EmptyState, Loading } from './components/ui';
import { AuthProvider, useAuth } from './lib/auth';
import type { Permission } from './lib/types';
import { CampaignDetailPage } from './pages/CampaignDetail';
import { CampaignsPage } from './pages/Campaigns';
import { ImportWizardPage } from './pages/ImportWizard';
import { LoginPage } from './pages/Login';
import { NewCampaignPage } from './pages/NewCampaign';
import { NumbersPage } from './pages/Numbers';
import { TenantDetailPage } from './pages/TenantDetail';
import { TenantsPage } from './pages/Tenants';
import { UsersPage } from './pages/Users';

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!me) {
    const from = location.pathname + location.search;
    return <Navigate to="/login" replace state={{ from }} />;
  }
  return <>{children}</>;
}

function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const { can } = useAuth();
  if (!can(permission)) {
    return (
      <EmptyState
        title="Sem acesso"
        description="Seu usuário não tem permissão para ver esta página. Fale com o dono da conta."
      />
    );
  }
  return <>{children}</>;
}

function NotFound() {
  return (
    <EmptyState title="Página não encontrada" description="Confira o endereço ou use o menu." />
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route index element={<Navigate to="/clientes" replace />} />
            <Route path="clientes" element={<TenantsPage />} />
            <Route path="clientes/:tenantId/importar" element={<ImportWizardPage />} />
            <Route path="clientes/:tenantId/:tab?" element={<TenantDetailPage />} />
            <Route path="disparos" element={<CampaignsPage />} />
            <Route path="disparos/novo" element={<NewCampaignPage />} />
            <Route path="disparos/:tenantId/:campaignId" element={<CampaignDetailPage />} />
            <Route
              path="numeros"
              element={
                <RequirePermission permission="numbers.manage">
                  <NumbersPage />
                </RequirePermission>
              }
            />
            <Route
              path="usuarios"
              element={
                <RequirePermission permission="users.manage">
                  <UsersPage />
                </RequirePermission>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
