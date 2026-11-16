import { MetaApiError, MetaNetworkError } from './errors';

/**
 * Catálogo de erros da Meta (docs/10-meta-referencia.md §6, validado na doc oficial em 2026-11)
 * mapeado para as ações da plataforma (docs/02-arquitetura.md §6.3).
 *
 * Regra da Meta: basear a lógica em `code` (+ `error_data.details`), nunca no título nem no
 * HTTP status; `error_subcode` está depreciado. `is_transient: true` sempre torna o erro retentável.
 */

export type MetaErrorAction =
  /** Repetir com backoff exponencial + jitter (máx. tentativas do worker). */
  | 'retry'
  /** Repetir mais tarde e reduzir a taxa de envio do número (throughput/rate limit). */
  | 'retry_slower'
  /** Reagendar só este destinatário (limite de pares). */
  | 'reschedule_recipient'
  /** Não reenviar hoje; marca `skipped` (limite por usuário/ecossistema). */
  | 'skip_recipient'
  /** Opt-out de marketing: suprimir o contato e nunca reenviar. */
  | 'suppress_contact'
  /** Falha permanente do destinatário (não é WhatsApp, termos, etc.). */
  | 'fail_recipient'
  /** Pausar a campanha e alertar (spam, template, restrição de classificação). */
  | 'pause_campaign'
  /** Pausar a campanha e ressincronizar o template. */
  | 'pause_campaign_sync_template'
  /** Pausar todas as campanhas do cliente com alerta crítico (pagamento, conta restrita). */
  | 'pause_tenant'
  /** Token inválido: conexão `broken`, pausar cliente, alertar. */
  | 'reconnect'
  /** Erro de requisição/configuração nosso: não repetir, registrar para correção. */
  | 'fix_request'
  /** Timeout de POST: não sabemos se a Meta aceitou. Status `uncertain`, nunca reenviar sozinho. */
  | 'uncertain';

export interface MetaErrorInfo {
  code: number | null;
  action: MetaErrorAction;
  retryable: boolean;
  /** Descrição curta em português (para painel/auditoria). */
  description: string;
}

type Entry = [action: MetaErrorAction, description: string];

const CATALOG: Record<number, Entry> = {
  0: ['reconnect', 'Não foi possível autenticar (token expirado/invalidado)'],
  1: ['retry', 'Requisição inválida ou possível erro temporário da Meta'],
  2: ['retry', 'Meta temporariamente indisponível ou sobrecarregada'],
  3: ['fix_request', 'Problema de capability/permissão do app'],
  4: ['retry_slower', 'App atingiu o rate limit de chamadas'],
  10: ['reconnect', 'Permissão não concedida ou removida'],
  33: ['fix_request', 'Número comercial excluído'],
  100: ['fix_request', 'Parâmetro inválido ou não suportado'],
  190: ['reconnect', 'Token de acesso expirado ou inválido'],
  368: ['pause_tenant', 'WABA restrita/desativada por violação de política'],
  80007: ['retry_slower', 'WABA atingiu o rate limit da API'],
  130403: ['fail_recipient', 'O negócio bloqueou o usuário'],
  130429: ['retry_slower', 'Throughput da Cloud API atingido'],
  130472: ['fail_recipient', 'Usuário em experimento de marketing da Meta'],
  130497: ['pause_campaign', 'WABA restrita para usuários de certos países'],
  131000: ['retry', 'Erro desconhecido (tentar de novo)'],
  131005: ['reconnect', 'Permissão não concedida ou removida'],
  131008: ['fix_request', 'Parâmetro obrigatório ausente'],
  131009: ['fix_request', 'Valor de parâmetro inválido'],
  131016: ['retry', 'Serviço temporariamente indisponível'],
  131021: ['fail_recipient', 'Remetente e destinatário são o mesmo número'],
  131026: ['fail_recipient', 'Mensagem não entregável (não é WhatsApp, termos ou versão antiga)'],
  131031: ['pause_tenant', 'Conta restrita/desativada por política'],
  131037: ['pause_campaign', 'Número sem nome exibido aprovado'],
  131042: ['pause_tenant', 'Problema no método de pagamento'],
  131045: ['pause_campaign', 'Erro de registro do número'],
  131047: ['fail_recipient', 'Janela de 24 h encerrada (usar template)'],
  131048: ['pause_campaign', 'Limite de spam: número restrito por bloqueios/denúncias'],
  131049: ['skip_recipient', 'Não entregue para manter o engajamento saudável (esperar 24 h)'],
  131050: ['suppress_contact', 'Usuário optou por não receber marketing (nunca reenviar)'],
  131051: ['fix_request', 'Tipo de mensagem não suportado'],
  131052: ['fail_recipient', 'Falha ao baixar a mídia enviada pelo usuário'],
  131053: ['fix_request', 'Falha ao subir a mídia da mensagem'],
  131056: ['reschedule_recipient', 'Muitas mensagens para o mesmo destinatário em pouco tempo'],
  131057: ['retry_slower', 'Conta em modo de manutenção'],
  131062: ['fail_recipient', 'Destinatário BSUID não suportado para esta mensagem'],
  131063: ['pause_campaign', 'Marketing desativado na Cloud API para este negócio'],
  131064: ['pause_campaign', 'Limite por violações de classificação de template'],
  132000: ['pause_campaign_sync_template', 'Número de parâmetros não confere com o template'],
  132001: ['pause_campaign_sync_template', 'Template inexistente no idioma ou não aprovado'],
  132005: ['pause_campaign_sync_template', 'Texto traduzido longo demais'],
  132007: ['pause_campaign_sync_template', 'Conteúdo do template viola política'],
  132012: ['pause_campaign_sync_template', 'Parâmetros do template com formato incorreto'],
  132015: ['pause_campaign_sync_template', 'Template pausado por baixa qualidade'],
  132016: ['pause_campaign_sync_template', 'Template desativado permanentemente'],
  132068: ['pause_campaign', 'Flow bloqueado'],
  132069: ['retry_slower', 'Flow em throttling'],
  133000: ['fix_request', 'Tentativa anterior de desregistro falhou'],
  133004: ['retry', 'Servidor temporariamente indisponível'],
  133005: ['fix_request', 'PIN de duas etapas incorreto'],
  133006: ['fix_request', 'Número precisa ser verificado antes do registro'],
  133008: ['retry_slower', 'Muitas tentativas de PIN'],
  133009: ['retry_slower', 'PIN digitado rápido demais'],
  133010: ['fix_request', 'Número não registrado na plataforma'],
  133015: ['retry_slower', 'Número excluído recentemente (aguardar 5 min)'],
  133016: ['retry_slower', 'Muitas tentativas de registro/desregistro'],
  134011: ['pause_tenant', 'Termos do WhatsApp Payments pendentes'],
  135000: ['pause_campaign', 'Erro nos parâmetros ou mensagem descartada por pacing do portfolio'],
  2494100: ['retry_slower', 'Conta em modo de manutenção'],
};

const RETRYABLE: ReadonlySet<MetaErrorAction> = new Set([
  'retry',
  'retry_slower',
  'reschedule_recipient',
]);

/** Classifica um erro lançado pelo meta-client. */
export function classifyMetaError(err: unknown): MetaErrorInfo {
  if (err instanceof MetaNetworkError) {
    return err.ambiguous
      ? {
          code: null,
          action: 'uncertain',
          retryable: false,
          description: 'Timeout após envio: resultado desconhecido',
        }
      : { code: null, action: 'retry', retryable: true, description: 'Falha de rede' };
  }
  if (!(err instanceof MetaApiError)) {
    return { code: null, action: 'fix_request', retryable: false, description: 'Erro inesperado' };
  }

  const code = err.code;
  let entry: Entry | undefined = code !== null ? CATALOG[code] : undefined;
  // 200–299: família de permissão (docs/10 §6.2).
  if (!entry && code !== null && code >= 200 && code <= 299) {
    entry = ['reconnect', 'Permissão não concedida ou removida'];
  }
  if (!entry) {
    entry =
      err.httpStatus >= 500
        ? ['retry', `Erro ${code ?? err.httpStatus} da Meta (servidor)`]
        : ['fix_request', `Erro ${code ?? err.httpStatus} da Meta não catalogado`];
  }
  let [action, description] = entry;
  // A Meta sinaliza explicitamente quando repetir é seguro.
  if (err.isTransient && !RETRYABLE.has(action)) {
    action = 'retry';
    description = `${description} (transitório segundo a Meta)`;
  }
  return { code, action, retryable: RETRYABLE.has(action), description };
}

/** Códigos catalogados (para testes/documentação). */
export const CATALOGED_CODES: readonly number[] = Object.keys(CATALOG).map(Number);
