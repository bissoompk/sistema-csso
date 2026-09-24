/**
 * Constantes, funcoes e `@property` de `app/modelos/treinamento.py`.
 *
 * Padroes SEM ancora, como no Python (ver `check_regex` em `db/esquema/base.ts`).
 */

import { randomInt } from 'node:crypto';

import { INSCRICAO_OCUPA_VAGA, TURMA_ACEITA_INSCRICAO } from './estados';
import { linhas } from './dominios';
import { vigente_em } from './organizacao';

export const ORIENTACOES = ['PAISAGEM', 'RETRATO'] as const;

// NR-35, PRIM-SOCORROS, BRIGADA_2026: caixa alta porque o codigo e citado em
// oficio e em planilha, e caixa mista vira duas grafias do mesmo treinamento.
export const PADRAO_CODIGO_TREINAMENTO = String.raw`[A-Z0-9][A-Z0-9._-]*`;
// o marcador vira variavel de template dentro do .docx ({{ nome_do_aluno }}); o
// que nao for identificador valido quebra o render, e o lugar de recusar isso e
// aqui, quando alguem digita.
export const PADRAO_MARCADOR = String.raw`[A-Za-z_][A-Za-z0-9_]*`;

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
export const PADRAO_CHAVE_VALIDACAO =
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
  mapa_de_tags(modelo: { tags: ReadonlyArray<{ marcador: string; campo: string }> }): Record<string, string> {
    return Object.fromEntries(modelo.tags.map((tag) => [tag.marcador, tag.campo]));
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
  rotulo(certificado: { numero: number; ano: number }): string {
    return `${certificado.numero}/${certificado.ano}`;
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
};
