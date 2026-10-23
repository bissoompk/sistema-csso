/**
 * Constantes, funcoes e `@property` de `app/modelos/treinamento.py`.
 *
 * Padroes SEM ancora, como no Python (ver `check_regex` em `db/esquema/base.ts`).
 */

import { randomInt } from 'node:crypto';

import { INSCRICAO_OCUPA_VAGA, TURMA_ACEITA_INSCRICAO } from './estados';
import { linhas } from './dominios';
import { somar_dias } from './datas';
import { vigente_em } from './organizacao';

export const ORIENTACOES = ['PAISAGEM', 'RETRATO'] as const;

// NR-35, PRIM-SOCORROS, BRIGADA_2026: caixa alta porque o codigo e citado em
// oficio e em planilha, e caixa mista vira duas grafias do mesmo treinamento.
export const PADRAO_CODIGO_TREINAMENTO = String.raw`[A-Z0-9][A-Z0-9._-]*`;
// o marcador vira variavel de template dentro do .docx ({{ nome_do_aluno }}); o
// que nao for identificador valido quebra o render, e o lugar de recusar isso e
// aqui, quando alguem digita.
export const PADRAO_MARCADOR = String.raw`[A-Za-z_][A-Za-z0-9_]*`;

/**
 * Um marcador do .docx enviado pela tela: o nome que o sistema usa, o texto
 * que o usuario escreveu no Word («NOME COMPLETO...» ou o proprio nome do
 * `{{ x }}`) e um trecho do texto ao redor, para saber qual e qual.
 */
export interface MarcadorDoModelo {
  marcador: string;
  rotulo: string;
  antes: string;
  depois: string;
  // 1 na primeira vez que o mesmo rotulo aparece, 2 na segunda...
  ocorrencia: number;
}

/**
 * NUVEM: o .docx que veio pela tela (`certificado_modelo.arquivo_enviado`).
 * NULL = modelo embutido em `modelos-docx/certificados/`.
 */
export interface ArquivoEnviado {
  // SHA-256 do .docx ja convertido para `{marcador}` — e a chave no armazenamento
  sha256_convertido: string;
  tamanho: number;
  marcadores: MarcadorDoModelo[];
}
// NUVEM: de onde vem o valor do marcador (`certificado_modelo_tag.tipo`)
export const TIPOS_TAG = ['SISTEMA', 'TEXTO_FIXO', 'TURMA', 'PARTICIPANTE'] as const;
export type TipoTag = (typeof TIPOS_TAG)[number];
export const ROTULO_TIPO_TAG: Record<TipoTag, string> = {
  SISTEMA: 'Campo do sistema',
  TEXTO_FIXO: 'Texto fixo do modelo',
  TURMA: 'Campo da turma',
  PARTICIPANTE: 'Campo do participante',
};

// =====================================================================
// Fatia 2 — participante, turma e inscricao
// =====================================================================

// O mesmo alfabeto de 30 simbolos da chave de validacao, e pelo mesmo motivo: o
// identificador e ditado ao telefone e copiado de um papel. Ficam de fora 0/O e
// 1/I/L, que se confundem manuscritos, e U.
export const ALFABETO_IDENTIFICADOR = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PREFIXO_IDENTIFICADOR = 'PTC-';
export const TAMANHO_IDENTIFICADOR = 8;
export const PADRAO_IDENTIFICADOR_PARTICIPANTE = `PTC-[${ALFABETO_IDENTIFICADOR}]{${TAMANHO_IDENTIFICADOR}}`;

// Terceirizado e discente entram em treinamento (decisao 3 do coordenador: o que
// caiu foi o EPI, nao o certificado de brigada).
export const VINCULOS_PARTICIPANTE = [
  'SERVIDOR',
  'TERCEIRIZADO',
  'DISCENTE',
  'VISITANTE',
  'OUTRO',
] as const;

export const ROTULO_VINCULO: Readonly<Record<string, string>> = {
  SERVIDOR: 'Servidor da UFVJM',
  TERCEIRIZADO: 'Terceirizado',
  DISCENTE: 'Discente',
  VISITANTE: 'Visitante',
  OUTRO: 'Outro',
};

export const ORIGENS_EMAIL = ['CADASTRO', 'INSCRICAO_PUBLICA', 'SERVIDOR', 'MESCLAGEM'] as const;

export const ORIGENS_INSCRICAO = ['INTERNA', 'PUBLICA'] as const;

/**
 * `casefold` e `strip`, e nada alem disso.
 *
 * Nao removemos ponto do Gmail nem sufixo `+alguma-coisa`: normalizar demais
 * junta pessoas diferentes, que e o erro pior dos dois.
 *
 * O JavaScript nao tem `casefold`. `toLowerCase()` coincide com ele em tudo o
 * que aparece num endereco de e-mail real, exceto o 'ß' (casefold -> 'ss') e o
 * sigma final (-> 'σ'), tratados a mao para que a linha gravada pelo Python e a
 * gravada aqui normalizem igual.
 */
export function normalizar_email(valor: string | null | undefined): string {
  return (valor ?? '').trim().toLowerCase().replaceAll('ß', 'ss').replaceAll('ς', 'σ');
}

/**
 * `PTC-7F3K9Q2M` — opaco, estavel e sem relacao com nome nem com e-mail. E o
 * que aparece na pagina publica de validacao no lugar do nome. `randomInt` e o
 * `secrets.choice` do Python: sorteio criptografico, sem vies de modulo.
 */
export function gerar_identificador_publico(): string {
  let sorteio = '';
  for (let i = 0; i < TAMANHO_IDENTIFICADOR; i++) {
    sorteio += ALFABETO_IDENTIFICADOR[randomInt(ALFABETO_IDENTIFICADOR.length)];
  }
  return `${PREFIXO_IDENTIFICADOR}${sorteio}`;
}

// =====================================================================
// Fatia 4 — o certificado
// =====================================================================

// `CSSO-2026-K7QMX-3FTB9-H`. O ano ajuda o suporte e nao revela nada; os dez
// sorteados valem ~49 bits; o ultimo caractere e o digito verificador.
export const PREFIXO_CHAVE = 'CSSO';
export const TAMANHO_SORTEIO_CHAVE = 10;
// A chave dos certificados emitidos ATE 22/10/2026 (com digito verificador).
// Continua valendo para sempre em /validar: o papel ja circulou.
export const PADRAO_CHAVE_ANTIGA =
  String.raw`CSSO-\d{4}-` +
  `[${ALFABETO_IDENTIFICADOR}]{5}-` +
  `[${ALFABETO_IDENTIFICADOR}]{5}-[${ALFABETO_IDENTIFICADOR}]`;

export const SITUACOES_CERTIFICADO = ['EMITIDO', 'ANULADO'] as const;

export const ROTULO_CERTIFICADO: Readonly<Record<string, string>> = {
  EMITIDO: 'Emitido',
  ANULADO: 'Anulado',
};

// ---------------------------------------------------------------------
// As `@property` das classes, como funcoes puras
// ---------------------------------------------------------------------

export const Treinamento = {
  topicos(treinamento: { conteudo_programatico: string | null }): string[] {
    return linhas(treinamento.conteudo_programatico);
  },
  expira(treinamento: { validade_meses: number }): boolean {
    return treinamento.validade_meses > 0;
  },
  /** Como a validade aparece na tela e no certificado. */
  validade_rotulo(treinamento: { validade_meses: number }): string {
    if (!Treinamento.expira(treinamento)) return 'não expira';
    if (treinamento.validade_meses % 12 === 0) {
      const anos = treinamento.validade_meses / 12;
      return anos === 1 ? `${anos} ano` : `${anos} anos`;
    }
    return `${treinamento.validade_meses} meses`;
  },
};

export const CertificadoModelo = {
  rotulo(modelo: { nome: string; versao: number }): string {
    return `${modelo.nome} v${modelo.versao}`;
  },
  /**
   * `{marcador: campo}` — a forma que a emissao congela. Exige `tags` carregada
   * e ORDENADA por (ordem, id), que era o `order_by` da relacao no Python.
   */
  mapa_de_tags(
    modelo: { tags: ReadonlyArray<{ marcador: string; campo: string; tipo?: string | null }> },
  ): Record<string, string> {
    // NUVEM: só os campos do sistema; texto fixo e campos de turma/participante
    // não têm código no vocabulário (ver `marcadores_mapeados`)
    return Object.fromEntries(
      modelo.tags.filter((tag) => (tag.tipo ?? 'SISTEMA') === 'SISTEMA').map((tag) => [tag.marcador, tag.campo]),
    );
  },
  /**
   * NUVEM: `{marcador: tipo-ou-campo}` de TODA linha do dicionário — o que se
   * confronta com o .docx (`conferir_modelo` só olha as chaves).
   */
  marcadores_mapeados(
    modelo: { tags: ReadonlyArray<{ marcador: string; campo: string; tipo?: string | null }> },
  ): Record<string, string> {
    return Object.fromEntries(
      modelo.tags.map((tag) => [tag.marcador, (tag.tipo ?? 'SISTEMA') === 'SISTEMA' ? tag.campo : (tag.tipo as string)]),
    );
  },
};

export const AssinaturaInstrutor = {
  vigente_em,
  /** Interno le do cadastro de servidor; assim o nome nao diverge em dois lugares. */
  nome_exibicao(assinatura: { nome: string; servidor?: { nome: string } | null }): string {
    return assinatura.servidor ? assinatura.servidor.nome : assinatura.nome;
  },
  registro_completo(assinatura: { conselho: string | null; registro_conselho: string | null }): string {
    if (assinatura.conselho && assinatura.registro_conselho) {
      return `${assinatura.conselho} ${assinatura.registro_conselho}`;
    }
    return assinatura.registro_conselho || '';
  },
};

export const Participante = {
  /**
   * Servidor le do cadastro; externo le do proprio campo. Nunca copiar o nome
   * do servidor para ca: no dia em que alguem corrigir um dos dois, o
   * certificado sai com o outro. Exige a relacao `servidor` carregada.
   */
  nome_exibicao(participante: { nome: string | null; servidor?: { nome: string } | null }): string {
    if (participante.servidor != null) return participante.servidor.nome;
    return participante.nome || '(expurgado)';
  },
  e_servidor(participante: { servidor_id: number | null }): boolean {
    return participante.servidor_id !== null;
  },
  /** Exige `email_principal` e `emails` (ordenados por id) carregados. */
  email_exibicao(participante: {
    email_principal?: { email: string } | null;
    emails: ReadonlyArray<{ email: string }>;
  }): string {
    if (participante.email_principal != null) return participante.email_principal.email;
    return participante.emails.length > 0 ? participante.emails[0]!.email : '';
  },
};

export const ParticipanteEmail = {
  confirmado(email: { confirmado_em: Date | null }): boolean {
    return email.confirmado_em !== null;
  },
};

export const Turma = {
  /** numeric chega como string do driver; a escolha e a mesma do `or` do Python. */
  carga_efetiva(turma: {
    carga_horaria_horas: string | null;
    treinamento: { carga_horaria_horas: string };
  }): string {
    return turma.carga_horaria_horas || turma.treinamento.carga_horaria_horas;
  },
  /** A data de que o vencimento e contado. */
  data_base(turma: { data_base_vencimento: string | null; data_fim: string }): string {
    return turma.data_base_vencimento || turma.data_fim;
  },
  rotulo(turma: { codigo: string; treinamento: { nome: string } }): string {
    return `${turma.codigo} · ${turma.treinamento.nome}`;
  },
  aceita_inscricao(turma: { situacao: string }): boolean {
    return TURMA_ACEITA_INSCRICAO.has(turma.situacao);
  },
  encerrada(turma: { situacao: string }): boolean {
    return turma.situacao === 'CONCLUIDA' || turma.situacao === 'CANCELADA';
  },
};

// O rótulo da inscrição para a TELA e para a mensagem, com acento — o de
// `estados.ROTULO_INSCRICAO` entra na descrição da trilha (texto conferido por
// digest) e não muda. Mesmas chaves, e o mesmo texto de `partes/macros.html`.
export const ROTULO_INSCRICAO_TELA: Readonly<Record<string, string>> = {
  AGUARDANDO_EMAIL: 'Pedido pelo link (a conferir)',
  INSCRITA: 'Inscrita',
  CONFIRMADA: 'Confirmada',
  PRESENTE: 'Presente',
  AUSENTE: 'Ausente',
  APROVADO: 'Aprovado',
  REPROVADO: 'Reprovado',
  CANCELADA: 'Cancelada',
};

export const Inscricao = {
  ocupa_vaga(inscricao: { situacao: string }): boolean {
    return INSCRICAO_OCUPA_VAGA.has(inscricao.situacao);
  },
  /**
   * As horas que contam para a frequencia. Falta justificada tambem e falta.
   *
   * Soma em DECIMOS inteiros, e nao em `number`: `horas` e numeric(4,1), e
   * 0.1 + 0.2 em ponto flutuante nao e 0.3 — a frequencia que decide se o
   * certificado sai nao pode depender de arredondamento binario. A saida imita
   * o `Decimal` do Python: '0' sem nenhuma presenca, uma casa decimal com.
   */
  horas_presentes(inscricao: { presencas: ReadonlyArray<{ presente: boolean; horas: string }> }): string {
    const presentes = inscricao.presencas.filter((p) => p.presente);
    if (presentes.length === 0) return '0';
    const decimos = presentes.reduce((soma, p) => soma + decimos_de(p.horas), 0);
    return `${Math.trunc(decimos / 10)}.${decimos % 10}`;
  },
  /** Ao menos um dia com presenca registrada (criterio do fecho da turma). */
  compareceu(inscricao: { presencas: ReadonlyArray<{ presente: boolean }> }): boolean {
    return inscricao.presencas.some((p) => p.presente);
  },
};

/** '12.5' -> 125. `horas` nunca e negativa (`ck_turma_presenca_horas`). */
function decimos_de(valor: string): number {
  const [inteira = '0', fracao = ''] = valor.split('.');
  return Number(inteira) * 10 + Number((fracao + '0').slice(0, 1));
}

export const Certificado = {
  /**
   * O numero que o papel imprime: `CSSO-NR35-2026-0001` no certificado
   * emitido desde 22/10/2026, e `27/2026` no de antes (`numero_impresso`
   * nulo). Obrigatorio passar `numero_impresso`: quem seleciona so
   * numero/ano mostraria o rotulo antigo para o certificado novo.
   */
  rotulo(certificado: { numero: number; ano: number; numero_impresso: string | null }): string {
    return certificado.numero_impresso || `${certificado.numero}/${certificado.ano}`;
  },
  anulado(certificado: { situacao: string }): boolean {
    return certificado.situacao === 'ANULADO';
  },
  /** Estado, nunca congelado: quem nao expira nunca vence. */
  vencido_em(certificado: { data_vencimento: string | null }, quando: string): boolean {
    return certificado.data_vencimento !== null && certificado.data_vencimento < quando;
  },
  /**
   * VALIDO / VENCIDO / ANULADO — o que a pagina publica responde. Anulado
   * prevalece sobre vencido: um certificado anulado nunca foi valido.
   */
  situacao_publica(
    certificado: { situacao: string; data_vencimento: string | null },
    quando: string,
  ): 'ANULADO' | 'VENCIDO' | 'VALIDO' {
    if (Certificado.anulado(certificado)) return 'ANULADO';
    return Certificado.vencido_em(certificado, quando) ? 'VENCIDO' : 'VALIDO';
  },
  /**
   * O semáforo da reciclagem: o válido que vence em até
   * `DIAS_AVISO_RECICLAGEM` dias já é "a vencer" — é a janela para marcar a
   * turma de reciclagem antes de a pessoa ficar sem o certificado.
   */
  situacao_reciclagem(
    certificado: { data_vencimento: string | null },
    quando: string,
  ): 'VENCIDO' | 'A_VENCER' | 'VALIDO' {
    if (Certificado.vencido_em(certificado, quando)) return 'VENCIDO';
    const limite = somar_dias(quando, DIAS_AVISO_RECICLAGEM);
    return certificado.data_vencimento !== null && certificado.data_vencimento <= limite ? 'A_VENCER' : 'VALIDO';
  },
};

/**
 * A janela UNICA de "a vencer" do sistema inteiro: o certificado valido que
 * vence em ate 60 dias ja pede reciclagem. Substituiu os 30 do aviso de
 * reciclagem, os 90 do Inicio do servidor e os 60 da lista de certificados
 * (decisao do usuario, 22/10/2026).
 */
export const JANELA_A_VENCER_DIAS = 60;

/** O mesmo prazo, com o nome antigo (o aviso por e-mail e o monitor o usam). */
export const DIAS_AVISO_RECICLAGEM = JANELA_A_VENCER_DIAS;

export const ROTULO_RECICLAGEM: Readonly<Record<string, string>> = {
  VALIDO: 'Válido',
  A_VENCER: `A vencer (${DIAS_AVISO_RECICLAGEM} dias)`,
  VENCIDO: 'Vencido',
};

// =====================================================================
// Portal do servidor (22/10/2026) — numero novo, janela unica e cartao
// =====================================================================


/**
 * O codigo curto do treinamento, que entra no numero do certificado
 * (`CSSO-NR35-2026-0001`): so letra e algarismo, 2 a 10, caixa alta.
 */
export const PADRAO_CODIGO_CURTO = '[A-Z0-9]{2,10}';
export const TAMANHO_MAXIMO_CODIGO_CURTO = 10;
/** A sigla do setor promotor no numero: so letra e algarismo, ate 12. */
export const TAMANHO_MAXIMO_SIGLA_NUMERO = 12;
/** Setor promotor sem sigla (ou turma sem setor): o prefixo e o do sistema. */
export const SIGLA_PADRAO_NUMERO = 'SISA';
/** Os caracteres sorteados que seguem o numero no QR/link de validacao. */
export const TAMANHO_SORTEIO_VALIDACAO = 5;
/** A sequencia anual por setor+treinamento sai com 4 digitos (0001). */
export const DIGITOS_SEQUENCIA_NUMERO = 4;

/** `CSSO-NR35-2026-0001` — o numero impresso, legivel. */
export const PADRAO_NUMERO_IMPRESSO = String.raw`[A-Z0-9]{1,12}-[A-Z0-9]{2,10}-\d{4}-\d{4,6}`;
/** `CSSO-NR35-2026-0001-K7QMX` — o numero e mais 5 sorteados: nao se adivinha. */
export const PADRAO_CHAVE_NOVA = `${PADRAO_NUMERO_IMPRESSO}-[${ALFABETO_IDENTIFICADOR}]{${TAMANHO_SORTEIO_VALIDACAO}}`;
/** O que a coluna `chave_validacao` aceita: a antiga OU a nova (CHECK do banco). */
export const PADRAO_CHAVE_VALIDACAO = `(?:${PADRAO_CHAVE_ANTIGA})|(?:${PADRAO_CHAVE_NOVA})`;

const _PARTICULAS_CODIGO = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'EM', 'NO', 'NA', 'NOS', 'NAS', 'PARA', 'COM', 'POR', 'A', 'O', 'AS', 'OS']);

/** Caixa alta, sem acento e so com letra/algarismo. */
export function so_letras_e_algarismos(texto: string | null | undefined): string {
  return (texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * A sugestao do codigo curto a partir do nome (e do codigo do catalogo, quando
 * ha). E a MESMA regra da migracao 0016 e da trava `csso_treinamento_codigo_curto`
 * (`travas.sql`):
 *
 * 1. citou uma NR ("NR-35", "NR 6", "NR-06") → `NR35`, `NR6`;
 * 2. senao, o codigo do catalogo sem pontuacao, se tiver 2 caracteres ou mais;
 * 3. senao, as iniciais das palavras de 3 letras ou mais do nome (ate 6);
 * 4. e, no fim, as 4 primeiras letras do nome.
 *
 * Nao garante unicidade: quem grava confere (a trava acrescenta algarismo).
 */
export function sugerir_codigo_curto(nome: string | null | undefined, codigo: string | null | undefined = null): string {
  const fonte = `${nome ?? ''} ${codigo ?? ''}`;
  const nr = /\bNR\s*[-–—]?\s*0*(\d{1,2})\b/i.exec(fonte.normalize('NFD').replace(/[̀-ͯ]/g, ''));
  if (nr) return `NR${nr[1]}`;
  const do_codigo = so_letras_e_algarismos(codigo).slice(0, TAMANHO_MAXIMO_CODIGO_CURTO);
  if (do_codigo.length >= 2) return do_codigo;
  const palavras = (nome ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((p) => p.length >= 3 && !_PARTICULAS_CODIGO.has(p));
  const iniciais = palavras.map((p) => p[0]).join('').slice(0, 6);
  if (iniciais.length >= 2) return iniciais;
  const letras = so_letras_e_algarismos(nome).slice(0, 4);
  return letras.length >= 2 ? letras : 'TR';
}

/** A sigla do setor promotor como entra no numero: `SecSisa` → `SECSISA`. */
export function sigla_para_numero(sigla: string | null | undefined): string {
  const limpa = so_letras_e_algarismos(sigla).slice(0, TAMANHO_MAXIMO_SIGLA_NUMERO);
  return limpa || SIGLA_PADRAO_NUMERO;
}

/** `CSSO-NR35` — o prefixo da sequencia anual (setor + treinamento). */
export function prefixo_do_numero(sigla_setor: string | null | undefined, codigo_curto: string): string {
  return `${sigla_para_numero(sigla_setor)}-${codigo_curto}`;
}

/** `CSSO-NR35-2026-0001`. */
export function montar_numero_impresso(prefixo: string, ano: number, sequencia: number): string {
  return `${prefixo}-${String(ano).padStart(4, '0')}-${String(sequencia).padStart(DIGITOS_SEQUENCIA_NUMERO, '0')}`;
}

/**
 * A situacao do certificado no CARTAO do titular, calculada hoje (nunca
 * congelada). `dias` e quanto falta para vencer (0 = vence hoje).
 */
export type SituacaoCartao =
  | { tipo: 'anulado' }
  | { tipo: 'indeterminado' }
  | { tipo: 'vencido'; dias: number }
  | { tipo: 'a_vencer'; dias: number }
  | { tipo: 'valido'; dias: number };

/** Dias inteiros de `de` ate `ate` (ISO), negativo quando `ate` ja passou. */
export function dias_entre(de: string, ate: string): number {
  const a = Date.UTC(Number(de.slice(0, 4)), Number(de.slice(5, 7)) - 1, Number(de.slice(8, 10)));
  const b = Date.UTC(Number(ate.slice(0, 4)), Number(ate.slice(5, 7)) - 1, Number(ate.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

export function situacao_do_cartao(
  certificado: { situacao: string; data_vencimento: string | null },
  hoje: string,
): SituacaoCartao {
  if (certificado.situacao === 'ANULADO') return { tipo: 'anulado' };
  if (certificado.data_vencimento === null) return { tipo: 'indeterminado' };
  const dias = dias_entre(hoje, certificado.data_vencimento);
  if (dias < 0) return { tipo: 'vencido', dias };
  if (dias <= JANELA_A_VENCER_DIAS) return { tipo: 'a_vencer', dias };
  return { tipo: 'valido', dias };
}
