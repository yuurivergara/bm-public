import { Link } from 'react-router-dom';
import { CampaignsUnavailable, CampaignTable } from '../../components/CampaignTable';
import { IconPlus } from '../../components/icons';
import { buttonClass, EmptyState, ErrorAlert, Loading } from '../../components/ui';
import { isNotFound } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { sortCampaigns } from '../../lib/campaigns';
import { useCampaigns } from '../../lib/queries';

export function TenantCampaignsTab({ tenantId }: { tenantId: string }) {
  const { can } = useAuth();
  const campaigns = useCampaigns(tenantId);
  const newLink = can('campaigns.write') && (
    <Link className={buttonClass('primary')} to={`/disparos/novo?cliente=${tenantId}`}>
      <IconPlus className="size-4" /> Novo disparo
    </Link>
  );

  if (campaigns.isPending) return <Loading />;
  if (isNotFound(campaigns.error)) return <CampaignsUnavailable />;
  if (campaigns.error)
    return <ErrorAlert error={campaigns.error} retry={() => campaigns.refetch()} />;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">{newLink}</div>
      {campaigns.data.length === 0 ? (
        <EmptyState
          title="Nenhum disparo para este cliente ainda"
          description="Crie o primeiro disparo escolhendo a lista e o modelo aprovado."
        />
      ) : (
        <CampaignTable rows={sortCampaigns(campaigns.data).map((c) => ({ ...c, tenantId }))} />
      )}
    </div>
  );
}
