/**
 * A identificação pessoal do acidentado e o contato das testemunhas (Anexo III
 * do Manual de Perícia Oficial, a CAT/SP): bloco RESTRITO do módulo de
 * acidentes. Decisão do dono do sistema em 27/10/2026: o formulário coleta o que
 * o Anexo III pede, e a ROPA ganha emenda (§4.3/§4.5).
 *
 * As regras deste dado, todas aqui:
 *
 * 1. **Onde mora.** `acidente_identificacao` (1:1 com `acidentado`) e
 *    `acidente_testemunha_contato`. Fora do contexto congelado da CAT/SP, do
 *    relatório (as duas variantes), da trilha e da exportação em claro.
 * 2. **Por onde entra.** Na comunicação (`comunicar` chama `gravar` e
 *    `gravar_contato_testemunha` na mesma transação), só com conta: o
 *    formulário por link não pede. CPF só pelo campo `env_<n>_cpf` (o único,
 *    além do `cpf_certificado`, que escapa da máscara da porta), com dígito
 *    verificador conferido. Tudo é opcional: o Anexo III não marca estes campos
 *    como obrigatórios.
 * 3. **Quem lê.** `acidente.identificacao_ver` (cargos de SST e a perícia), com a
 *    finalidade escolhida ANTES (lista fechada) e cada abertura em
 *    `acesso_dado_sensivel`. O próprio acidentado lê a sua sem finalidade e sem
 *    registro. A ocorrência restrita (menor de idade) segue só para quem instrui.
 * 4. **O que sai.** Na tela, o CPF aparece só mascarado (nenhum dígito, como no
 *    certificado); o resto, para quem tem a permissão. O CPF inteiro só sairá na
 *    CAT/SP no formato do Anexo III, para o SIASS.
 * 5. **A trilha** registra QUE foi informado e quais grupos de campo, nunca o valor.
 * 6. **Menor de idade.** A data de nascimento informada, comparada com a data do
 *    acidente, marca a ocorrência como restrita à SST (D14a) mesmo que a pessoa
 *    não tenha marcado «menor de idade».
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  acidentado as tabela_acidentado,
  acidente_identificacao,
  acidente_testemunha,
  acidente_testemunha_contato,
} from "../db/esquema/index.js";
import { FINALIDADES_IDENTIFICACAO, ROTULO_FINALIDADE_IDENTIFICACAO, SEXOS } from "../dominio/acidente.js";
import { hoje_iso } from "../dominio/datas.js";
import { RegraViolada } from "../nucleo/erros.js";
import { pode_ver_restrita_sst } from "./acidente_acesso.js";
import type { Ocorrencia } from "./acidente_comunicacao.js";
import * as auditoria from "./auditoria.js";
import * as datas_br from "./datas_br.js";
import type { UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";

export class IdentificacaoRecusada extends RegraViolada {
  constructor(
    mensagem: string,
    public campo: string | null = null,
  ) {
    super(mensagem);
  }
}
/** O acidentado não existe nesta ocorrência, ou a ocorrência é restrita a quem pede. */
export class IdentificacaoInexistente extends RegraViolada {}

const ENTIDADE = "acidente_ocorrencia";

/** O que o formulário traz (texto como digitado). */
export interface DadosIdentificacao {
  sexo: string | null;
  cpf: string | null;
  rg: string | null;
  data_nascimento: string | null;
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  telefone: string | null;
  email: string | null;
}

export interface ContatoTestemunha {
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  municipio: string | null;
  uf: string | null;
  telefone: string | null;
}

export const IDENTIFICACAO_VAZIA: DadosIdentificacao = {
  sexo: null,
  cpf: null,
  rg: null,
  data_nascimento: null,
  cep: null,
  logradouro: null,
  numero: null,
  complemento: null,
  bairro: null,
  cidade: null,
  uf: null,
  telefone: null,
  email: null,
};

// ---------------------------------------------------------------------
// Conferências (a mensagem diz o campo, nunca o valor digitado)
// ---------------------------------------------------------------------
const RE_CPF_SOLTO = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/;

function _texto(valor: string | null | undefined, campo: string, maximo: number): string | null {
  const v = (valor ?? "").replace(/\s+/g, " ").trim();
  if (!v) return null;
  if (v.length > maximo) throw new IdentificacaoRecusada(`O campo ${campo} passa de ${maximo} caracteres.`, campo);
  // CPF só no campo próprio: em endereço, complemento etc. o banco não o quer
  if (RE_CPF_SOLTO.test(v)) throw new IdentificacaoRecusada(`O campo ${campo} tem um número com formato de CPF.`, campo);
  return v;
}

function _digitos(valor: string | null | undefined, campo: string, tamanhos: number[], dica: string): string | null {
  const v = (valor ?? "").trim();
  if (!v) return null;
  const d = v.replace(/\D/g, "");
  if (!tamanhos.includes(d.length)) throw new IdentificacaoRecusada(`${campo}: ${dica}.`, campo);
  return d;
}

function _uf(valor: string | null | undefined): string | null {
  const v = (valor ?? "").trim().toUpperCase();
  if (!v) return null;
  if (!/^[A-Z]{2}$/.test(v)) throw new IdentificacaoRecusada("A UF tem duas letras (MG).", "a UF");
  return v;
}

function _cep(valor: string | null | undefined): string | null {
  return _digitos(valor, "O CEP", [8], "são 8 números");
}

function _telefone(valor: string | null | undefined): string | null {
  return _digitos(valor, "O telefone", [10, 11], "informe o DDD e o número (10 ou 11 números)");
}

/** Os campos conferidos, ou `null` quando nada foi preenchido. */
export function conferir(d: DadosIdentificacao): DadosIdentificacao | null {
  const sexo = (d.sexo ?? "").trim();
  if (sexo && !(SEXOS as readonly string[]).includes(sexo)) throw new IdentificacaoRecusada("Escolha o sexo na lista.", "o sexo");
  let cpf: string | null = null;
  if ((d.cpf ?? "").trim()) {
    cpf = textos.cpf_digitos(d.cpf);
    if (cpf === null) throw new IdentificacaoRecusada("CPF inválido: confira os dígitos (11 números, com o verificador).", "o CPF");
  }
  let nascimento: string | null = null;
  if ((d.data_nascimento ?? "").trim()) {
    nascimento = datas_br.ler_data_formulario(d.data_nascimento, "a data de nascimento");
    if (nascimento && (nascimento > hoje_iso() || nascimento < "1900-01-01")) {
      throw new IdentificacaoRecusada("A data de nascimento não confere.", "a data de nascimento");
    }
  }
  const email = (d.email ?? "").trim();
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160)) {
    throw new IdentificacaoRecusada("O e-mail não confere.", "o e-mail");
  }
  const saida: DadosIdentificacao = {
    sexo: sexo || null,
    cpf,
    rg: _texto(d.rg, "o RG", 20),
    data_nascimento: nascimento,
    cep: _cep(d.cep),
    logradouro: _texto(d.logradouro, "o logradouro", 160),
    numero: _texto(d.numero, "o número", 20),
    complemento: _texto(d.complemento, "o complemento", 80),
    bairro: _texto(d.bairro, "o bairro", 80),
    cidade: _texto(d.cidade, "a cidade", 80),
    uf: _uf(d.uf),
    telefone: _telefone(d.telefone),
    email: email || null,
  };
  return Object.values(saida).some((v) => v !== null) ? saida : null;
}

export function conferir_contato(c: ContatoTestemunha): ContatoTestemunha | null {
  const saida: ContatoTestemunha = {
    cep: _cep(c.cep),
    logradouro: _texto(c.logradouro, "o logradouro da testemunha", 160),
    numero: _texto(c.numero, "o número da testemunha", 20),
    complemento: _texto(c.complemento, "o complemento da testemunha", 80),
    bairro: _texto(c.bairro, "o bairro da testemunha", 80),
    municipio: _texto(c.municipio, "o município da testemunha", 80),
    uf: _uf(c.uf),
    telefone: _telefone(c.telefone),
  };
  return Object.values(saida).some((v) => v !== null) ? saida : null;
}

/** Menor de idade na data do acidente? Só a data de nascimento conferida entra. */
export function era_menor_na_data(nascimento: string | null, data_evento: string): boolean {
  if (!nascimento) return false;
  const [a, m, d] = nascimento.split("-").map(Number) as [number, number, number];
  const maioridade = `${a + 18}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return data_evento < maioridade;
}

const GRUPOS: [string, (keyof DadosIdentificacao)[]][] = [
  ["sexo", ["sexo"]],
  ["CPF", ["cpf"]],
  ["RG", ["rg"]],
  ["nascimento", ["data_nascimento"]],
  ["endereço", ["cep", "logradouro", "numero", "complemento", "bairro", "cidade", "uf"]],
  ["telefone", ["telefone"]],
  ["e-mail", ["email"]],
];

function _grupos(d: DadosIdentificacao): string[] {
  return GRUPOS.filter(([, campos]) => campos.some((c) => d[c] !== null)).map(([nome]) => nome);
}

// ---------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------
/**
 * Grava a identificação do acidentado (conferida). Vazia, não grava nada. Refaz
 * a linha se já existir. A trilha diz quais grupos de campo foram informados.
 */
export async function gravar(
  tx: Executor,
  usuario: UsuarioAtual | null,
  ocorrencia: Pick<Ocorrencia, "id" | "protocolo">,
  acidentado: { id: number; ordem: number },
  bruto: DadosIdentificacao,
): Promise<boolean> {
  const d = conferir(bruto);
  if (!d) return false;
  const valores = { ...d, registrado_por: usuario?.id ?? null, registrado_em: new Date() };
  await tx
    .insert(acidente_identificacao)
    .values({ acidentado_id: acidentado.id, ...valores })
    .onConflictDoUpdate({ target: acidente_identificacao.acidentado_id, set: valores });
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_IDENTIFICACAO_REGISTRADA,
    // o fato e os grupos de campo, nunca o valor
    descricao: `${ocorrencia.protocolo}: identificação pessoal do envolvido nº ${acidentado.ordem} informada (${_grupos(d).join(", ")}).`,
    usuario,
  });
  return true;
}

export async function gravar_contato_testemunha(
  tx: Executor,
  usuario: UsuarioAtual | null,
  ocorrencia: Pick<Ocorrencia, "id" | "protocolo">,
  testemunha_id: number,
  bruto: ContatoTestemunha,
): Promise<boolean> {
  const c = conferir_contato(bruto);
  if (!c) return false;
  await tx
    .insert(acidente_testemunha_contato)
    .values({ testemunha_id, ...c })
    .onConflictDoUpdate({ target: acidente_testemunha_contato.testemunha_id, set: c });
  await auditoria.registrar(tx, {
    entidade: ENTIDADE,
    entidade_id: ocorrencia.id,
    tipo_evento: auditoria.ACIDENTE_IDENTIFICACAO_REGISTRADA,
    descricao: `${ocorrencia.protocolo}: contato de uma testemunha informado (endereço e telefone).`,
    usuario,
  });
  return true;
}

// ---------------------------------------------------------------------
// Leitura — o serviço único
// ---------------------------------------------------------------------
function _eh_titular(usuario: UsuarioAtual, acidentado: { servidor_id: number | null }): boolean {
  return usuario.servidor_id !== null && acidentado.servidor_id !== null && usuario.servidor_id === acidentado.servidor_id;
}

function _alcanca(usuario: UsuarioAtual, ocorrencia: Ocorrencia, acidentado: { servidor_id: number | null }): boolean {
  return !ocorrencia.restrita_sst || pode_ver_restrita_sst(usuario) || _eh_titular(usuario, acidentado);
}

export function formatar_telefone(d: string | null): string | null {
  if (!d) return null;
  return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
}

export function formatar_cep(d: string | null): string | null {
  return d ? `${d.slice(0, 5)}-${d.slice(5)}` : null;
}

export interface Leitura {
  acidentado_id: number;
  titular: boolean;
  existe: boolean;
  sexo: string | null;
  /** nunca o número: a máscara, ou nulo */
  cpf_exibicao: string | null;
  rg: string | null;
  data_nascimento: string | null;
  endereco: { cep: string | null; logradouro: string | null; numero: string | null; complemento: string | null; bairro: string | null; cidade: string | null; uf: string | null };
  telefone: string | null;
  email: string | null;
  testemunhas: { id: number; nome: string; contato: (Omit<ContatoTestemunha, "cep" | "telefone"> & { cep: string | null; telefone: string | null }) | null }[];
}

/**
 * Abre a identificação de um acidentado (e o contato das testemunhas da
 * ocorrência). Quem não é o próprio acidentado precisa de
 * `acidente.identificacao_ver` e da finalidade (lista fechada), e a abertura é
 * gravada. O CPF volta mascarado.
 */
export async function ler(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  acidentado_id: number,
  finalidade: string | null,
): Promise<Leitura> {
  const [acidentado] = await tx
    .select()
    .from(tabela_acidentado)
    .where(and(eq(tabela_acidentado.id, acidentado_id), eq(tabela_acidentado.ocorrencia_id, ocorrencia.id)));
  if (!acidentado || !_alcanca(usuario, ocorrencia, acidentado)) throw new IdentificacaoInexistente("Acidentado não encontrado.");
  const titular = _eh_titular(usuario, acidentado);
  if (!titular) {
    usuario.exigir("acidente.identificacao_ver");
    if (!finalidade || !(FINALIDADES_IDENTIFICACAO as readonly string[]).includes(finalidade)) {
      throw new IdentificacaoRecusada("Escolha a finalidade antes de abrir a identificação: ela fica registrada junto com a sua leitura.");
    }
    const rotulo = ROTULO_FINALIDADE_IDENTIFICACAO[finalidade] ?? finalidade;
    await auditoria.registrar_acesso_sensivel(tx, usuario, "acidente_identificacao", {
      servidor_id: acidentado.servidor_id,
      acidente_id: ocorrencia.id,
      acidentado_id,
      finalidade: rotulo,
    });
    if (ocorrencia.responsavel_id !== usuario.id) {
      await auditoria.registrar(tx, {
        entidade: ENTIDADE,
        entidade_id: ocorrencia.id,
        tipo_evento: auditoria.ACIDENTE_IDENTIFICACAO_FORA_RESPONSAVEL,
        descricao: `${ocorrencia.protocolo}: identificação do envolvido nº ${acidentado.ordem} aberta por quem não conduz o caso; finalidade: ${rotulo}.`,
        usuario,
      });
    }
  }
  const [linha] = await tx.select().from(acidente_identificacao).where(eq(acidente_identificacao.acidentado_id, acidentado_id));
  const testemunhas = await tx
    .select({ t: acidente_testemunha, c: acidente_testemunha_contato })
    .from(acidente_testemunha)
    .leftJoin(acidente_testemunha_contato, eq(acidente_testemunha_contato.testemunha_id, acidente_testemunha.id))
    .where(eq(acidente_testemunha.ocorrencia_id, ocorrencia.id))
    .orderBy(acidente_testemunha.id);
  return {
    acidentado_id,
    titular,
    existe: Boolean(linha),
    sexo: linha?.sexo ?? null,
    cpf_exibicao: linha?.cpf ? textos.CPF_MASCARADO : null,
    rg: linha?.rg ?? null,
    data_nascimento: linha?.data_nascimento ?? null,
    endereco: {
      cep: formatar_cep(linha?.cep ?? null),
      logradouro: linha?.logradouro ?? null,
      numero: linha?.numero ?? null,
      complemento: linha?.complemento ?? null,
      bairro: linha?.bairro ?? null,
      cidade: linha?.cidade ?? null,
      uf: linha?.uf ?? null,
    },
    telefone: formatar_telefone(linha?.telefone ?? null),
    email: linha?.email ?? null,
    testemunhas: testemunhas.map(({ t, c }) => ({
      id: t.id,
      nome: t.nome,
      contato: c
        ? {
            cep: formatar_cep(c.cep),
            logradouro: c.logradouro,
            numero: c.numero,
            complemento: c.complemento,
            bairro: c.bairro,
            municipio: c.municipio,
            uf: c.uf,
            telefone: formatar_telefone(c.telefone),
          }
        : null,
    })),
  };
}

/**
 * O que a aba mostra ANTES de abrir qualquer conteúdo: por acidentado, se a
 * pessoa é o titular, se pode abrir e se há algo informado. Não lê o conteúdo
 * nem grava acesso.
 */
export async function painel(
  tx: Executor,
  usuario: UsuarioAtual,
  ocorrencia: Ocorrencia,
  acidentados: { id: number; servidor_id: number | null }[],
) {
  const ids = acidentados.map((a) => a.id);
  const com_dado = new Set(
    ids.length
      ? (await tx.select({ id: acidente_identificacao.acidentado_id }).from(acidente_identificacao).where(inArray(acidente_identificacao.acidentado_id, ids))).map((l) => l.id)
      : [],
  );
  return {
    ident_acidentados: acidentados
      .filter((a) => _alcanca(usuario, ocorrencia, a))
      .map((a) => {
        const titular = _eh_titular(usuario, a);
        return { id: a.id, titular, pode: titular || usuario.pode("acidente.identificacao_ver"), tem: com_dado.has(a.id) };
      }),
    FINALIDADES_IDENTIFICACAO,
    ROTULO_FINALIDADE_IDENTIFICACAO,
  };
}
