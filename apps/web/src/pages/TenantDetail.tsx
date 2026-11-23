import { Link, NavLink, useParams } from 'react-router-dom';
import { IconBack } from '../components/icons';
import { cx, ErrorAlert, Loading, PageHeader, StatusBadge } from '../components/ui';
import { useAuth } from '../lib/auth';
import { tenantStatus } from '../lib/labels';
import { useTenant } from '../lib/queries';
import type { Permission } from '../lib/types';
import { TenantCampaignsTab } from './tenant/CampaignsTab';
import { ConnectionTab } from './tenant/ConnectionTab';
import { ContactsTab } from './tenant/ContactsTab';
import { NumberTab } from './tenant/NumberTab';
import { OverviewTab } from './tenant/OverviewTab';
import { SuppressionsTab } from './tenant/SuppressionsTab';
import { TemplatesTab } from './tenant/TemplatesTab';

const TABS: { slug: string; label: string; permission: Permission }[] = [
  { slug: '', label: 'Visão geral', permission: 'tenants.read' },
  { slug: 'whatsapp', label: 'Conexão WhatsApp', permission: 'assets.read' },
  { slug: 'numero', label: 'Número', permission: 'numbers.read' },
  { slug: 'modelos', label: 'Modelos de mensagem', permission: 'templates.read' },
  { slug: 'contatos', label: 'Contatos', permission: 'contacts.read' },
  { slug: 'opt-out', label: 'Opt-out', permission: 'contacts.read' },
  { slug: 'disparos', label: 'Disparos', permission: 'campaigns.read' },
];

export function TenantDetailPage() {
  const { tenantId = '', tab = '' } = useParams();
  const { can } = useAuth();
  const tenant = useTenant(tenantId);

  if (tenant.isPending) return <Loading />;
  if (tenant.error) return <ErrorAlert error={tenant.error} retry={() => tenant.refetch()} />;
  const t = tenant.data;
  const tabs = TABS.filter((x) => can(x.permission));
  const current = tabs.find((x) => x.slug === tab) ?? tabs[0];

  return (
    <>
      <PageHeader
        back={
          <Link
            to="/clientes"
            className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
          >
            <IconBack className="size-4" /> Clientes
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {t.name}
            <StatusBadge label={tenantStatus(t.status)} />
          </span>
        }
        description={t.legalName ?? undefined}
      />

      <nav
        aria-label="Seções do cliente"
        className="-mx-4 mb-6 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0"
      >
        <ul className="flex min-w-max gap-1">
          {tabs.map((x) => (
            <li key={x.slug}>
              <NavLink
                end
                to={`/clientes/${tenantId}${x.slug ? `/${x.slug}` : ''}`}
                className={cx(
                  '-mb-px block border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap',
                  current?.slug === x.slug
                    ? 'border-accent text-accent'
                    : 'border-transparent text-muted hover:text-fg',
                )}
              >
                {x.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {current?.slug === '' && <OverviewTab tenant={t} />}
      {current?.slug === 'whatsapp' && <ConnectionTab tenantId={t.id} />}
      {current?.slug === 'numero' && <NumberTab tenantId={t.id} />}
      {current?.slug === 'modelos' && <TemplatesTab tenantId={t.id} />}
      {current?.slug === 'contatos' && <ContactsTab tenantId={t.id} />}
      {current?.slug === 'opt-out' && <SuppressionsTab tenantId={t.id} />}
      {current?.slug === 'disparos' && <TenantCampaignsTab tenantId={t.id} />}
    </>
  );
}
