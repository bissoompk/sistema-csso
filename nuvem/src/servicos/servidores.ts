/**
 * Cadastro do servidor e o histórico datado de lotação e cargo.
 * Porte de `app/servicos/servidores.py`.
 *
 * O servidor muda de unidade, de posto e de cargo. O adicional depende de ONDE e
 * EM QUE FUNÇÃO ele estava em cada período — sobrescrever o cadastro apagaria a
 * prova da exposição passada, que é justamente o que a aposentadoria especial
 * precisa depois. Por isso toda alteração fecha o período anterior e abre um novo.
 *
 * **Adaptação do porte.** O SQLAlchemy mutava o objeto e o `flush` gravava; aqui
 * cada mudança é um `update` explícito. `historico` devolve os períodos JÁ com
 * `unidade`, `uorg`, `cargo` e `postos` carregados (a `@property postos` do
 * Python vira um campo pronto), porque o template não consulta nada sozinho.
 */
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import {
  cargo as tabela_cargo,
  lotacao_posto,
  posto_trabalho,
  servidor as tabela_servidor,
  servidor_lotacao,
  unidade_uorg,
} from "../db/esquema/index.js";
import { hoje_iso, somar_dias } from "../dominio/datas.js";
import { UnidadeUorg, vigente_em } from "../dominio/organizacao.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import * as identificacao from "./identificacao.js";
import * as textos from "./textos.js";
import type { UsuarioAtual } from "./rbac.js";

export type Servidor = typeof tabela_servidor.$inferSelect;
export type PostoTrabalho = typeof posto_trabalho.$inferSelect;
export type Unidade = typeof unidade_uorg.$inferSelect;
export type Cargo = typeof tabela_cargo.$inferSelect;
type LinhaLotacao = typeof servidor_lotacao.$inferSelect;

/** O período com o que a tela e o parecer leem dele. */
export type ServidorLotacao = LinhaLotacao & {
  unidade: Unidade | null;
  uorg: Unidade | null;
  cargo: Cargo | null;
  vinculos_posto: { lotacao_id: number; posto_trabalho_id: number; ordem: number; posto: PostoTrabalho }[];
  /** a `@property postos` do Python: os postos na ordem de `lotacao_posto.ordem` */
  postos: PostoTrabalho[];
};

/**
 * Quem pode aparecer num seletor de servidor, filtrado pela RN-19.
 *
 * **Existe para o `<select>` de 975 opções parar de existir.** Quatro telas
 * montavam um seletor com o cadastro inteiro; a busca no servidor existia,
 * testada e correta, e servia UMA delas. Duas cópias do mesmo filtro já tinham
 * nascido — `/servidores` e a fila de EPI —, e a diferença entre elas era
 * silenciosa: uma casava e-mail institucional, a outra não.
 *
 * O critério não se reescreve aqui: é `identificacao.casa_a_busca`, que é onde a
 * RN-19 do lado do FILTRO mora e explica por que o SIAPE acha para todo mundo e
 * o nome só acha para quem já podia lê-lo. Uma cópia que esquecesse
 * `pode_ver_nominal` seria justamente o oráculo que a supressão existe para
 * fechar.
 *
 * **Sem busca a lista vem inteira, e isso é deliberado**: o seletor vazio
 * obrigaria a digitar antes de saber o que existe, e no balcão, com fila de pé,
 * isso é pior.
 */
export async function buscar(tx: Executor, q: string | null | undefined, usuario: UsuarioAtual | null): Promise<Servidor[]> {
  const itens = await tx.select().from(tabela_servidor).orderBy(asc(tabela_servidor.nome));
  const alvo = textos.chave_busca(q ?? "");
  if (!alvo) return itens;
  return itens.filter((sv) => identificacao.casa_a_busca(alvo, sv, usuario));
}

/** Mudança de lotação que quebraria a linha do tempo (o `ValueError` do Python). */
export class LotacaoInvalida extends RegraViolada {}

export interface Alteracao {
  campo: string;
  de: string;
  para: string;
}

const COM_RELACOES = {
  unidade: true,
  uorg: true,
  cargo: true,
  vinculos_posto: {
    with: { posto: true },
    orderBy: (lp: typeof lotacao_posto, { asc: crescente }: { asc: typeof asc }) => [crescente(lp.ordem)],
  },
} as const;

function completar(l: Omit<ServidorLotacao, "postos">): ServidorLotacao {
  return { ...l, postos: l.vinculos_posto.map((v) => v.posto) };
}

/** Os períodos do servidor, em ordem de início (e de id no empate). */
export async function historico(tx: Executor, servidor_id: number): Promise<ServidorLotacao[]> {
  const itens = await tx.query.servidor_lotacao.findMany({
    where: eq(servidor_lotacao.servidor_id, servidor_id),
    with: COM_RELACOES as any,
    orderBy: [asc(servidor_lotacao.vigencia_inicio), asc(servidor_lotacao.id)],
  });
  return (itens as unknown as Omit<ServidorLotacao, "postos">[]).map(completar);
}

/** O período vigente em `quando` ('AAAA-MM-DD'; padrão: hoje em America/Sao_Paulo). */
export async function lotacao_vigente(
  tx: Executor,
  servidor_id: number,
  quando: string | null = null,
): Promise<ServidorLotacao | null> {
  const dia = quando ?? hoje_iso();
  const linha = await historico(tx, servidor_id);
  for (let i = linha.length - 1; i >= 0; i--) {
    if (vigente_em(linha[i]!, dia)) return linha[i]!;
  }
  return null;
}

/** Onde o servidor estava naquela data — é o que o parecer antigo precisa. */
export function lotacao_em(tx: Executor, servidor_id: number, quando: string): Promise<ServidorLotacao | null> {
  return lotacao_vigente(tx, servidor_id, quando);
}

function _rotulo(valor: string | null | undefined): string {
  return valor || "—";
}

/** Os postos do período aberto — é a fonte única do 'onde ele trabalha hoje'. */
export async function postos_atuais(tx: Executor, servidor_id: number): Promise<PostoTrabalho[]> {
  const lotacao = await lotacao_vigente(tx, servidor_id);
  return lotacao ? lotacao.postos : [];
}

async function _nomes_de_postos(tx: Executor, ids: number[]): Promise<string> {
  if (!ids.length) return "—";
  const nomes: string[] = [];
  for (const ident of ids) {
    const [posto] = await tx.select().from(posto_trabalho).where(eq(posto_trabalho.id, ident));
    nomes.push(_rotulo(posto?.nome));
  }
  return nomes.join(" / ");
}

interface NovoPeriodo {
  unidade_uorg_id: number | null;
  uorg_id: number | null;
  cargo_id: number | null;
  funcao: string | null;
}

type PeriodoComparavel = {
  unidade_uorg_id: number | null;
  uorg_id: number | null;
  cargo_id: number | null;
  funcao: string | null;
  postos?: PostoTrabalho[];
};

async function _unidade(tx: Executor, id: number | null | undefined): Promise<Unidade | null> {
  if (id === null || id === undefined) return null;
  const [u] = await tx.select().from(unidade_uorg).where(eq(unidade_uorg.id, id));
  return u ?? null;
}

async function _diferencas(
  tx: Executor,
  atual: PeriodoComparavel | null,
  novo: NovoPeriodo,
  postos: number[],
): Promise<Alteracao[]> {
  const nome_unidade = async (id: number | null | undefined) => {
    if (id === null || id === undefined) return "—";
    return _rotulo((await _unidade(tx, id))?.nome_extenso);
  };
  const nome_uorg = async (id: number | null | undefined) => {
    if (id === null || id === undefined) return "—";
    const u = await _unidade(tx, id);
    return u ? _rotulo(UnidadeUorg.uorg_bruto(u)) : "—";
  };
  const nome_cargo = async (id: number | null | undefined) => {
    if (id === null || id === undefined) return "—";
    const [c] = await tx.select().from(tabela_cargo).where(eq(tabela_cargo.id, id));
    return _rotulo(c?.nome);
  };
  const antes: Record<string, string> = {
    unidade: atual ? await nome_unidade(atual.unidade_uorg_id) : "—",
    UORG: atual ? await nome_uorg(atual.uorg_id) : "—",
    posto: atual && atual.postos && atual.postos.length ? atual.postos.map((p) => p.nome).join(" / ") : "—",
    cargo: atual ? await nome_cargo(atual.cargo_id) : "—",
    "função": (atual ? atual.funcao : null) || "—",
  };
  const depois: Record<string, string> = {
    unidade: await nome_unidade(novo.unidade_uorg_id),
    UORG: await nome_uorg(novo.uorg_id),
    posto: await _nomes_de_postos(tx, postos),
    cargo: await nome_cargo(novo.cargo_id),
    "função": novo.funcao || "—",
  };
  return Object.keys(antes)
    .filter((campo) => antes[campo] !== depois[campo])
    .map((campo) => ({ campo, de: antes[campo]!, para: depois[campo]! }));
}

/** Corrige os dados de identificação. Lotação e cargo mudam pelo histórico. */
export async function atualizar_cadastro(
  tx: Executor,
  servidor: Servidor,
  usuario: UsuarioAtual,
  d: { nome: string; siape: string; email: string | null; situacao: string },
): Promise<Servidor> {
  usuario.exigir("processo.editar");
  // RN-19: quem não pode LER nome e SIAPE também não os corrige. A tela já
  // esconde o formulário, mas esconder botão não é guarda: o POST continua
  // chegando, e sem esta linha a secretaria sobrescreveria às cegas o nome que
  // a lista ao lado se recusa a lhe mostrar.
  usuario.exigir("exposicao.ver");
  const limpo = (d.siape ?? "").replace(/\D/g, "");
  if (!/^\d{7}$/.test(limpo)) throw new LotacaoInvalida("a matrícula SIAPE tem exatamente 7 dígitos");
  if (!(d.nome ?? "").trim()) throw new LotacaoInvalida("o nome não pode ficar em branco");

  if (limpo !== servidor.siape) {
    const [ja] = await tx
      .select()
      .from(tabela_servidor)
      .where(and(eq(tabela_servidor.siape, limpo), ne(tabela_servidor.id, servidor.id)));
    if (ja) throw new LotacaoInvalida(`o SIAPE ${limpo} já é de '${ja.nome}'`);
  }

  const antes = { nome: servidor.nome, siape: servidor.siape, email: servidor.email, situacao: servidor.situacao };
  const depois = {
    nome: d.nome.trim(),
    siape: limpo,
    email: (d.email ?? "").trim() || null,
    situacao: d.situacao || "ATIVO",
  };
  const [gravado] = await tx.update(tabela_servidor).set(depois).where(eq(tabela_servidor.id, servidor.id)).returning();
  Object.assign(servidor, depois);
  await auditoria.registrar_diferencas(tx, {
    entidade: "servidor",
    entidade_id: servidor.id,
    antes,
    depois,
    usuario,
  });
  return gravado!;
}

async function _gravar_postos(tx: Executor, lotacao_id: number, postos: number[]): Promise<void> {
  // apaga o vínculo antigo antes de reinserir: a chave primária é
  // (lotacao, posto) e não aceita os dois ao mesmo tempo
  await tx.delete(lotacao_posto).where(eq(lotacao_posto.lotacao_id, lotacao_id));
  const unicos = [...new Set(postos)];
  if (!unicos.length) return;
  await tx
    .insert(lotacao_posto)
    .values(unicos.map((posto_trabalho_id, i) => ({ lotacao_id, posto_trabalho_id, ordem: i + 1 })));
}

/**
 * O período de origem com o que já está no cadastro, ainda FORA do banco.
 *
 * Separado de `registrar_lotacao_inicial` porque `alterar_lotacao` precisa
 * comparar com esse período antes de decidir se aceita a mudança — e não pode
 * gravá-lo enquanto a decisão não sair.
 */
function _montar_lotacao_inicial(
  servidor: Servidor,
  usuario: UsuarioAtual | null,
  inicio: string | null = null,
  documento: string | null = null,
): typeof servidor_lotacao.$inferInsert {
  return {
    servidor_id: servidor.id,
    unidade_uorg_id: servidor.unidade_uorg_id,
    uorg_id: servidor.uorg_id,
    cargo_id: servidor.cargo_id,
    funcao: servidor.funcao,
    vigencia_inicio: inicio ?? hoje_iso(),
    documento,
    registrado_por: usuario ? usuario.id : null,
  };
}

/** Abre o primeiro período com o que já está no cadastro. */
export async function registrar_lotacao_inicial(
  tx: Executor,
  servidor: Servidor,
  usuario: UsuarioAtual | null,
  opcoes: { inicio?: string | null; documento?: string | null; postos?: number[] | null } = {},
): Promise<ServidorLotacao> {
  const linha = await historico(tx, servidor.id);
  if (linha.length) return linha[linha.length - 1]!;
  const [lotacao] = await tx
    .insert(servidor_lotacao)
    .values(_montar_lotacao_inicial(servidor, usuario, opcoes.inicio ?? null, opcoes.documento ?? null))
    .returning();
  if (opcoes.postos && opcoes.postos.length) await _gravar_postos(tx, lotacao!.id, opcoes.postos);
  const recarregada = await historico(tx, servidor.id);
  return recarregada[recarregada.length - 1]!;
}

/** Fecha o período corrente na véspera e abre o novo. Nada é sobrescrito. */
export async function alterar_lotacao(
  tx: Executor,
  servidor: Servidor,
  usuario: UsuarioAtual,
  d: {
    unidade_uorg_id: number | null;
    cargo_id: number | null;
    funcao: string | null;
    a_partir_de: string;
    uorg_id?: number | null;
    postos?: number[] | null;
    documento?: string | null;
    observacao?: string | null;
  },
): Promise<ServidorLotacao> {
  usuario.exigir("processo.editar");
  const a_partir_de = d.a_partir_de;
  const uorg_id = d.uorg_id ?? null;
  const hoje = hoje_iso();

  const linha = await historico(tx, servidor.id);
  let origem_pendente: typeof servidor_lotacao.$inferInsert | null = null;
  let ultima: PeriodoComparavel & { id?: number; vigencia_inicio: string; vigencia_fim: string | null };
  if (!linha.length) {
    // Cadastro antigo, sem histórico: o período de origem é MONTADO agora,
    // porque as checagens abaixo comparam com ele, mas só entra no banco
    // depois que todas passarem. Gravá-lo antes deixava um período fantasma
    // sempre que a mudança era recusada (a rota devolve a ficha com o aviso, e
    // retorno normal commita). Pior, na tentativa seguinte o fantasma virava o
    // "período atual" e passava a barrar datas anteriores a ele.
    const vespera = somar_dias(a_partir_de, -1);
    origem_pendente = _montar_lotacao_inicial(servidor, usuario, vespera < hoje ? vespera : hoje);
    ultima = {
      unidade_uorg_id: origem_pendente.unidade_uorg_id ?? null,
      uorg_id: origem_pendente.uorg_id ?? null,
      cargo_id: origem_pendente.cargo_id ?? null,
      funcao: origem_pendente.funcao ?? null,
      postos: [],
      vigencia_inicio: origem_pendente.vigencia_inicio,
      vigencia_fim: null,
    };
  } else {
    ultima = linha[linha.length - 1]!;
  }
  // Corrigir no mesmo dia em que o período começou não cria período novo: ele
  // teria duração zero e não há nada a preservar. É o caso comum de cadastrar o
  // servidor e ajustar a lotação em seguida.
  const mesmo_dia = a_partir_de === ultima.vigencia_inicio && ultima.vigencia_fim === null;
  if (a_partir_de < ultima.vigencia_inicio) {
    throw new LotacaoInvalida(
      "a nova lotação precisa começar em ou depois do início da atual " + `(${ultima.vigencia_inicio})`,
    );
  }

  const escolhidos = (d.postos ?? []).filter((p) => p);
  const novo: NovoPeriodo = {
    unidade_uorg_id: d.unidade_uorg_id,
    uorg_id,
    cargo_id: d.cargo_id,
    funcao: (d.funcao ?? "").trim() || null,
  };
  const mudancas = await _diferencas(tx, ultima, novo, escolhidos);
  if (!mudancas.length) {
    throw new LotacaoInvalida("nada mudou: unidade, UORG, posto, cargo e função são os mesmos");
  }

  if (escolhidos.length) {
    const postos = await tx.select().from(posto_trabalho).where(inArray(posto_trabalho.id, escolhidos));
    const por_id = new Map(postos.map((p) => [p.id, p]));
    for (const posto_id of escolhidos) {
      const posto = por_id.get(posto_id);
      if (!posto) continue;
      if (d.unidade_uorg_id !== null && posto.unidade_uorg_id !== d.unidade_uorg_id) {
        throw new LotacaoInvalida(
          `o posto '${posto.nome}' pertence a outra unidade — escolha postos ` + "da unidade selecionada",
        );
      }
    }
  }

  // daqui para baixo não há mais recusa: agora pode escrever
  if (origem_pendente !== null) {
    const [gravada] = await tx.insert(servidor_lotacao).values(origem_pendente).returning();
    ultima = { ...ultima, id: gravada!.id };
  }

  let lotacao_id: number;
  if (mesmo_dia) {
    lotacao_id = ultima.id!;
    const campos: Partial<LinhaLotacao> = { ...novo };
    if (d.documento) campos.documento = d.documento.trim();
    if (d.observacao) campos.observacao = d.observacao.trim();
    await tx.update(servidor_lotacao).set(campos).where(eq(servidor_lotacao.id, lotacao_id));
  } else {
    // fecha o período anterior na véspera: sem lacuna e sem sobreposição
    await tx
      .update(servidor_lotacao)
      .set({ vigencia_fim: somar_dias(a_partir_de, -1) })
      .where(eq(servidor_lotacao.id, ultima.id!));
    const [nova] = await tx
      .insert(servidor_lotacao)
      .values({
        servidor_id: servidor.id,
        vigencia_inicio: a_partir_de,
        documento: (d.documento ?? "").trim() || null,
        observacao: (d.observacao ?? "").trim() || null,
        registrado_por: usuario.id,
        ...novo,
      })
      .returning();
    lotacao_id = nova!.id;
  }
  await _gravar_postos(tx, lotacao_id, escolhidos);

  // o cadastro passa a refletir o período mais recente
  if (a_partir_de <= hoje) {
    const atual = {
      unidade_uorg_id: d.unidade_uorg_id,
      uorg_id,
      cargo_id: d.cargo_id,
      funcao: novo.funcao,
    };
    await tx.update(tabela_servidor).set(atual).where(eq(tabela_servidor.id, servidor.id));
    Object.assign(servidor, atual);
  }

  await auditoria.registrar(tx, {
    entidade: "servidor",
    entidade_id: servidor.id,
    tipo_evento: "LOTACAO_ALTERADA",
    descricao:
      `A partir de ${a_partir_de}: ` +
      mudancas.map((m) => `${m.campo} ${m.de} → ${m.para}`).join("; ") +
      (d.documento ? ` (documento: ${d.documento})` : ""),
    usuario,
  });
  for (const mudanca of mudancas) {
    await auditoria.registrar(tx, {
      entidade: "servidor_lotacao",
      entidade_id: lotacao_id,
      tipo_evento: "CAMPO_ALTERADO",
      descricao: `${mudanca.campo}: ${mudanca.de} → ${mudanca.para}`,
      campo: mudanca.campo,
      valor_anterior: mudanca.de,
      valor_novo: mudanca.para,
      usuario,
    });
  }
  const recarregada = await historico(tx, servidor.id);
  return recarregada.find((l) => l.id === lotacao_id)!;
}

/**
 * Corrige só o documento e a observação. Data e destino não se corrigem: para
 * isso existe um novo período — senão a linha do tempo vira ficção.
 */
export async function corrigir_lotacao(
  tx: Executor,
  lotacao: Pick<LinhaLotacao, "id" | "documento" | "observacao">,
  usuario: UsuarioAtual,
  d: { documento: string | null; observacao: string | null },
): Promise<void> {
  usuario.exigir("processo.editar");
  const antes = { documento: lotacao.documento, observacao: lotacao.observacao };
  const depois = {
    documento: (d.documento ?? "").trim() || null,
    observacao: (d.observacao ?? "").trim() || null,
  };
  await tx.update(servidor_lotacao).set(depois).where(eq(servidor_lotacao.id, lotacao.id));
  Object.assign(lotacao, depois);
  await auditoria.registrar_diferencas(tx, {
    entidade: "servidor_lotacao",
    entidade_id: lotacao.id,
    antes,
    depois,
    usuario,
  });
}

function _dias(inicio: string, fim: string): number {
  const dia = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((dia(fim) - dia(inicio)) / 86_400_000);
}

/** Lacuna ou sobreposição na linha do tempo. */
export async function inconsistencias(tx: Executor, servidor_id: number): Promise<string[]> {
  const problemas: string[] = [];
  const linha = await historico(tx, servidor_id);
  for (let i = 0; i + 1 < linha.length; i++) {
    const anterior = linha[i]!;
    const seguinte = linha[i + 1]!;
    if (anterior.vigencia_fim === null) {
      problemas.push(
        `o período iniciado em ${anterior.vigencia_inicio} não foi ` + "encerrado, mas já existe um posterior",
      );
    } else if (seguinte.vigencia_inicio <= anterior.vigencia_fim) {
      problemas.push(`sobreposição entre ${anterior.vigencia_inicio} e ${seguinte.vigencia_inicio}`);
    } else if (_dias(anterior.vigencia_fim, seguinte.vigencia_inicio) > 1) {
      const dias = _dias(anterior.vigencia_fim, seguinte.vigencia_inicio) - 1;
      problemas.push(`lacuna de ${dias} dia(s) antes de ${seguinte.vigencia_inicio}`);
    }
  }
  return problemas;
}
