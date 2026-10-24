/**
 * NUVEM (24/10/2026): /treinamentos/locais — o cadastro dos locais de
 * treinamento (`servicos/local_treinamento.ts`).
 *
 * Mesmo padrão do catálogo de treinamentos: a lista é leitura da equipe
 * (`treinamento.ver`, fora das funções do titular); cadastrar, editar e
 * inativar pedem `treinamento.gerenciar`. A recusa devolve a tela com o popup
 * de onde veio reaberto e o que foi digitado.
 */
import { Hono } from "hono";
import { asc } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { formulario, usuarioLogado, type Formulario } from "../dependencias.js";
import { campus as tabela_campus } from "../db/esquema/index.js";
import * as local_treinamento from "../servicos/local_treinamento.js";
import { LocalRecusado, PERMISSAO, TELA } from "../servicos/local_treinamento.js";
import type { UsuarioAtual } from "../servicos/rbac.js";
import { pagina, redirecionar } from "../web.js";
import { erro as _erro, id_opcional, recados, volta as _volta } from "./treinamento_vistas.js";

export const rotas = new Hono<Ambiente>();

const CAMPOS = ["nome", "campus_id", "endereco", "capacidade", "observacoes"] as const;

async function _tela(
  c: Ctx,
  usuario: UsuarioAtual,
  d: {
    mensagem?: string | null;
    erro?: string | null;
    digitado?: Record<string, string>;
    editando_id?: number | null;
  } = {},
): Promise<Response> {
  const tx = c.get("tx");
  const [itens, campi] = await Promise.all([
    local_treinamento.listar(tx),
    tx.select().from(tabela_campus).orderBy(asc(tabela_campus.nome)),
  ]);
  return pagina(c, "paginas/treinamentos_locais.html", usuario, {
    itens,
    campi,
    editavel: usuario.pode(PERMISSAO),
    mensagem: d.mensagem ?? null,
    erro: d.erro ?? null,
    digitado: d.digitado ?? {},
    editando_id: d.editando_id ?? null,
  });
}

/** O formulário em dados do serviço. A capacidade estranha segue para ele recusar. */
function _dados(f: Formulario): local_treinamento.DadosLocal {
  const capacidade = f.texto("capacidade").trim();
  return {
    nome: f.texto("nome"),
    campus_id: id_opcional(f.texto("campus_id")),
    endereco: f.texto("endereco"),
    capacidade: capacidade ? (/^\d+$/.test(capacidade) ? Number(capacidade) : Number.NaN) : null,
    observacoes: f.texto("observacoes"),
  };
}

function _digitado(f: Formulario): Record<string, string> {
  return Object.fromEntries(CAMPOS.map((k) => [k, f.texto(k)]));
}

rotas.get(TELA, async (c) => {
  const usuario = await usuarioLogado(c);
  // tela da equipe, como o catálogo de treinamentos: o titular (D16) não a abre
  usuario.exigir_na_equipe("treinamento.ver");
  return _tela(c, usuario, recados(c));
});

rotas.post(TELA, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir(PERMISSAO);
  const f = await formulario(c);
  try {
    const novo = await c.get("tx").transaction((sp) => local_treinamento.criar(sp as never, usuario, _dados(f)));
    return _volta(c, TELA, `Local “${novo.nome}” cadastrado: já aparece no campo “Local” da turma.`);
  } catch (e) {
    if (e instanceof LocalRecusado) return _tela(c, usuario, { erro: e.message, digitado: _digitado(f) });
    throw e;
  }
});

rotas.post(`${TELA}/:local_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir(PERMISSAO);
  const f = await formulario(c);
  const local_id = Number(c.req.param("local_id"));
  try {
    const r = await c
      .get("tx")
      .transaction((sp) => local_treinamento.editar(sp as never, usuario, local_id, _dados(f)));
    const turmas =
      r.turmas_renomeadas === 0
        ? ""
        : ` O nome novo foi para ${r.turmas_renomeadas} turma(s) ainda não encerrada(s); as concluídas ficam com o nome do dia.`;
    return _volta(c, TELA, `Local “${r.local.nome}”: alteração gravada.${turmas}`);
  } catch (e) {
    if (e instanceof LocalRecusado) {
      if (e.message === "Local não encontrado.") return redirecionar(c, TELA);
      return _tela(c, usuario, { erro: e.message, digitado: _digitado(f), editando_id: local_id });
    }
    throw e;
  }
});

for (const [acao, ativo] of [
  ["inativar", false],
  ["reativar", true],
] as const) {
  rotas.post(`${TELA}/:local_id{[0-9]+}/${acao}`, async (c) => {
    const usuario = await usuarioLogado(c);
    usuario.exigir(PERMISSAO);
    try {
      const l = await local_treinamento.mudar_ativo(c.get("tx"), usuario, Number(c.req.param("local_id")), ativo);
      return _volta(
        c,
        TELA,
        ativo
          ? `Local “${l.nome}” reativado: volta a aparecer na turma.`
          : `Local “${l.nome}” inativado: não aparece em turma nova. As turmas que já o têm continuam com ele.`,
      );
    } catch (e) {
      if (e instanceof LocalRecusado) return _erro(c, TELA, e.message);
      throw e;
    }
  });
}
