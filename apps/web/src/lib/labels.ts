/** Rótulos em português simples para os estados vindos da API (cor + texto nos badges). */

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';

export interface Label {
  text: string;
  tone: Tone;
  hint?: string;
}

const pick = (map: Record<string, Label>, value: string | null | undefined): Label =>
  (value && map[value]) || { text: value || '—', tone: 'neutral' };

export const tenantStatus = (s: string) =>
  pick(
    {
      onboarding: { text: 'Em configuração', tone: 'info' },
      active: { text: 'Ativo', tone: 'ok' },
      paused: { text: 'Pausado', tone: 'warn' },
      offboarded: { text: 'Desligado', tone: 'neutral' },
    },
    s,
  );

export const templateStatus = (s: string) =>
  pick(
    {
      APPROVED: { text: 'Aprovado', tone: 'ok', hint: 'Pode ser usado em disparos' },
      PENDING: { text: 'Em análise', tone: 'warn', hint: 'A Meta costuma revisar em até 24 horas' },
      IN_APPEAL: { text: 'Em recurso', tone: 'warn' },
      REJECTED: { text: 'Reprovado', tone: 'danger' },
      PAUSED: { text: 'Pausado', tone: 'warn', hint: 'Pausado pela Meta por baixa qualidade' },
      DISABLED: { text: 'Desativado', tone: 'danger' },
      DELETED: { text: 'Excluído', tone: 'neutral' },
      PENDING_DELETION: { text: 'Excluindo', tone: 'neutral' },
    },
    s,
  );

export const templateCategory = (s: string | null) =>
  pick(
    {
      MARKETING: { text: 'Marketing', tone: 'neutral' },
      UTILITY: { text: 'Utilidade', tone: 'neutral' },
      AUTHENTICATION: { text: 'Autenticação', tone: 'neutral' },
    },
    s,
  );

export const campaignStatus = (s: string) =>
  pick(
    {
      draft: { text: 'Rascunho', tone: 'neutral' },
      running: { text: 'Enviando', tone: 'accent' },
      paused: { text: 'Pausado', tone: 'warn' },
      completed: { text: 'Concluído', tone: 'ok' },
      cancelled: { text: 'Cancelado', tone: 'neutral' },
      failed: { text: 'Falhou', tone: 'danger' },
    },
    s,
  );

export const recipientStatus = (s: string) =>
  pick(
    {
      pending: { text: 'Na fila', tone: 'neutral' },
      sent: { text: 'Enviada', tone: 'info' },
      delivered: { text: 'Entregue', tone: 'ok' },
      read: { text: 'Lida', tone: 'accent' },
      failed: { text: 'Falhou', tone: 'danger' },
      skipped: { text: 'Não enviada', tone: 'warn', hint: 'Pulada por regra (ex.: opt-out)' },
      uncertain: { text: 'Sem confirmação', tone: 'warn' },
    },
    s,
  );

export const RECIPIENT_STATUSES = [
  'pending',
  'sent',
  'delivered',
  'read',
  'failed',
  'skipped',
  'uncertain',
] as const;

export const importStatus = (s: string) =>
  pick(
    {
      uploaded: { text: 'Enviada', tone: 'info' },
      parsing: { text: 'Analisando', tone: 'info' },
      preview: { text: 'Aguardando confirmação', tone: 'warn' },
      confirming: { text: 'Criando lista', tone: 'info' },
      confirmed: { text: 'Concluída', tone: 'ok' },
      failed: { text: 'Falhou', tone: 'danger' },
      cancelled: { text: 'Cancelada', tone: 'neutral' },
    },
    s,
  );

export const inventoryStatus = (s: string) =>
  pick(
    {
      available: { text: 'Disponível', tone: 'ok' },
      verifying: { text: 'Em verificação', tone: 'info' },
      active: { text: 'Em uso', tone: 'accent' },
      quarantine: { text: 'Quarentena', tone: 'warn' },
      cancelled: { text: 'Cancelado', tone: 'neutral' },
    },
    s,
  );

export const phoneStatus = (s: string) =>
  pick(
    {
      connected: { text: 'Conectado', tone: 'ok' },
      pending: { text: 'Pendente', tone: 'warn' },
      flagged: { text: 'Sinalizado', tone: 'warn' },
      restricted: { text: 'Restrito', tone: 'danger' },
      disconnected: { text: 'Desconectado', tone: 'danger' },
    },
    s,
  );

export const qualityRating = (s: string | null) =>
  pick(
    {
      GREEN: { text: 'Qualidade alta', tone: 'ok' },
      YELLOW: { text: 'Qualidade média', tone: 'warn' },
      RED: { text: 'Qualidade baixa', tone: 'danger' },
      UNKNOWN: { text: 'Qualidade sem dados', tone: 'neutral' },
    },
    s ?? 'UNKNOWN',
  );

export const connectionStatus = (s: string) =>
  pick(
    {
      active: { text: 'Conectado', tone: 'ok' },
      broken: { text: 'Token com problema', tone: 'danger' },
      revoked: { text: 'Revogado', tone: 'neutral' },
    },
    s,
  );

export const registrationStatus = (s: string | null) =>
  pick(
    {
      added: { text: 'Adicionado à conta', tone: 'info' },
      code_requested: { text: 'Código solicitado', tone: 'warn' },
      code_verified: { text: 'Código confirmado', tone: 'info' },
      registered: { text: 'Pronto para enviar', tone: 'ok' },
      deregistered: { text: 'Desregistrado', tone: 'neutral' },
    },
    s,
  );

export const suppressionReason = (s: string) =>
  pick(
    {
      opt_out_keyword: { text: 'Pediu para sair (mensagem)', tone: 'neutral' },
      opt_out_button: { text: 'Clicou em “não quero receber”', tone: 'neutral' },
      manual: { text: 'Adicionado manualmente', tone: 'neutral' },
      complaint: { text: 'Reclamação', tone: 'warn' },
      invalid: { text: 'Número inválido', tone: 'neutral' },
    },
    s,
  );

export const ROLE_LABELS: Record<string, { text: string; hint: string }> = {
  owner: { text: 'Dono', hint: 'Acesso total, inclusive números e usuários' },
  operator: { text: 'Operador', hint: 'Cadastra clientes, contatos, modelos e disparos' },
  viewer: { text: 'Somente leitura', hint: 'Só consulta, não altera nada' },
};

export const ORIGIN_OPTIONS = [
  { value: 'customers', text: 'Clientes que já compraram ou contrataram' },
  { value: 'signup', text: 'Pessoas que se cadastraram (site, formulário, loja)' },
  { value: 'leads', text: 'Interessados que pediram contato' },
  { value: 'other', text: 'Outra origem (explique abaixo)' },
] as const;

export const LEGAL_BASIS_OPTIONS = [
  { value: 'consentimento', text: 'A pessoa autorizou receber mensagens (consentimento)' },
  {
    value: 'legitimo_interesse',
    text: 'Já existe relação com o cliente (legítimo interesse)',
  },
  { value: 'execucao_contrato', text: 'Faz parte de um contrato ou compra (execução de contrato)' },
] as const;
