/**
 * Cargo e lotação pedidos NO MOMENTO DO USO (26/10/2026): o cadastro (Cadastre-se)
 * não pergunta nada disso — quem só quer se inscrever num curso não precisa —,
 * mas o pedido de EPI e a comunicação de acidente precisam. O catálogo da casa
 * não tem todos os cargos nem todas as lotações; então a pessoa escolhe da lista
 * OU digita o que não achou, e o catálogo cresce com o que se digita.
 *
 * O que nasce de digitação fica `a_conferir` (a equipe confere nome e
 * duplicata em /catalogos) e deixa trilha. A mesma grafia, sem contar caixa nem
 * acento, nunca cria uma segunda linha: devolve a que já existe.
 */
import { asc, eq } from "drizzle-orm";
import type { Executor } from "../db/cliente.js";
import { campus, cargo as tabela_cargo, unidade_uorg } from "../db/esquema/index.js";
import { RegraViolada } from "../nucleo/erros.js";
import * as auditoria from "./auditoria.js";
import type { UsuarioAtual } from "./rbac.js";
import * as textos from "./textos.js";

export class DadosFuncionaisInvalidos extends RegraViolada {}

/** O que o formulário traz: a escolha da lista e/ou o que foi digitado. */
export interface EntradaFuncional {
  cargo_id: string;
  cargo_novo: string;
  unidade_uorg_id: string;
  lotacao_nova: string;
  lotacao_campus_id: string;
}

type Lede = { texto(nome: string, padrao?: string): string };

/** Lê os cinco campos do bloco `partes/cargo_lotacao.html` (com o prefixo do bloco). */
export function ler(f: Lede, prefixo = ""): EntradaFuncional {
  return {
    cargo_id: f.texto(`${prefixo}cargo_id`).trim(),
    cargo_novo: f.texto(`${prefixo}cargo_novo`).trim(),
    unidade_uorg_id: f.texto(`${prefixo}unidade_uorg_id`).trim(),
    lotacao_nova: f.texto(`${prefixo}lotacao_nova`).trim(),
    lotacao_campus_id: f.texto(`${prefixo}lotacao_campus_id`).trim(),
  };
}

const _limpo = (t: string) => t.replace(/\s+/g, " ").trim();
const _inteiro = (v: string) => (/^\d{1,9}$/.test(v) ? Number(v) : null);

/** Cargo (do catálogo, ou criado agora) e lotação; `null` quando nada foi informado. */
export async function resolver(
  tx: Executor,
  e: EntradaFuncional,
  usuario: UsuarioAtual | null,
): Promise<{ cargo_id: number | null; unidade_uorg_id: number | null }> {
  return { cargo_id: await _cargo(tx, e, usuario), unidade_uorg_id: await _unidade(tx, e, usuario) };
}

async function _cargo(tx: Executor, e: EntradaFuncional, usuario: UsuarioAtual | null): Promise<number | null> {
  const digitado = _limpo(e.cargo_novo);
  if (!digitado) {
    const id = _inteiro(e.cargo_id);
    if (id === null) return null;
    const [existe] = await tx.select({ id: tabela_cargo.id }).from(tabela_cargo).where(eq(tabela_cargo.id, id));
    if (!existe) throw new DadosFuncionaisInvalidos("o cargo escolhido não existe mais; escolha de novo");
    return id;
  }
  if ([...digitado].length > 120) throw new DadosFuncionaisInvalidos("o nome do cargo passa de 120 caracteres");
  const chave = textos.chave_busca(digitado);
  const todos = await tx.select().from(tabela_cargo);
  const igual = todos.find((x) => textos.chave_busca(x.nome) === chave);
  if (igual) return igual.id;
  const [novo] = await tx.insert(tabela_cargo).values({ nome: digitado, a_conferir: true }).returning();
  await auditoria.registrar(tx, {
    entidade: "cargo",
    entidade_id: novo!.id,
    tipo_evento: "CARGO_CRIADO",
    descricao: `${digitado} (digitado por quem preencheu o formulário; a conferir)`,
    usuario,
  });
  return novo!.id;
}

async function _unidade(tx: Executor, e: EntradaFuncional, usuario: UsuarioAtual | null): Promise<number | null> {
  const digitada = _limpo(e.lotacao_nova);
  if (!digitada) {
    const id = _inteiro(e.unidade_uorg_id);
    if (id === null) return null;
    const [existe] = await tx.select({ id: unidade_uorg.id }).from(unidade_uorg).where(eq(unidade_uorg.id, id));
    if (!existe) throw new DadosFuncionaisInvalidos("a lotação escolhida não existe mais; escolha de novo");
    return id;
  }
  if ([...digitada].length > 160) throw new DadosFuncionaisInvalidos("o nome da lotação passa de 160 caracteres");
  const chave = textos.chave_busca(digitada);
  const todas = await tx.select().from(unidade_uorg);
  const igual = todas.find(
    (u) =>
      textos.chave_busca(u.nome_extenso) === chave ||
      textos.chave_busca(u.nome_oficial) === chave ||
      (u.sigla !== null && textos.chave_busca(u.sigla) === chave),
  );
  if (igual) return igual.id;
  const campus_id = _inteiro(e.lotacao_campus_id);
  if (campus_id === null) throw new DadosFuncionaisInvalidos("escolha o campus da lotação que você digitou");
  const [c] = await tx.select({ id: campus.id }).from(campus).where(eq(campus.id, campus_id));
  if (!c) throw new DadosFuncionaisInvalidos("o campus escolhido não existe");
  const [nova] = await tx
    .insert(unidade_uorg)
    .values({
      nome_oficial: digitada.toLocaleUpperCase("pt-BR"),
      nome_extenso: digitada,
      tipo: "OUTRO",
      campus_id: c.id,
      a_conferir: true,
    })
    .returning();
  await auditoria.registrar(tx, {
    entidade: "unidade_uorg",
    entidade_id: nova!.id,
    tipo_evento: "UNIDADE_CRIADA",
    descricao: `${digitada} (digitada por quem preencheu o formulário; a conferir)`,
    usuario,
  });
  return nova!.id;
}

/** Faltou cargo ou lotação no cadastro do servidor? */
export function faltam(servidor: { cargo_id: number | null; unidade_uorg_id: number | null }): { cargo: boolean; lotacao: boolean } {
  return { cargo: servidor.cargo_id === null, lotacao: servidor.unidade_uorg_id === null };
}

/** O que a lista do bloco mostra: cargos, lotações (com o campus) e campi. */
export async function opcoes(tx: Executor) {
  const [cargos, lotacoes, campi] = await Promise.all([
    tx.select().from(tabela_cargo).orderBy(asc(tabela_cargo.nome)),
    tx.query.unidade_uorg.findMany({ with: { campus: true }, orderBy: [asc(unidade_uorg.nome_extenso)] }),
    tx.select().from(campus).orderBy(asc(campus.nome)),
  ]);
  return {
    cargos,
    lotacoes: lotacoes.map((u) => ({
      id: u.id,
      rotulo: [u.sigla ? `${u.sigla} · ${u.nome_extenso}` : u.nome_extenso, u.campus?.nome].filter(Boolean).join(" — "),
    })),
    campi,
  };
}
