import { type ReactNode, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ROLE_LABELS } from '../lib/labels';
import type { Permission } from '../lib/types';
import { IconClients, IconLogout, IconMenu, IconPhone, IconSend, IconUsers } from './icons';
import { cx } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  permission: Permission;
}

const NAV: NavItem[] = [
  { to: '/clientes', label: 'Clientes', icon: <IconClients />, permission: 'tenants.read' },
  { to: '/disparos', label: 'Disparos', icon: <IconSend />, permission: 'campaigns.read' },
  { to: '/numeros', label: 'Números', icon: <IconPhone />, permission: 'numbers.manage' },
  { to: '/usuarios', label: 'Usuários', icon: <IconUsers />, permission: 'users.manage' },
];

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 px-2">
      <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-on-accent">
        <IconSend className="size-4" />
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold text-fg">BM Pública</span>
        <span className="block text-xs text-muted">Painel de disparos</span>
      </span>
    </Link>
  );
}

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useAuth();
  return (
    <nav className="space-y-1" aria-label="Principal">
      {NAV.filter((n) => can(n.permission)).map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          onClick={onNavigate}
          className={({ isActive }) =>
            cx(
              'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
              isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-subtle hover:text-fg',
            )
          }
        >
          {n.icon}
          {n.label}
        </NavLink>
      ))}
    </nav>
  );
}

function UserBox() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-subtle text-sm font-semibold text-fg">
        {me.user.name.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">{me.user.name}</p>
        <p className="truncate text-xs text-muted">
          {ROLE_LABELS[me.user.role]?.text ?? me.user.role}
        </p>
      </div>
      <button
        type="button"
        title="Sair"
        aria-label="Sair"
        disabled={busy}
        className="rounded-md p-1.5 text-muted hover:bg-subtle hover:text-fg"
        onClick={async () => {
          setBusy(true);
          try {
            await logout();
          } finally {
            navigate('/login', { replace: true });
          }
        }}
      >
        <IconLogout />
      </button>
    </div>
  );
}

export function Layout() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  // fecha o menu do celular ao trocar de página
  // biome-ignore lint/correctness/useExhaustiveDependencies: dispara só na mudança de rota
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="min-h-dvh lg:flex">
      {/* Barra lateral (computador) */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col justify-between border-r border-line bg-canvas p-4 lg:flex">
        <div className="space-y-6">
          <Brand />
          <Nav />
        </div>
        <UserBox />
      </aside>

      {/* Barra superior (celular/tablet) */}
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-canvas/95 px-4 py-3 backdrop-blur lg:hidden">
        <Brand />
        <button
          type="button"
          className="rounded-lg p-2 text-fg hover:bg-subtle"
          aria-label={open ? 'Fechar menu' : 'Abrir menu'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <IconMenu />
        </button>
      </header>
      {open && (
        <div className="space-y-4 border-b border-line bg-canvas px-4 pb-4 lg:hidden">
          <Nav onNavigate={() => setOpen(false)} />
          <UserBox />
        </div>
      )}

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
