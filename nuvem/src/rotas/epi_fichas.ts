/**
 * /epis/fichas e /epis/entregas — a ficha de EPI e o balcão que a alimenta.
 * Porte de `app/rotas/epi_fichas.py`.
 *
 * O que estas telas existem para tornar visível:
 *
 * 1. **O CA que vale é o do lote** — lote com CA vencido fica desabilitado
 *    com o motivo escrito ao lado.
 * 2. **Ficha sem comprovante é pendência**, contada no topo e etiquetada.
 * 3. **Estorno não apaga**: a linha errada continua, marcada.
 * 4. **Devolução não é estorno**, e as duas ficam lado a lado dizendo o que fazem.
 *
 * A ordem de declaração importa como no FastAPI: `/epis/fichas/minha` e
 * `/epis/fichas/registros/...` vêm antes de `/epis/fichas/:servidor_id` (que,
 * aqui, também só casa dígitos).
 *
 * A recusa que já escreveu (o `s.rollback()` do Python) é um SAVEPOINT: o
 * serviço roda em `tx.transaction(...)`, e a recusa desfaz só o que ele gravou
 * — a tela de volta ainda lê o banco na transação da requisição.
 */
import { Hono } from "hono";
import { asc, eq, inArray } from "drizzle-orm";
import type { Ambiente, Ctx } from "../nucleo/contexto.js";
import { PermissaoNegada } from "../nucleo/erros.js";
import type { Executor } from "../db/cliente.js";
import {
  anexo as tabela_anexo,
  epi_entrada_estoque,
  epi_ficha_registro,
  epi_item,
  epi_motivo_recusa,
  servidor as tabela_servidor,
  unidade_uorg,
} from "../db/esquema/index.js";
import { usuarioLogado, formulario } from "../dependencias.js";
import { comMensagem, fragmento, numeroDaPagina, pagina, recortar, redirecionar } from "../web.js";
import { EpiItem as DominioItem } from "../dominio/epi.js";
import * as anexo_acesso from "../servicos/anexo_acesso.js";
import * as anexos from "../servicos/anexos.js";
import * as auditoria from "../servicos/auditoria.js";
import * as comprovante_epi from "../servicos/comprovante_epi.js";
import * as datas_br from "../servicos/datas_br.js";
import * as epi_estoque from "../servicos/epi_estoque.js";
import * as servico from "../servicos/epi_ficha.js";
import * as servico_servidores from "../servicos/servidores.js";
import * as textos from "../servicos/textos.js";
import { TextoProibido } from "../servicos/textos.js";
import type { UsuarioAtual } from "../servicos/rbac.js";

export const rotas = new Hono<Ambiente>();

const FICHAS = "/epis/fichas";
const MINHA = "/epis/fichas/minha";
const ENTREGA_NOVA = "/epis/entregas/nova";
const REGISTROS = "/epis/fichas/registros";

/** Codificado: a mensagem cita nome de item, lote e motivo digitado. */
function volta(c: Ctx, destino: string, mensagem: string): Response {
  return redirecionar(c, comMensagem(destino, mensagem, "mensagem"));
}
function erro(c: Ctx, destino: string, mensagem: string): Response {
  return redirecionar(c, comMensagem(destino, mensagem, "erro"));
}

/** `str.isdigit()` do Python sobre o texto do formulário/URL. */
function inteiro(bruto: string | null | undefined): number | null {
  const t = bruto ?? "";
  return /^\d+$/.test(t) ? Number(t) : null;
}

/** O item com as `@property` que os templates leem. */
export function item_para_tela<T extends typeof epi_item.$inferSelect>(item: T) {
  return {
    ...item,
    regra_de_quantidade: DominioItem.regra_de_quantidade(item),
    lista_de_tamanhos: DominioItem.lista_de_tamanhos(item),
    lista_de_normas: DominioItem.lista_de_normas(item),
  };
}

async function item_por_id(tx: Executor, id: number | null) {
  if (id === null) return null;
  const [item] = await tx.select().from(epi_item).where(eq(epi_item.id, id));
  return item ?? null;
}

async function servidor_por_id(tx: Executor, id: number | null) {
  if (id === null) return null;
  const [sv] = await tx.select().from(tabela_servidor).where(eq(tabela_servidor.id, id));
  return sv ?? null;
}

async function itens_ativos(tx: Executor) {
  return tx.select().from(epi_item).where(eq(epi_item.ativo, true)).orderBy(asc(epi_item.nome));
}

/** `e.motivos` do `EntregaBloqueada`, ou a mensagem do `TextoProibido`. */
function motivos_de(falha: unknown): string {
  const m = (falha as { motivos?: string[] }).motivos;
  return m && m.length ? m.join(" · ") : String((falha as Error).message);
}

function recusavel(falha: unknown): boolean {
  return falha instanceof servico.EntregaBloqueada || falha instanceof TextoProibido;
}

/** `Content-Disposition` com o nome em RFC 5987 (o `FileResponse` do Starlette). */
function disposicao(nome: string): string {
  const ascii = /^[\x20-\x7e]*$/.test(nome) && !nome.includes('"');
  return ascii ? `attachment; filename="${nome}"` : `attachment; filename*=utf-8''${encodeURIComponent(nome)}`;
}

// =====================================================================
// A lista: quem tem ficha, e onde falta prova
// =====================================================================
rotas.get(FICHAS, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.ficha");
  const tx = c.get("tx");
  const q = c.req.query("q") ?? "";
  let linhas = await servico.servidores_com_ficha(tx);
  if (q) {
    const alvo = textos.chave_busca(q);
    linhas = linhas.filter(([sv]) => textos.chave_busca(sv.nome).includes(alvo) || sv.siape.includes(alvo));
  }
  // o aviso do alto conta as pendências do FILTRO inteiro, antes do recorte
  const pendentes = linhas.reduce((s, [, , faltando]) => s + faltando, 0);
  const recorte = recortar(linhas, numeroDaPagina(c));
  // a lista lê `sv.unidade.nome_extenso`: carrega só as da página
  const ids = [...new Set(recorte.itens.map(([sv]) => sv.unidade_uorg_id).filter((x): x is number => x !== null))];
  const unidades = ids.length ? await tx.select().from(unidade_uorg).where(inArray(unidade_uorg.id, ids)) : [];
  const por_id = new Map(unidades.map((u) => [u.id, u]));
  const itens = recorte.itens.map(([sv, total, faltando]) => [
    { ...sv, unidade: sv.unidade_uorg_id !== null ? (por_id.get(sv.unidade_uorg_id) ?? null) : null },
    total,
    faltando,
  ]);
  return pagina(c, "paginas/epis_fichas.html", usuario, {
    linhas: itens,
    recorte,
    q,
    pendentes,
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});

// =====================================================================
// A porta do titular
// =====================================================================
/**
 * `/epis/fichas/minha` → a ficha de quem está logado. Exige exatamente
 * `epi.ver`; conta sem cadastro de servidor recebe a tela que diz por quê.
 */
rotas.get(MINHA, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.ver");
  if (usuario.servidor_id === null) return pagina(c, "paginas/epis_ficha_minha.html", usuario);
  return redirecionar(c, `${FICHAS}/${usuario.servidor_id}`);
});

// =====================================================================
// O balcão: registrar entrega
// =====================================================================
interface OpcoesTela {
  servidor_id?: number | null;
  item_id?: number | null;
  mensagem?: string | null;
  erro?: string | null;
  digitado?: Record<string, string> | null;
  digitado_recusa?: Record<string, string> | null;
  foco_na_recusa?: boolean;
}

/**
 * O balcão, em branco ou com o que foi digitado de volta. Dois dicionários
 * porque a tela tem dois formulários e ambos têm um campo `item_id`.
 */
async function tela_de_entrega(c: Ctx, usuario: UsuarioAtual, o: OpcoesTela): Promise<Response> {
  const tx = c.get("tx");
  const item = await item_por_id(tx, o.item_id ?? null);
  return pagina(c, "paginas/epis_entrega.html", usuario, {
    // a lista inteira — o `<select>` completo é o que sai sem JavaScript
    servidores: await servico_servidores.buscar(tx, "", usuario),
    servidor_escolhido: await servidor_por_id(tx, o.servidor_id ?? null),
    itens: await itens_ativos(tx),
    item: item ? item_para_tela(item) : null,
    lotes: item ? await epi_estoque.lotes_de(tx, item) : [],
    motivos: await tx
      .select()
      .from(epi_motivo_recusa)
      .where(eq(epi_motivo_recusa.ativo, true))
      .orderBy(asc(epi_motivo_recusa.rotulo)),
    hoje: datas_br.hoje(),
    digitado: o.digitado ?? {},
    digitado_recusa: o.digitado_recusa ?? {},
    foco_na_recusa: o.foco_na_recusa ?? false,
    mensagem: o.mensagem ?? null,
    erro: o.erro ?? null,
  });
}

rotas.get(ENTREGA_NOVA, async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.entregar");
  return tela_de_entrega(c, usuario, {
    servidor_id: inteiro(c.req.query("servidor_id")),
    item_id: inteiro(c.req.query("item_id")),
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});

/** Fragmento HTMX: a busca de servidor do balcão (o mesmo de `/epis/requisicoes/nova`). */
rotas.get("/epis/entregas/servidores", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.entregar");
  const q = c.req.query("q") ?? "";
  return fragmento(c, "partes/epi_requisicao_servidores.html", {
    // `identificar()` lê a RN-19 do contexto do template
    usuario,
    servidores: await servico_servidores.buscar(c.get("tx"), q, usuario),
    rotulo: "Quem recebe",
    q,
  });
});

/** Fragmento HTMX: escolhido o item, aparecem tamanho, lote e quantidade. */
rotas.get("/epis/entregas/opcoes", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.entregar");
  const tx = c.get("tx");
  const item = await item_por_id(tx, inteiro(c.req.query("item_id")));
  return fragmento(c, "partes/epi_opcoes_item.html", {
    item: item ? item_para_tela(item) : null,
    lotes: item ? await epi_estoque.lotes_de(tx, item) : [],
    hoje: datas_br.hoje(),
  });
});

rotas.post("/epis/entregas", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.entregar");
  const tx = c.get("tx");
  const f = await formulario(c);
  // tudo o que foi digitado, guardado antes da primeira recusa: é o balcão,
  // com alguém esperando de pé do outro lado
  const digitado: Record<string, string> = {};
  for (const campo of [
    "servidor_id",
    "item_id",
    "quantidade",
    "entrada_id",
    "tamanho",
    "data_evento",
    "observacao",
    "justificativa_excecao",
  ]) {
    digitado[campo] = f.texto(campo);
  }
  const servidor = await servidor_por_id(tx, inteiro(digitado.servidor_id));
  const item = await item_por_id(tx, inteiro(digitado.item_id));

  const recusar = (mensagem: string) =>
    tela_de_entrega(c, usuario, {
      servidor_id: servidor ? servidor.id : null,
      item_id: item ? item.id : null,
      erro: mensagem,
      digitado,
    });

  if (!servidor) return recusar("Escolha o servidor que vai receber o EPI.");
  if (!item) return recusar("Escolha o item do catálogo.");
  const quantidade = inteiro(digitado.quantidade!.trim());
  if (quantidade === null || quantidade <= 0) return recusar("Quantidade inválida: informe um número maior que zero.");
  const id_entrada = inteiro(digitado.entrada_id!.trim());
  const entrada =
    id_entrada !== null
      ? ((await tx.select().from(epi_entrada_estoque).where(eq(epi_entrada_estoque.id, id_entrada)))[0] ?? null)
      : null;
  let quando: string | null = null;
  const bruto = digitado.data_evento!.trim().slice(0, 10);
  if (bruto) {
    quando = /^\d{4}-\d{2}-\d{2}$/.test(bruto) ? datas_br.comoData(bruto) : null;
    if (!quando) return recusar("Data da entrega inválida.");
    // data futura seria prova de um fato que ainda não aconteceu
    if (quando > datas_br.hoje()) return recusar("A entrega não pode ter data futura.");
  }

  let registro;
  try {
    registro = await tx.transaction(async (sp) =>
      servico.registrar_entrega(sp, usuario, {
        servidor,
        item,
        quantidade,
        entrada,
        tamanho: digitado.tamanho,
        data_evento: quando,
        observacao: digitado.observacao,
        justificativa_excecao: digitado.justificativa_excecao,
      }),
    );
  } catch (falha) {
    if (!recusavel(falha)) throw falha;
    return recusar(motivos_de(falha));
  }
  return volta(
    c,
    `${FICHAS}/${servidor.id}`,
    `Entrega registrada (registro ${registro.id}). ` +
      "Imprima o comprovante, colha a assinatura e anexe o digitalizado.",
  );
});

/** RN-27 e as decisões 3 e 7: o "não" fundamentado, uniforme e contável. */
rotas.post("/epis/entregas/recusa", async (c) => {
  const usuario = await usuarioLogado(c);
  usuario.exigir("epi.entregar");
  const tx = c.get("tx");
  const f = await formulario(c);
  const digitado_recusa: Record<string, string> = {};
  for (const campo of ["motivo_id", "a_quem", "item_id", "unidade", "complemento"]) {
    digitado_recusa[campo] = f.texto(campo);
  }
  const recusar = (mensagem: string) =>
    tela_de_entrega(c, usuario, { erro: mensagem, digitado_recusa, foco_na_recusa: true });

  const id_motivo = inteiro(digitado_recusa.motivo_id);
  const [motivo] =
    id_motivo !== null ? await tx.select().from(epi_motivo_recusa).where(eq(epi_motivo_recusa.id, id_motivo)) : [];
  if (!motivo) return recusar("Escolha o motivo da recusa no catálogo.");
  const item = await item_por_id(tx, inteiro(digitado_recusa.item_id!.trim()));
  try {
    await tx.transaction(async (sp) =>
      servico.recusar(sp, usuario, {
        motivo,
        a_quem: digitado_recusa.a_quem!,
        item,
        unidade: digitado_recusa.unidade,
        complemento: digitado_recusa.complemento,
      }),
    );
  } catch (falha) {
    if (!recusavel(falha)) throw falha;
    return recusar(motivos_de(falha));
  }
  return volta(
    c,
    ENTREGA_NOVA,
    `Recusa registrada com o motivo ${motivo.codigo}. ` +
      "O texto que saiu para o requerente ficou congelado na trilha.",
  );
});

// =====================================================================
// Uma linha da ficha: comprovante, anexo e estorno
// =====================================================================
async function registro_por_id(tx: Executor, id: number | null) {
  if (id === null) return null;
  const [registro] = await tx.select().from(epi_ficha_registro).where(eq(epi_ficha_registro.id, id));
  return registro ?? null;
}

async function registro_e_permissao(tx: Executor, usuario: UsuarioAtual, bruto: string) {
  const registro = await registro_por_id(tx, inteiro(bruto));
  if (!registro) return null;
  usuario.exigir("epi.entregar");
  return registro;
}

/** A linha aponta para a ficha de quem recebeu (a âncora da pendência). */
rotas.get(`${REGISTROS}/:registro_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  const registro = await registro_por_id(c.get("tx"), inteiro(c.req.param("registro_id")));
  if (!registro) return redirecionar(c, FICHAS);
  servico.exigir_leitura_da_ficha(usuario, registro.servidor_id);
  return redirecionar(c, `${FICHAS}/${registro.servidor_id}`);
});

/** O .docx impresso a partir dos snapshots — nunca do catálogo de hoje. */
rotas.get(`${REGISTROS}/:registro_id{[0-9]+}/comprovante`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const registro = await registro_e_permissao(tx, usuario, c.req.param("registro_id"));
  if (!registro) return redirecionar(c, FICHAS);
  const impressao = await servico.imprimir(tx, usuario, registro);
  return new Response(impressao.bytes, {
    status: 200,
    headers: {
      "content-type": comprovante_epi.TIPO_DOCX,
      "content-disposition": disposicao(impressao.nome),
    },
  });
});

rotas.post(`${REGISTROS}/:registro_id{[0-9]+}/comprovante`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const registro = await registro_e_permissao(tx, usuario, c.req.param("registro_id"));
  if (!registro) return redirecionar(c, FICHAS);
  const destino = `${FICHAS}/${registro.servidor_id}`;
  const f = await formulario(c);
  if (!f.tem("arquivo")) {
    // o `File(...)` obrigatório do FastAPI respondia 422
    return c.json({ detail: [{ loc: ["body", "arquivo"], msg: "Field required", type: "missing" }] }, 422);
  }
  const arquivo = f.dados.get("arquivo");
  const eh_arquivo = arquivo instanceof File;
  let anexo;
  try {
    anexo = await tx.transaction(async (sp) =>
      servico.anexar_comprovante(sp, usuario, registro, {
        conteudo: eh_arquivo ? new Uint8Array(await (arquivo as File).arrayBuffer()) : new Uint8Array(),
        nome_original: (eh_arquivo && (arquivo as File).name) || "comprovante.pdf",
        mime_type: (eh_arquivo && (arquivo as File).type) || "application/pdf",
      }),
    );
  } catch (falha) {
    if (falha instanceof servico.EntregaBloqueada) return erro(c, destino, falha.motivos.join(" · "));
    if (falha instanceof anexos.AnexoGrandeDemais) return erro(c, destino, falha.message);
    throw falha;
  }
  return volta(c, destino, `Comprovante anexado · SHA-256 ${anexo.sha256.slice(0, 12)}. A entrega está completa.`);
});

rotas.get(`${REGISTROS}/:registro_id{[0-9]+}/anexo`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const registro = await registro_por_id(tx, inteiro(c.req.param("registro_id")));
  if (!registro || registro.comprovante_anexo_id === null) return redirecionar(c, FICHAS);
  const [anexo] = await tx.select().from(tabela_anexo).where(eq(tabela_anexo.id, registro.comprovante_anexo_id));
  // a MESMA porta de `/anexos/{id}`: confere a leitura da ficha e registra o acesso
  await anexo_acesso.liberar(tx, usuario, anexo);
  const conteudo = await anexos.ler_conteudo(anexo!);
  return new Response(conteudo, {
    status: 200,
    headers: { "content-type": anexo!.mime_type, "content-disposition": disposicao(anexo!.nome_original) },
  });
});

/** O EPI voltou. **Não é estorno.** */
rotas.post(`${REGISTROS}/:registro_id{[0-9]+}/devolucao`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const registro = await registro_e_permissao(tx, usuario, c.req.param("registro_id"));
  if (!registro) return redirecionar(c, FICHAS);
  const destino = `${FICHAS}/${registro.servidor_id}`;
  const f = await formulario(c);
  const quantas = inteiro(f.texto("quantidade").trim());
  if (quantas === null || quantas <= 0) return erro(c, destino, "Quantidade devolvida inválida.");
  let quando: string | null = null;
  const bruto = f.texto("data_evento").trim().slice(0, 10);
  if (bruto) {
    quando = /^\d{4}-\d{2}-\d{2}$/.test(bruto) ? datas_br.comoData(bruto) : null;
    if (!quando) return erro(c, destino, "Data da devolução inválida.");
  }
  let devolucao;
  try {
    devolucao = await tx.transaction(async (sp) =>
      servico.registrar_devolucao(sp, usuario, registro, {
        quantidade: quantas,
        motivo: f.texto("motivo"),
        data_evento: quando,
      }),
    );
  } catch (falha) {
    if (!recusavel(falha)) throw falha;
    return erro(c, destino, motivos_de(falha));
  }
  const saldo = registro.entrada_id ? "e o saldo voltou ao lote" : "sem lote a repor";
  return volta(
    c,
    destino,
    `Devolução registrada (registro ${devolucao.id}) ${saldo}. ` +
      "A entrega continua na ficha: devolver não desfaz o que aconteceu.",
  );
});

rotas.post(`${REGISTROS}/:registro_id{[0-9]+}/estorno`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const registro = await registro_e_permissao(tx, usuario, c.req.param("registro_id"));
  if (!registro) return redirecionar(c, FICHAS);
  const destino = `${FICHAS}/${registro.servidor_id}`;
  const f = await formulario(c);
  if (!f.tem("motivo")) {
    return c.json({ detail: [{ loc: ["body", "motivo"], msg: "Field required", type: "missing" }] }, 422);
  }
  let estorno;
  try {
    estorno = await tx.transaction(async (sp) => servico.estornar(sp, usuario, registro, f.texto("motivo")));
  } catch (falha) {
    if (!recusavel(falha)) throw falha;
    return erro(c, destino, motivos_de(falha));
  }
  return volta(
    c,
    destino,
    `Registro ${registro.id} estornado pelo registro ${estorno.id}. ` + "A linha original continua na ficha, marcada.",
  );
});

// =====================================================================
// A ficha do servidor — por último
// =====================================================================
rotas.get(`${FICHAS}/:servidor_id{[0-9]+}`, async (c) => {
  const usuario = await usuarioLogado(c);
  const tx = c.get("tx");
  const servidor_id = Number(c.req.param("servidor_id"));
  const servidor = await tx.query.servidor.findFirst({
    where: eq(tabela_servidor.id, servidor_id),
    with: { cargo: true, unidade: true },
  });
  if (!servidor) {
    // 403 e não 404: a mesma resposta para id que existe e que não existe
    throw new PermissaoNegada("epi.ficha", "Não há ficha de EPI para consultar neste endereço.");
  }
  servico.exigir_leitura_da_ficha(usuario, servidor_id);
  await auditoria.registrar_leitura_nominal(tx, usuario, "epi_ficha", {
    servidor_id: servidor.id,
    finalidade: "consulta da ficha de EPI do servidor",
  });

  const linhas = await servico.linha_do_tempo(tx, servidor_id);
  const hoje = datas_br.hoje();
  return pagina(c, "paginas/epis_ficha.html", usuario, {
    servidor,
    linhas,
    hoje,
    pendentes: linhas.filter((l) => l.sem_comprovante),
    vencidos: linhas.filter((l) => l.ca_vencido_em(hoje)),
    trocas: linhas.filter((l) => l.troca_vencida_em(hoje)),
    divergencias: await servico.conferir(tx, servidor_id),
    pode_entregar: usuario.pode("epi.entregar"),
    mensagem: c.req.query("mensagem") ?? null,
    erro: c.req.query("erro") ?? null,
  });
});
