/**
 * Comunicar um acidente (fatia F1 do módulo de acidentes, CAT/SP).
 *
 * Quem comunica é uma CONTA (D1: na 1ª entrega, só logado): o próprio
 * acidentado, a chefia imediata com a própria conta (D9, "sou a chefia
 * imediata") ou a equipe de segurança do trabalho. O formulário por link (F2)
 * chama este mesmo `comunicar`, com `usuario = null`.
 *
 * Um ato só, numa transação: a ocorrência com o protocolo `CAT-AAAA-NNNN` (D7,
 * consumido aqui, no envio), os envolvidos, as testemunhas, o comunicante, a
 * CAT/SP versão 1 CONGELADA (contexto + SHA-256) e as pendências de triagem (2
 * dias) e do prazo legal (data do acidente + 10 dias, art. 214; D13).
 *
 * **Minimização (ROPA §4.3).** Nada de CPF, RG, nascimento, sexo, endereço ou
 * telefone pessoal: o formulário não pede, e o que tem cara de CPF em qualquer
 * campo de texto é recusado com a saída escrita. Os campos narrativos passam
 * pelo filtro de saúde no contexto de nexo ocupacional (a espécie "doença
 * relacionada ao trabalho" é nome de lei). A saúde que o comunicante declara
 * (D4: parte do corpo e SIM/NÃO/NÃO SEI de atendimento, afastamento, internação
 * e óbito) vai na CAT/SP em chave SEPARADA (`saude_declarada`), com a origem
 * DECLARADO_COMUNICANTE — quem a lê e a confirma é a fatia de saúde (F3).
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  acidentado as tabela_acidentado,
  acidente_agente_causador,
  acidente_agente_doenca,
  acidente_cat_sp,
  acidente_comunicante,
  acidente_ocorrencia,
  acidente_parte_corpo,
  acidente_situacao_geradora,
  acidente_testemunha,
  campus as tabela_campus,
  servidor as tabela_servidor,
  unidade_uorg,
  usuario as tabela_usuario,
} from "../db/esquema/index.js";
import {
  CONDICOES_ENVOLVIDO,
  ESPECIES,
  LOCAIS_DE_TRANSITO,
  LOCAIS_TIPO,
  SIM_NAO_NAO_SEI,
  VINCULOS_ACIDENTADO,
  montar_protocolo,
  prazo_de_comunicacao,
} from "../dominio/acidente.js";
import { hoje_iso } from "../dominio/datas.js";
import { RegraViolada } from "../nucleo/erros.js";
import { global } from "../web.js";
import * as acidente_email from "./acidente_email.js";
import * as acidente_saude from "./acidente_saude.js";
import * as auditoria from "./auditoria.js";
import * as identificacao from "./acidente_identificacao.js";
import { DadosFuncionaisInvalidos, faltam, resolver, type EntradaFuncional } from "./dados_funcionais.js";
import { completar_funcionais } from "./servidores.js";
import { proximo_numero_cat_sp } from "./numeracao.js";
import * as pendencias from "./pendencias.js";
import { PERFIS_EXTERNOS, type UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";

export type Ocorrencia = typeof acidente_ocorrencia.$inferSelect;

/** A recusa diz o campo (o rótulo da tela) e a saída. */
export class ComunicacaoRecusada extends RegraViolada {
  constructor(
    mensagem: string,
    public campo: string | null = null,
  ) {
    super(mensagem);
  }
}

export const MAXIMO_ENVOLVIDOS = 20;
export const MAXIMO_TESTEMUNHAS = 5;
export const TAMANHO_DESCRICAO = 4000;
export const TAMANHO_TEXTO_CURTO = 400;

/** CPF com ou sem pontuação, solto no texto (o banco também recusa na identificação externa). */
const RE_CPF = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/;

export interface SaudeDeclarada {
  partes_corpo_ids: number[];
  houve_atendimento: string | null;
  houve_afastamento: string | null;
  houve_internacao: string | null;
  houve_obito: string | null;
}

export interface Envolvido {
  vinculo: string;
  /** a própria pessoa logada é este envolvido */
  sou_eu: boolean;
  /** servidor do cadastro, pelo SIAPE (vínculo SERVIDOR) */
  siape: string | null;
  /** quem não é servidor: nome e, se houver, matrícula ou crachá — nunca CPF */
  nome_externo: string | null;
  identificacao_externa: string | null;
  empresa_contratada: string | null;
  condicao: string;
  houve_lesao: string | null;
  contato_investigacao: string | null;
  menor_de_idade: boolean;
  /** cargo e lotação, para completar o cadastro do servidor quando faltam */
  funcional?: EntradaFuncional;
  saude: SaudeDeclarada;
  /** Anexo III: identificação pessoal (bloco restrito; só com conta, nunca no contexto congelado) */
  identificacao?: identificacao.DadosIdentificacao;
}

export interface Testemunha {
  nome: string;
  vinculo: string | null;
  contato: string | null;
  /** Anexo III: endereço e telefone da testemunha (bloco restrito; fora do contexto congelado) */
  endereco?: identificacao.ContatoTestemunha;
}

export interface Fatos {
  especie: string;
  data_evento: string;
  hora_evento: string | null;
  minutos_apos_inicio_jornada: number | null;
  ultimo_dia_trabalho: string | null;
  local_tipo: string;
  local_especificacao: string;
  campus_id: number | null;
  local_municipio: string | null;
  local_uf: string | null;
  local_cnpj_contratada: string | null;
  transito_registro_policial: string | null;
  transito_numero_bo: string | null;
  transito_vitima_terceiros: string | null;
  agente_causador_id: number | null;
  agente_doenca_id: number | null;
  situacao_geradora_id: number | null;
}

export interface Relato {
  descricao: string;
  atividade_no_momento: string | null;
}

export interface DadosComunicacao {
  fatos: Fatos;
  relato: Relato;
  envolvidos: Envolvido[];
  testemunhas: Testemunha[];
  /** D9: a chefia comunica com a própria conta e marca isto */
  sou_chefia: boolean;
  declarou_veracidade: boolean;
  /** só no formulário por link (F2), quando não há conta: quem comunica se identifica */
  comunicante?: { nome: string; email: string; vinculo: string } | null;
  /** o número do envio do formulário (campo oculto): o mesmo envio repetido não cria outra CAT */
  token_envio?: string | null;
}

/** O número de envio que o formulário carrega, gerado ao abri-lo (`{{ token_de_envio() }}`). */
global("token_de_envio", () => randomUUID());
const PADRAO_TOKEN = /^[A-Za-z0-9-]{16,40}$/;

// ---------------------------------------------------------------------
// Conferências
// ---------------------------------------------------------------------
function _sem_cpf(valor: string | null | undefined, campo: string): void {
  if (valor && RE_CPF.test(valor)) {
    throw new ComunicacaoRecusada(
      `O campo ${campo} tem um número com formato de CPF. CPF não é registrado na comunicação ` +
        "(LGPD, minimização): para servidor, use o SIAPE; para quem não é servidor, o nome e, se houver, " +
        "a matrícula ou o crachá.",
      campo,
    );
  }
}

function _texto(valor: string | null | undefined, campo: string, maximo = TAMANHO_TEXTO_CURTO): string | null {
  const limpo = (valor ?? "").replace(/\s+/g, " ").trim();
  if (!limpo) return null;
  if (limpo.length > maximo) throw new ComunicacaoRecusada(`O campo ${campo} passa de ${maximo} caracteres.`, campo);
  _sem_cpf(limpo, campo);
  return limpo;
}

/** Narrativo: CPF fora e o filtro de saúde no contexto de nexo ocupacional. */
function _narrativo(valor: string | null | undefined, campo: string, maximo: number): string | null {
  const bruto = (valor ?? "").trim();
  if (!bruto) return null;
  if (bruto.length > maximo) throw new ComunicacaoRecusada(`O campo ${campo} passa de ${maximo} caracteres.`, campo);
  _sem_cpf(bruto, campo);
  try {
    textos.exigir_texto_limpo(bruto, campo, textos.CONTEXTO_NEXO_OCUPACIONAL);
  } catch (erro) {
    if (!(erro instanceof textos.TextoProibido)) throw erro;
    throw new ComunicacaoRecusada(
      `O campo ${campo} tem termo de saúde ou dado sensível (${textos.termos_proibidos_em(bruto, textos.CONTEXTO_NEXO_OCUPACIONAL).join(", ")}). ` +
        "Descreva o evento — o que aconteceu, onde, com que equipamento —, e não o corpo nem o diagnóstico: " +
        "a parte do corpo atingida se marca na lista do envolvido, e a saúde é registrada pelo médico do trabalho.",
      campo,
    );
  }
  return bruto;
}

function _da_lista(valor: string | null | undefined, lista: readonly string[], campo: string, obrigatorio = false): string | null {
  const v = (valor ?? "").trim();
  if (!v) {
    if (obrigatorio) throw new ComunicacaoRecusada(`Escolha ${campo} na lista.`, campo);
    return null;
  }
  if (!lista.includes(v)) throw new ComunicacaoRecusada(`Escolha ${campo} na lista.`, campo);
  return v;
}

function _data(valor: string | null | undefined, campo: string, obrigatorio = false): string | null {
  const v = (valor ?? "").trim();
  if (!v) {
    if (obrigatorio) throw new ComunicacaoRecusada(`Informe ${campo}.`, campo);
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new ComunicacaoRecusada(`${campo} não é uma data válida.`, campo);
  }
  if (v > hoje_iso()) throw new ComunicacaoRecusada(`${campo} não pode ser depois de hoje.`, campo);
  return v;
}

async function _do_catalogo(
  tx: Executor,
  tabela: typeof acidente_agente_causador | typeof acidente_agente_doenca | typeof acidente_situacao_geradora,
  id: number | null,
  campo: string,
): Promise<number | null> {
  if (id === null) return null;
  const [linha] = await tx.select({ id: tabela.id, ativo: tabela.ativo }).from(tabela).where(eq(tabela.id, id));
  if (!linha || !linha.ativo) throw new ComunicacaoRecusada(`Escolha ${campo} na lista.`, campo);
  return linha.id;
}

/** Confere e normaliza os fatos do evento (também na retificação). */
export async function conferir_fatos(tx: Executor, f: Fatos): Promise<Fatos> {
  const especie = _da_lista(f.especie, ESPECIES, "a espécie do acidente", true)!;
  const data_evento = _data(f.data_evento, "a data do acidente", true)!;
  const hora = (f.hora_evento ?? "").trim();
  if (hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) {
    throw new ComunicacaoRecusada("A hora do acidente vai no formato HH:MM.", "a hora do acidente");
  }
  const minutos = f.minutos_apos_inicio_jornada;
  if (minutos !== null && (!Number.isInteger(minutos) || minutos < 0 || minutos > 48 * 60)) {
    throw new ComunicacaoRecusada("O tempo desde o início da jornada não confere.", "o tempo de jornada");
  }
  const ultimo = _data(f.ultimo_dia_trabalho, "o último dia trabalhado");
  const local_tipo = _da_lista(f.local_tipo, LOCAIS_TIPO, "o tipo de local", true)!;
  const local_especificacao = _narrativo(f.local_especificacao, "onde foi", TAMANHO_TEXTO_CURTO);
  if (!local_especificacao) throw new ComunicacaoRecusada("Diga onde foi o acidente (sala, prédio, trecho).", "onde foi");
  let campus_id: number | null = null;
  if (f.campus_id !== null) {
    const [c] = await tx.select({ id: tabela_campus.id }).from(tabela_campus).where(eq(tabela_campus.id, f.campus_id));
    if (!c) throw new ComunicacaoRecusada("Escolha o campus na lista.", "o campus");
    campus_id = c.id;
  }
  const uf = (f.local_uf ?? "").trim().toUpperCase() || null;
  if (uf && !/^[A-Z]{2}$/.test(uf)) throw new ComunicacaoRecusada("A UF tem duas letras (MG).", "a UF");
  const cnpj = (f.local_cnpj_contratada ?? "").trim() || null;
  if (cnpj && !/^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/.test(cnpj)) {
    throw new ComunicacaoRecusada("O CNPJ da contratada vai como 00.000.000/0000-00.", "o CNPJ da contratada");
  }
  // o bloco de trânsito só vale quando o acidente é de trajeto ou em via
  const de_transito = especie === "TRAJETO" || LOCAIS_DE_TRANSITO.has(local_tipo);
  return {
    especie,
    data_evento,
    hora_evento: hora || null,
    minutos_apos_inicio_jornada: minutos,
    ultimo_dia_trabalho: ultimo,
    local_tipo,
    local_especificacao,
    campus_id,
    local_municipio: _texto(f.local_municipio, "o município", 80),
    local_uf: uf,
    local_cnpj_contratada: cnpj,
    transito_registro_policial: de_transito
      ? _da_lista(f.transito_registro_policial, SIM_NAO_NAO_SEI, "se houve registro policial")
      : null,
    transito_numero_bo: de_transito ? _texto(f.transito_numero_bo, "o número do boletim", 40) : null,
    transito_vitima_terceiros: de_transito
      ? _da_lista(f.transito_vitima_terceiros, SIM_NAO_NAO_SEI, "se houve vítima de terceiros")
      : null,
    agente_causador_id: await _do_catalogo(tx, acidente_agente_causador, f.agente_causador_id, "o agente causador"),
    // o agente da doença só existe na espécie doença relacionada ao trabalho
    agente_doenca_id:
      especie === "DOENCA_TRABALHO"
        ? await _do_catalogo(tx, acidente_agente_doenca, f.agente_doenca_id, "o agente da doença")
        : null,
    situacao_geradora_id: await _do_catalogo(tx, acidente_situacao_geradora, f.situacao_geradora_id, "a situação geradora"),
  };
}

export function conferir_relato(r: Relato): Relato {
  const descricao = _narrativo(r.descricao, "o que aconteceu", TAMANHO_DESCRICAO);
  if (!descricao) throw new ComunicacaoRecusada("Descreva o que aconteceu.", "o que aconteceu");
  return { descricao, atividade_no_momento: _narrativo(r.atividade_no_momento, "a atividade no momento", TAMANHO_TEXTO_CURTO) };
}

interface EnvolvidoResolvido extends Envolvido {
  servidor: typeof tabela_servidor.$inferSelect | null;
  campus_snapshot: number | null;
  /** formulário por link: o SIAPE como foi digitado, sem consulta */
  siape_digitado: string | null;
}

/**
 * O vínculo do acidentado que o perfil externo da conta diz (terceirizado →
 * TERCEIRIZADO, discente → ESTUDANTE), ou `null` para a conta sem perfil
 * externo. É o que o "Sou eu" da conta sem servidor grava, e o que a tela de
 * comunicar pré-seleciona.
 */
export function vinculo_externo_de(usuario: UsuarioAtual | null): string | null {
  if (!usuario) return null;
  const externos = usuario.perfis.filter((p) => PERFIS_EXTERNOS.includes(p));
  if (externos.includes("terceirizado")) return "TERCEIRIZADO";
  if (externos.includes("discente")) return "ESTUDANTE";
  return null;
}

async function _resolver_envolvidos(
  tx: Executor,
  usuario: UsuarioAtual | null,
  lista: Envolvido[],
): Promise<EnvolvidoResolvido[]> {
  if (!lista.length) throw new ComunicacaoRecusada("Informe pelo menos um envolvido no acidente.", "os envolvidos");
  if (lista.length > MAXIMO_ENVOLVIDOS) {
    throw new ComunicacaoRecusada(`São no máximo ${MAXIMO_ENVOLVIDOS} envolvidos por comunicação.`, "os envolvidos");
  }
  const partes_validas = new Set(
    (await tx.select({ id: acidente_parte_corpo.id }).from(acidente_parte_corpo).where(eq(acidente_parte_corpo.ativo, true))).map(
      (p) => p.id,
    ),
  );
  const vistos = new Set<number>();
  let ja_sou_eu = false;
  const saida: EnvolvidoResolvido[] = [];
  for (const [i, e] of lista.entries()) {
    const n = i + 1;
    const rotulo = `do envolvido ${n}`;
    const vinculo = _da_lista(e.vinculo, VINCULOS_ACIDENTADO, `o vínculo ${rotulo}`, true)!;
    const condicao = _da_lista(e.condicao, CONDICOES_ENVOLVIDO, `a condição ${rotulo}`, true)!;
    // a CAT/SP é do servidor (decisão de 30/10/2026): quem não é servidor vai por Ocorrências
    if (vinculo !== "SERVIDOR") {
      throw new ComunicacaoRecusada(
        `A análise de acidentes e a CAT/SP valem só para servidor. Para quem não é servidor (${rotulo}), ` +
          "use o módulo Ocorrências.",
        `o vínculo ${rotulo}`,
      );
    }
    let servidor: typeof tabela_servidor.$inferSelect | null = null;
    // sem conta (formulário por link), nada se consulta no cadastro: o SIAPE
    // digitado é guardado como veio e a equipe vincula depois — consultar daria
    // ao anônimo o oráculo "este SIAPE existe"
    const publico = usuario === null;
    let siape_digitado: string | null = null;
    // o "Sou eu" da conta externa (terceirizado, discente): sem cadastro de
    // servidor, entra pelo nome da CONTA (lido do banco, não do formulário) e
    // com o vínculo do perfil
    let externo_proprio: { nome: string; vinculo: string } | null = null;
    if (publico) {
      const so_digitos = (e.siape ?? "").replace(/\D/g, "");
      siape_digitado = /^\d{7}$/.test(so_digitos) ? so_digitos : null;
    } else if (e.sou_eu) {
      if (ja_sou_eu) {
        throw new ComunicacaoRecusada(`O envolvido ${n} repete você, já informado.`, `o envolvido ${n}`);
      }
      ja_sou_eu = true;
      const vinculo_externo = usuario ? vinculo_externo_de(usuario) : null;
      if (usuario && usuario.servidor_id === null && vinculo_externo !== null) {
        const [conta] = await tx
          .select({ nome: tabela_usuario.nome })
          .from(tabela_usuario)
          .where(eq(tabela_usuario.id, usuario.id));
        const nome = (conta?.nome ?? "").trim();
        if (!nome) {
          throw new ComunicacaoRecusada(
            "Sua conta não tem nome cadastrado: desmarque \"Sou eu\" e informe o seu nome no envolvido.",
            `o nome ${rotulo}`,
          );
        }
        externo_proprio = { nome: nome.slice(0, 160), vinculo: vinculo_externo };
      } else if (!usuario || usuario.servidor_id === null) {
        throw new ComunicacaoRecusada(
          "Sua conta não está ligada a um cadastro de servidor: informe o seu SIAPE no envolvido.",
          `o SIAPE ${rotulo}`,
        );
      } else {
        [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, usuario.servidor_id));
      }
    } else if (vinculo === "SERVIDOR") {
      const siape = (e.siape ?? "").replace(/\D/g, "");
      if (!/^\d{7}$/.test(siape)) {
        throw new ComunicacaoRecusada(`Informe o SIAPE (7 dígitos) ${rotulo}.`, `o SIAPE ${rotulo}`);
      }
      [servidor] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.siape, siape));
      if (!servidor) {
        throw new ComunicacaoRecusada(
          `O SIAPE ${siape} ${rotulo} não está no cadastro de servidores. Confira o número ou, se a pessoa ` +
            "não for servidora, escolha outro vínculo e informe o nome.",
          `o SIAPE ${rotulo}`,
        );
      }
    }
    // cargo e lotação faltando no cadastro (26/10/2026): o que veio no formulário
    // completa (sem sobrescrever); para quem é o próprio envolvido, é obrigatório
    if (servidor && usuario && e.funcional) {
      const falta = faltam(servidor);
      if (falta.cargo || falta.lotacao) {
        let r;
        try {
          r = await resolver(tx, e.funcional, usuario);
        } catch (erro) {
          if (erro instanceof DadosFuncionaisInvalidos) throw new ComunicacaoRecusada(`${erro.message}.`, `o cargo ${rotulo}`);
          throw erro;
        }
        await completar_funcionais(tx, servidor, usuario, r, "na comunicação de acidente");
      }
      const ainda = faltam(servidor);
      if (e.sou_eu && (ainda.cargo || ainda.lotacao)) {
        const o_que = [ainda.cargo ? "o cargo" : null, ainda.lotacao ? "a lotação" : null].filter(Boolean).join(" e ");
        throw new ComunicacaoRecusada(
          `Informe ${o_que} no seu cadastro (escolha na lista ou digite em «Não está na lista?») antes de comunicar.`,
          `o cargo ${rotulo}`,
        );
      }
    }
    if (servidor) {
      if (vistos.has(servidor.id)) {
        throw new ComunicacaoRecusada(`O envolvido ${n} repete um servidor já informado.`, `o SIAPE ${rotulo}`);
      }
      vistos.add(servidor.id);
    }
    const nome_externo = servidor
      ? null
      : (externo_proprio?.nome ?? _texto(e.nome_externo, `o nome ${rotulo}`, 160));
    if (!servidor && !nome_externo) {
      throw new ComunicacaoRecusada(`Informe o nome ${rotulo} (quem não é servidor entra pelo nome).`, `o nome ${rotulo}`);
    }
    const identificacao_externa = servidor ? null : _texto(e.identificacao_externa, `a matrícula ou crachá ${rotulo}`, 40);
    let campus_snapshot: number | null = null;
    if (servidor?.unidade_uorg_id) {
      const [u] = await tx
        .select({ campus_id: unidade_uorg.campus_id })
        .from(unidade_uorg)
        .where(eq(unidade_uorg.id, servidor.unidade_uorg_id));
      campus_snapshot = u?.campus_id ?? null;
    }
    const partes = [...new Set(e.saude.partes_corpo_ids)].filter((p) => partes_validas.has(p));
    saida.push({
      ...e,
      vinculo: servidor ? "SERVIDOR" : (externo_proprio?.vinculo ?? vinculo),
      siape_digitado,
      condicao,
      servidor: servidor ?? null,
      nome_externo,
      identificacao_externa,
      empresa_contratada: _texto(e.empresa_contratada, `a empresa ${rotulo}`, 160),
      houve_lesao: _da_lista(e.houve_lesao, SIM_NAO_NAO_SEI, `se houve lesão ${rotulo}`),
      contato_investigacao: _texto(e.contato_investigacao, `o contato ${rotulo}`, 160),
      campus_snapshot,
      saude: {
        partes_corpo_ids: partes,
        houve_atendimento: _da_lista(e.saude.houve_atendimento, SIM_NAO_NAO_SEI, `o atendimento ${rotulo}`),
        houve_afastamento: _da_lista(e.saude.houve_afastamento, SIM_NAO_NAO_SEI, `o afastamento ${rotulo}`),
        houve_internacao: _da_lista(e.saude.houve_internacao, SIM_NAO_NAO_SEI, `a internação ${rotulo}`),
        houve_obito: _da_lista(e.saude.houve_obito, SIM_NAO_NAO_SEI, `o óbito ${rotulo}`),
      },
    });
  }
  return saida;
}

function _resolver_testemunhas(lista: Testemunha[]): { testemunhas: Testemunha[]; enderecos: (identificacao.ContatoTestemunha | null)[] } {
  const preenchidas = lista.filter(
    (t) => (t.nome ?? "").trim() || (t.contato ?? "").trim() || Object.values(t.endereco ?? {}).some((v) => (v ?? "").trim()),
  );
  if (preenchidas.length > MAXIMO_TESTEMUNHAS) {
    throw new ComunicacaoRecusada(`São no máximo ${MAXIMO_TESTEMUNHAS} testemunhas.`, "as testemunhas");
  }
  const enderecos: (identificacao.ContatoTestemunha | null)[] = [];
  const testemunhas = preenchidas.map((t, i) => {
    const nome = _texto(t.nome, `o nome da testemunha ${i + 1}`, 160);
    if (!nome) throw new ComunicacaoRecusada(`Informe o nome da testemunha ${i + 1}.`, `o nome da testemunha ${i + 1}`);
    enderecos.push(t.endereco ? identificacao.conferir_contato(t.endereco) : null);
    return {
      nome,
      vinculo: _da_lista(t.vinculo, VINCULOS_ACIDENTADO, `o vínculo da testemunha ${i + 1}`),
      contato: _texto(t.contato, `o contato da testemunha ${i + 1}`, 160),
    };
  });
  return { testemunhas, enderecos };
}

/** Quem comunica sem conta: nome, e-mail e vínculo (D14b), para a equipe poder voltar a ela. */
function _conferir_comunicante(c: DadosComunicacao["comunicante"]): { nome: string; email: string; vinculo: string } {
  const nome = _texto(c?.nome, "o seu nome", 160);
  if (!nome) throw new ComunicacaoRecusada("Informe o seu nome: a equipe precisa saber a quem voltar.", "o seu nome");
  const email = (c?.email ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
    throw new ComunicacaoRecusada("Informe um e-mail válido para contato.", "o seu e-mail");
  }
  const vinculo = _da_lista(c?.vinculo, VINCULOS_ACIDENTADO, "o seu vínculo com a UFVJM", true)!;
  return { nome, email, vinculo };
}

// ---------------------------------------------------------------------
// A CAT/SP congelada
// ---------------------------------------------------------------------
/** SHA-256 da serialização canônica (a mesma da trilha: chaves ordenadas). */
export function hash_do_contexto(contexto: unknown): string {
  return createHash("sha256").update(auditoria.corpo(contexto), "utf8").digest("hex");
}

export interface ContextoCatSp {
  protocolo: string;
  versao: number;
  origem_comunicacao: string;
  fatos: Fatos;
  relato: Relato;
  envolvidos: Record<string, unknown>[];
  testemunhas: Testemunha[];
  comunicante: { usuario_id: number | null; chefia_imediata: boolean; nome?: string; vinculo?: string };
  /** D4: o que o comunicante declarou; chave separada (a variante sem saúde a corta) */
  saude_declarada: (SaudeDeclarada & { ordem: number; origem: "DECLARADO_COMUNICANTE" })[];
  complementacoes: { pedido: string; resposta: string; respondida_em: string }[];
}

/** Grava a versão `versao` da CAT/SP e devolve a linha. Append-only: não há outro caminho. */
export async function gravar_cat_sp(
  tx: Executor,
  d: {
    ocorrencia_id: number;
    versao: number;
    contexto: ContextoCatSp;
    origem: string;
    registrada_por: number | null;
    substitui_id?: number | null;
    motivo_retificacao?: string | null;
  },
) {
  const [linha] = await tx
    .insert(acidente_cat_sp)
    .values({
      ocorrencia_id: d.ocorrencia_id,
      versao: d.versao,
      contexto_congelado: d.contexto,
      hash_conteudo: hash_do_contexto(d.contexto),
      origem: d.origem,
      registrada_por: d.registrada_por,
      substitui_id: d.substitui_id ?? null,
      motivo_retificacao: d.motivo_retificacao ?? null,
    })
    .returning();
  return linha!;
}

/** A versão vigente (a mais alta) da CAT/SP da ocorrência. */
export async function cat_sp_vigente(tx: Executor, ocorrencia: Pick<Ocorrencia, "id" | "cat_sp_versao">) {
  const [linha] = await tx
    .select()
    .from(acidente_cat_sp)
    .where(and(eq(acidente_cat_sp.ocorrencia_id, ocorrencia.id), eq(acidente_cat_sp.versao, ocorrencia.cat_sp_versao)));
  return linha ?? null;
}

// ---------------------------------------------------------------------
// Comunicar
// ---------------------------------------------------------------------
export function origem_de(usuario: UsuarioAtual | null, d: Pick<DadosComunicacao, "sou_chefia" | "envolvidos">): string {
  if (!usuario) return "PUBLICO";
  const e_o_proprio = d.envolvidos.some((e) => e.sou_eu);
  if (e_o_proprio) return "TITULAR";
  if (d.sou_chefia) return "CHEFIA";
  if (usuario.pode("acidente.triar")) return "SST";
  // o colega que viu e comunica com a própria conta: o legado não tinha essa
  // origem, e "titular" (quem tem conta e comunica) é a mais próxima
  return "TITULAR";
}

export interface ContextoDoPedido {
  ip?: string | null;
}

export async function comunicar(
  tx: Executor,
  usuario: UsuarioAtual | null,
  bruto: DadosComunicacao,
  pedido: ContextoDoPedido = {},
): Promise<Ocorrencia> {
  if (usuario) usuario.exigir("acidente.comunicar");
  if (!bruto.declarou_veracidade) {
    throw new ComunicacaoRecusada(
      "Marque a declaração de que as informações são verdadeiras para enviar a comunicação.",
      "a declaração",
    );
  }
  const comunicante_publico = usuario ? null : _conferir_comunicante(bruto.comunicante ?? null);
  const fatos = await conferir_fatos(tx, bruto.fatos);
  const relato = conferir_relato(bruto.relato);
  const envolvidos = await _resolver_envolvidos(tx, usuario, bruto.envolvidos);
  const { testemunhas, enderecos: enderecos_testemunhas } = _resolver_testemunhas(bruto.testemunhas);
  // Anexo III: a identificação só vem de quem tem conta, e é conferida antes de qualquer gravação.
  // A data de nascimento faz a ocorrência restrita quando o acidentado era menor no dia do acidente
  const identificacoes = envolvidos.map((e) => (usuario && e.identificacao ? identificacao.conferir(e.identificacao) : null));
  for (const [i, e] of envolvidos.entries()) {
    if (identificacao.era_menor_na_data(identificacoes[i]?.data_nascimento ?? null, fatos.data_evento)) e.menor_de_idade = true;
  }
  const origem = origem_de(usuario, bruto);

  // o acidentado principal (escopo próprio): o primeiro servidor acidentado, ou o primeiro servidor
  const principal =
    envolvidos.find((e) => e.servidor && e.condicao === "ACIDENTADO") ?? envolvidos.find((e) => e.servidor) ?? null;
  // o campus vem do local; sem ele, o do acidentado principal
  const campus_id = fatos.campus_id ?? principal?.campus_snapshot ?? null;
  const restrita_sst = envolvidos.some((e) => e.menor_de_idade);

  // Reenvio do mesmo formulário (clique duplo, "voltar" e enviar de novo): o
  // número do envio já gravou uma ocorrência — não cria outra (nem outra CAT).
  const token_envio = bruto.token_envio && PADRAO_TOKEN.test(bruto.token_envio) ? bruto.token_envio : null;
  if (token_envio) {
    const [ja] = await tx
      .select({ protocolo: acidente_ocorrencia.protocolo })
      .from(acidente_ocorrencia)
      .where(eq(acidente_ocorrencia.token_envio, token_envio))
      .limit(1);
    if (ja) {
      throw new ComunicacaoRecusada(
        `Esta comunicação já foi recebida (protocolo ${ja.protocolo}): o formulário foi enviado duas vezes, e vale o primeiro envio. Nada novo foi gravado.`,
        null,
      );
    }
  }

  const hoje = hoje_iso();
  const ano = Number(hoje.slice(0, 4));
  const numero = await proximo_numero_cat_sp(tx, ano);
  const protocolo = montar_protocolo(ano, numero);
  const [ocorrencia] = await tx
    .insert(acidente_ocorrencia)
    .values({
      protocolo,
      ano,
      numero,
      estado: "RECEBIDA",
      especie: fatos.especie,
      tipo_cat: "INICIAL",
      origem,
      data_evento: fatos.data_evento,
      hora_evento: fatos.hora_evento,
      minutos_apos_inicio_jornada: fatos.minutos_apos_inicio_jornada,
      ultimo_dia_trabalho: fatos.ultimo_dia_trabalho,
      local_tipo: fatos.local_tipo,
      local_especificacao: fatos.local_especificacao,
      campus_id,
      local_municipio: fatos.local_municipio,
      local_uf: fatos.local_uf,
      local_cnpj_contratada: fatos.local_cnpj_contratada,
      transito_registro_policial: fatos.transito_registro_policial,
      transito_numero_bo: fatos.transito_numero_bo,
      transito_vitima_terceiros: fatos.transito_vitima_terceiros,
      agente_causador_id: fatos.agente_causador_id,
      agente_doenca_id: fatos.agente_doenca_id,
      situacao_geradora_id: fatos.situacao_geradora_id,
      servidor_id: principal?.servidor?.id ?? null,
      prazo_comunicacao: prazo_de_comunicacao(fatos.data_evento),
      restrita_sst,
      criado_por: usuario ? usuario.id : null,
      token_envio,
    })
    .returning();
  const oc = ocorrencia!;

  const congelados: Record<string, unknown>[] = [];
  const declaracoes: { acidentado_id: number; saude: SaudeDeclarada }[] = [];
  for (const [i, e] of envolvidos.entries()) {
    const [criado] = await tx.insert(tabela_acidentado).values({
      ocorrencia_id: oc.id,
      ordem: i + 1,
      vinculo: e.vinculo,
      servidor_id: e.servidor?.id ?? null,
      nome_externo: e.nome_externo,
      identificacao_externa: e.identificacao_externa,
      empresa_contratada: e.empresa_contratada,
      condicao: e.condicao,
      houve_lesao: e.houve_lesao,
      cargo_id: e.servidor?.cargo_id ?? null,
      funcao: e.servidor?.funcao ?? null,
      unidade_uorg_id: e.servidor?.unidade_uorg_id ?? null,
      campus_id: e.campus_snapshot,
      siape: e.servidor?.siape ?? e.siape_digitado,
      contato_investigacao: e.contato_investigacao,
      menor_de_idade: e.menor_de_idade,
    }).returning({ id: tabela_acidentado.id });
    declaracoes.push({ acidentado_id: criado!.id, saude: e.saude });
    if (identificacoes[i]) await identificacao.gravar(tx, usuario, oc, { id: criado!.id, ordem: i + 1 }, identificacoes[i]!);
    congelados.push({
      ordem: i + 1,
      vinculo: e.vinculo,
      servidor_id: e.servidor?.id ?? null,
      siape: e.servidor?.siape ?? e.siape_digitado,
      nome: e.servidor?.nome ?? e.nome_externo,
      identificacao_externa: e.identificacao_externa,
      empresa_contratada: e.empresa_contratada,
      condicao: e.condicao,
      houve_lesao: e.houve_lesao,
      menor_de_idade: e.menor_de_idade,
      contato_investigacao: e.contato_investigacao,
    });
  }
  for (const [i, t] of testemunhas.entries()) {
    const [criada] = await tx
      .insert(acidente_testemunha)
      .values({ ocorrencia_id: oc.id, nome: t.nome, vinculo: t.vinculo, contato: t.contato })
      .returning({ id: acidente_testemunha.id });
    if (usuario && enderecos_testemunhas[i]) await identificacao.gravar_contato_testemunha(tx, usuario, oc, criada!.id, enderecos_testemunhas[i]!);
  }
  await tx.insert(acidente_comunicante).values({
    ocorrencia_id: oc.id,
    usuario_id: usuario ? usuario.id : null,
    nome: comunicante_publico?.nome ?? null,
    email: comunicante_publico?.email ?? null,
    vinculo: comunicante_publico?.vinculo ?? null,
    declarou_veracidade_em: new Date(),
    ip: usuario ? null : (pedido.ip ?? null),
  });

  const contexto: ContextoCatSp = {
    protocolo,
    versao: 1,
    origem_comunicacao: origem,
    fatos: { ...fatos, campus_id },
    relato,
    envolvidos: congelados,
    testemunhas,
    comunicante: {
      usuario_id: usuario ? usuario.id : null,
      chefia_imediata: bruto.sou_chefia,
      ...(comunicante_publico ? { nome: comunicante_publico.nome, vinculo: comunicante_publico.vinculo } : {}),
    },
    saude_declarada: envolvidos.map((e, i) => ({ ordem: i + 1, origem: "DECLARADO_COMUNICANTE" as const, ...e.saude })),
    complementacoes: [],
  };
  await gravar_cat_sp(tx, {
    ocorrencia_id: oc.id,
    versao: 1,
    contexto,
    origem: "COMUNICACAO",
    registrada_por: usuario ? usuario.id : null,
  });
  const [com_versao] = await tx
    .update(acidente_ocorrencia)
    .set({ cat_sp_versao: 1 })
    .where(eq(acidente_ocorrencia.id, oc.id))
    .returning();

  await auditoria.registrar(tx, {
    entidade: "acidente_ocorrencia",
    entidade_id: oc.id,
    tipo_evento: usuario ? auditoria.ACIDENTE_COMUNICADO : auditoria.ACIDENTE_COMUNICACAO_PUBLICA,
    // sem nome de ninguém: o protocolo, a espécie e quantos envolvidos
    descricao:
      `Acidente comunicado (${protocolo}): espécie ${fatos.especie}, ${envolvidos.length} envolvido(s), ` +
      `${testemunhas.length} testemunha(s), origem ${origem}` +
      (restrita_sst ? "; acidentado menor de idade — ocorrência restrita à SST" : "") +
      ".",
    usuario,
    ...(usuario ? {} : { usuario_nome: "formulário por link", ip: pedido.ip ?? null }),
  });

  await pendencias.abrir(tx, {
    tipo: "ACIDENTE_TRIAR",
    chave: `ACIDENTE_TRIAR:${oc.id}`,
    descricao: `Triar a comunicação ${protocolo}`,
    entidade: "acidente_ocorrencia",
    entidade_id: oc.id,
  });
  await pendencias.abrir(tx, {
    tipo: "ACIDENTE_PRAZO_COMUNICACAO",
    chave: `ACIDENTE_PRAZO_COMUNICACAO:${oc.id}`,
    descricao: `Prazo legal de comunicação de ${protocolo} (art. 214 da Lei 8.112)`,
    entidade: "acidente_ocorrencia",
    entidade_id: oc.id,
    prazo: com_versao!.prazo_comunicacao,
  });
  // a saúde declarada vira linha própria (F3) e pendência para o médico confirmar
  await acidente_saude.declarar(tx, com_versao!, declaracoes);
  await acidente_email.avisar_nova_comunicacao(tx, com_versao!, usuario);
  return com_versao!;
}

/** Os envolvidos e as testemunhas da ocorrência, na ordem. */
export async function envolvidos_de(tx: Executor, ocorrencia_id: number) {
  const acidentados = await tx
    .select()
    .from(tabela_acidentado)
    .where(eq(tabela_acidentado.ocorrencia_id, ocorrencia_id))
    .orderBy(tabela_acidentado.ordem);
  const ids = acidentados.map((a) => a.servidor_id).filter((v): v is number => v !== null);
  const servidores = ids.length ? await tx.select().from(tabela_servidor).where(inArray(tabela_servidor.id, ids)) : [];
  const por_id = new Map(servidores.map((s) => [s.id, s]));
  const testemunhas = await tx
    .select()
    .from(acidente_testemunha)
    .where(eq(acidente_testemunha.ocorrencia_id, ocorrencia_id))
    .orderBy(acidente_testemunha.id);
  return {
    acidentados: acidentados.map((a) => ({ ...a, servidor: a.servidor_id ? (por_id.get(a.servidor_id) ?? null) : null })),
    testemunhas,
  };
}
