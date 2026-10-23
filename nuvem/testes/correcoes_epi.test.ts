/**
 * As correções do lote EPI da revisão de 21/10/2026 (D14–D23, D82, D83 e as
 * melhorias de tela que mudaram regra). Cada `describe` nomeia o item.
 *
 * Banco novo por teste (`bancoLimpo()`), como os demais testes de tela do
 * módulo: os cenários se cruzam (pedido de uma pessoa, conta de outra).
 */
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import * as epi_estoque from "../src/servicos/epi_estoque.js";
import * as epi_ficha from "../src/servicos/epi_ficha.js";
import * as servico from "../src/servicos/epi_requisicao.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste, type Cliente, type Resposta } from "./ajuda";
import { cenario, entregar, HOJE, recado, registros, type Cenario } from "./ajuda_epi_ficha";

const FILA = "/epis/requisicoes";
const NOVA = "/epis/requisicoes/nova";

await bancoLimpo();

interface Amb extends AmbienteDeTeste {
  contas: Record<string, [string, string]>;
}
async function novo(): Promise<Amb> {
  const amb = await bancoLimpo();
  return { ...amb, contas: await contas(amb.db) };
}
const como = (amb: Amb, login: string): Promise<Cliente> => entrar(amb.novoCliente(), login);
const ligar = (amb: Amb, login: string, servidor_id: number | null) =>
  amb.db.update(e.usuario).set({ servidor_id }).where(eq(e.usuario.login, login));

/** O POST da tela nova: cabeçalho e, opcionalmente, o primeiro item. */
function pedir(cliente: Cliente, servidor_id: number | string, cen: Cenario | null, acao = "", extra: Record<string, string> = {}) {
  return cliente.post(
    FILA,
    {
      servidor_id: String(servidor_id),
      chefia_servidor_id: "",
      finalidade: "ROTINA",
      descricao_atividade: "Manipulação de reagentes",
      riscos_declarados: "Respingo de ácido",
      urgencia: "NORMAL",
      justificativa_urgencia: "",
      item_id: cen ? String(cen.item) : "",
      quantidade: cen ? "1" : "",
      tamanho: cen ? "M" : "",
      justificativa: "",
      motivo: cen ? "DESGASTE" : "",
      termo_aceito: "1",
      acao,
      ...extra,
    },
    { seguir: false },
  );
}

const pedidos = (amb: Amb) => amb.db.select().from(e.epi_requisicao).orderBy(asc(e.epi_requisicao.id));
const linhas_de = (amb: Amb, id: number) =>
  amb.db.select().from(e.epi_requisicao_item).where(eq(e.epi_requisicao_item.requisicao_id, id)).orderBy(asc(e.epi_requisicao_item.id));

/** O pedido da Joana, aberto e enviado pelo coordenador, numa tela só. */
async function enviado(amb: Amb, cen: Cenario): Promise<number> {
  const r = await pedir(await como(amb, "coordenador_csso"), cen.servidor, cen, "enviar");
  expect(r.status, recado(r)).toBe(303);
  return (await pedidos(amb)).at(-1)!.id;
}

async function outro_servidor(amb: Amb, siape = "1112223", nome = "Bruno Outro"): Promise<number> {
  const [u] = await amb.db.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
  const [sv] = await amb.db.insert(e.servidor).values({ siape, nome, unidade_uorg_id: u!.id }).returning();
  return sv!.id;
}

// =====================================================================
describe("D14 — cancelar é do requerente, de quem abriu ou de quem analisa", () => {
  it("a secretaria não vê o botão nem cancela o pedido de outra pessoa", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const id = await enviado(amb, cen);
    const secretaria = await como(amb, "secretaria_csso");
    const ficha = await secretaria.get(`${FILA}/${id}`);
    expect(ficha.status).toBe(200);
    expect(ficha.text).not.toContain('id="cancelar-pedido"');
    const r = await secretaria.post(`${FILA}/${id}/cancelar`, { motivo: "não precisa" }, { seguir: false });
    expect(r.status).toBe(403);
    expect((await pedidos(amb)).at(-1)!.estado).toBe("ENVIADA");
    // e a linha também não
    const [linha] = await linhas_de(amb, id);
    const item = await secretaria.post(`${FILA}/${id}/itens/${linha!.id}/cancelar`, { motivo: "x" }, { seguir: false });
    expect(item.status).toBe(403);
    expect((await linhas_de(amb, id))[0]!.estado).toBe("SOLICITADO");
  });

  it("o titular do pedido cancela o próprio pedido, mesmo aberto por outra pessoa", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const id = await enviado(amb, cen);
    await ligar(amb, "servidor_consulta", cen.servidor);
    const titular = await como(amb, "servidor_consulta");
    expect((await titular.get(`${FILA}/${id}`)).text).toContain('id="cancelar-pedido"');
    const r = await titular.post(`${FILA}/${id}/cancelar`, { motivo: "mudei de setor" }, { seguir: false });
    expect(r.status, recado(r)).toBe(303);
    expect((await pedidos(amb)).at(-1)!.estado).toBe("CANCELADA");
  });

  it("quem analisa cancela; pedido já respondido não se cancela mais", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const id = await enviado(amb, cen);
    const [m] = await amb.db.select().from(e.epi_motivo_recusa).limit(1);
    await amb.db.update(e.epi_requisicao).set({ estado: "INDEFERIDA", motivo_recusa_id: m!.id }).where(eq(e.epi_requisicao.id, id));
    const tecnico = await como(amb, "tecnico_seguranca");
    const r = await tecnico.post(`${FILA}/${id}/cancelar`, { motivo: "desistência" }, { seguir: false });
    expect(recado(r)).toContain("não se cancela mais");
    expect((await pedidos(amb)).at(-1)!.estado).toBe("INDEFERIDA");
  });

  it("pode_cancelar: a regra em uma função só", () => {
    const pedido = { servidor_id: 10, solicitado_por_id: 7 };
    const conta = (o: { id?: number; servidor_id?: number | null; permissoes: string[] }) =>
      new UsuarioAtual({ id: o.id ?? 1, login: "x", nome: "X", permissoes: o.permissoes, perfis: ["secretaria_csso"], servidor_id: o.servidor_id ?? null });
    expect(servico.pode_cancelar(conta({ permissoes: ["epi.requisitar"] }), pedido)).toBe(false);
    expect(servico.pode_cancelar(conta({ id: 7, permissoes: ["epi.requisitar"] }), pedido)).toBe(true);
    expect(servico.pode_cancelar(conta({ servidor_id: 10, permissoes: ["epi.requisitar"] }), pedido)).toBe(true);
    expect(servico.pode_cancelar(conta({ permissoes: ["epi.analisar"] }), pedido)).toBe(true);
  });
});

// =====================================================================
describe("D18 / M21 / M52 — o servidor pede só para si, numa tela só", () => {
  it("escopo próprio: o campo vem travado com o próprio nome e outro id é recusado", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const bruno = await outro_servidor(amb);
    await ligar(amb, "servidor_consulta", cen.servidor);
    const servidor = await como(amb, "servidor_consulta");
    const tela = (await servidor.get(NOVA)).text;
    expect(tela).toContain("Joana Ribeiro de Almeida · SIAPE 7654321");
    expect(tela).toContain("readonly");
    expect(tela).not.toContain('id="busca-servidor"');
    expect(tela).not.toContain('id="chefia_servidor_id"');
    expect(tela).not.toContain("oráculo");
    expect(tela).not.toContain("(RN-19)");

    const alheio = await pedir(servidor, bruno, cen);
    expect(alheio.status).toBe(403);
    expect(await pedidos(amb)).toHaveLength(0);

    const meu = await pedir(servidor, cen.servidor, cen, "enviar");
    expect(meu.status, recado(meu)).toBe(303);
    const [pedido] = await pedidos(amb);
    expect(pedido!.servidor_id).toBe(cen.servidor);
    expect(pedido!.estado).toBe("ENVIADA");
  });

  it("escopo próprio sem servidor ligado: a tela diz o que falta e nada é gravado", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const servidor = await como(amb, "servidor_consulta");
    expect((await servidor.get(NOVA)).text).toContain("não está ligada a um cadastro de servidor");
    const r = await pedir(servidor, cen.servidor, cen);
    expect(r.status).toBe(200);
    expect(r.text).toContain("não está ligada a um cadastro de servidor");
    expect(await pedidos(amb)).toHaveLength(0);
  });

  it("enviar da própria tela protocola com o item; sem item é recusado e nada fica", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const coord = await como(amb, "coordenador_csso");
    const sem_item = await pedir(coord, cen.servidor, null, "enviar");
    expect(sem_item.status).toBe(200);
    expect(sem_item.text).toContain("Escolha o equipamento antes de enviar");
    expect(await pedidos(amb)).toHaveLength(0);

    const r = await pedir(coord, cen.servidor, cen, "enviar");
    expect(recado(r)).toContain("Pedido enviado ao SESMT com o protocolo EPI-");
    const [pedido] = await pedidos(amb);
    expect(pedido!.protocolo).toMatch(/^EPI-\d{4}-\d{4}$/);
    expect(await linhas_de(amb, pedido!.id)).toHaveLength(1);
  });

  it("recusa do item desfaz o rascunho também, e a tela volta com o digitado", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const coord = await como(amb, "coordenador_csso");
    const r = await pedir(coord, cen.servidor, cen, "enviar", { tamanho: "XGG" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("não é um dos tamanhos");
    expect(r.text).toContain("Manipulação de reagentes");
    expect(await pedidos(amb)).toHaveLength(0);
  });

  it("“Pedir troca” chega com o item já escolhido", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const tela = (await (await como(amb, "coordenador_csso")).get(`${NOVA}?item=${cen.item}`)).text;
    expect(tela).toMatch(new RegExp(`<option value="${cen.item}" selected`));
    expect(tela).toContain('id="opcoes-do-item"');
    expect(tela).toContain('name="quantidade"');
  });

  it("chefia de unidade não abre pedido para servidor de outro campus", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const [u1] = await amb.db.select().from(e.unidade_uorg).orderBy(asc(e.unidade_uorg.id)).limit(1);
    const outro_campus = u1!.campus_id + 1000;
    const da_unidade = new UsuarioAtual({
      id: 1, login: "x", nome: "X", permissoes: ["epi.requisitar"], perfis: ["secretaria_csso"], campi: [outro_campus],
    });
    await expect(servico.exigir_requerente_permitido(amb.db, da_unidade, { id: cen.servidor })).rejects.toThrow(
      /outro campus/,
    );
    const do_campus = new UsuarioAtual({
      id: 1, login: "x", nome: "X", permissoes: ["epi.requisitar"], perfis: ["secretaria_csso"], campi: [u1!.campus_id],
    });
    await expect(servico.exigir_requerente_permitido(amb.db, do_campus, { id: cen.servidor })).resolves.toBeUndefined();
  });
});

// =====================================================================
describe("D15 — o comprovante é conferido pelos bytes", () => {
  it("texto com nome .pdf é recusado; PNG de verdade entra com o tipo dos bytes", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const coord = await como(amb, "coordenador_csso");
    expect((await entregar(coord, cen)).status).toBe(303);
    const [registro] = await registros(amb.db);
    const falso = await coord.post(
      `/epis/fichas/registros/${registro!.id}/comprovante`,
      { arquivo: new File([new TextEncoder().encode("nao sou pdf")], "falso.pdf", { type: "application/pdf" }) },
      { seguir: false },
    );
    expect(recado(falso)).toContain("não é um PDF nem uma imagem PNG ou JPEG");
    expect((await registros(amb.db))[0]!.comprovante_anexo_id).toBeNull();

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const ok = await coord.post(
      `/epis/fichas/registros/${registro!.id}/comprovante`,
      { arquivo: new File([png], "assinado.pdf", { type: "application/pdf" }) },
      { seguir: false },
    );
    expect(recado(ok)).toContain("Comprovante anexado");
    const [depois] = await registros(amb.db);
    const [anexo] = await amb.db.select().from(e.anexo).where(eq(e.anexo.id, depois!.comprovante_anexo_id!));
    expect(anexo!.mime_type).toBe("image/png");
  });

  it("tipo_do_comprovante reconhece PDF, PNG e JPEG", () => {
    expect(epi_ficha.tipo_do_comprovante(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
    expect(epi_ficha.tipo_do_comprovante(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(epi_ficha.tipo_do_comprovante(new TextEncoder().encode("PK\u0003\u0004"))).toBeNull();
  });
});

// =====================================================================
describe("D16 — a entrega de balcão leva o tamanho do lote", () => {
  it("tamanho diferente do lote é recusado; em branco herda o do lote", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const coord = await como(amb, "coordenador_csso");
    const errado = await entregar(coord, cen, { tamanho: "G", quantidade: 1 });
    expect(errado.status).toBe(200);
    expect(errado.text).toContain("é do tamanho M, e a entrega diz G");
    expect(await registros(amb.db)).toHaveLength(0);

    expect((await entregar(coord, cen, { tamanho: "", quantidade: 1 })).status).toBe(303);
    expect((await registros(amb.db))[0]!.tamanho_snapshot).toBe("M");
  });
});

// =====================================================================
describe("D17 / M29 — a entrada de lote confere tamanho, CNPJ e lote repetido", () => {
  const lote = (cliente: Cliente, cen: Cenario, troca: Record<string, string> = {}): Promise<Resposta> =>
    cliente.post(
      "/epis/estoque",
      {
        item_id: String(cen.item),
        quantidade_recebida: "5",
        data_entrada: HOJE,
        tamanho: "M",
        lote: "L-NOVO-01",
        numero_ca: "41234",
        validade_ca: "",
        fornecedor_cnpj: "",
        valor_unitario: "",
        ...troca,
      },
      { seguir: false },
    );

  it("tamanho fora da lista do item é recusado com o campo marcado", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const r = await lote(await como(amb, "almoxarife_sesmt"), cen, { tamanho: "XGG" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("XGG&#39; não é um dos tamanhos");
    expect(r.text).toMatch(/class="campo com-erro" id="campo-tamanho"/);
  });

  it("CNPJ com dígito verificador errado é recusado", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const r = await lote(await como(amb, "almoxarife_sesmt"), cen, { fornecedor_cnpj: "11.111.111/1111-11" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("o dígito verificador não confere");
    expect(epi_estoque.cnpj_valido("11222333000181")).toBe(true);
    expect(epi_estoque.cnpj_valido("12345678000199")).toBe(false);
  });

  it("o CNPJ alfanumérico da Receita entra, com a mesma conta do dígito", () => {
    // o exemplo da Receita: 12.ABC.345/01DE-35
    expect(epi_estoque.normalizar_cnpj("12.abc.345/01de-35")).toBe("12ABC34501DE35");
    expect(epi_estoque.cnpj_valido("12ABC34501DE35")).toBe(true);
    expect(epi_estoque.cnpj_valido("12ABC34501DE36")).toBe(false);
    // o dígito verificador é sempre número
    expect(epi_estoque.cnpj_valido("12ABC34501DE3A")).toBe(false);
    expect(() => epi_estoque.normalizar_cnpj("12ABC34501DE36")).toThrow(epi_estoque.EstoqueBloqueado);
    expect(epi_estoque.formatar_cnpj("12ABC34501DE35")).toBe("12.ABC.345/01DE-35");
  });

  it("o mesmo lote do mesmo item e tamanho não entra duas vezes", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const r = await lote(await como(amb, "almoxarife_sesmt"), cen, { lote: "L-2026-08" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("já tem entrada");
    // em outro tamanho é outra caixa, e entra
    expect((await lote(await como(amb, "almoxarife_sesmt"), cen, { lote: "L-2026-08", tamanho: "G" })).status).toBe(303);
  });

  it("o mesmo lote em outra nota fiscal é outra compra: entra, e a nota separa as opções", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const almox = await como(amb, "almoxarife_sesmt");
    const r = await lote(almox, cen, { lote: "L-2026-08", nota_fiscal: "NF-778" });
    expect(r.status, recado(r)).toBe(303);
    // a mesma nota de novo é a mesma entrada digitada duas vezes
    const de_novo = await lote(almox, cen, { lote: "L-2026-08", nota_fiscal: "NF-778" });
    expect(de_novo.status).toBe(200);
    expect(de_novo.text).toContain("já tem entrada");
    // sem nota, nada distingue as entradas: recusada
    expect((await lote(almox, cen, { lote: "L-2026-08", tamanho: "G" })).status).toBe(303);
    expect((await lote(almox, cen, { lote: "L-2026-08", tamanho: "G" })).status).toBe(200);
    const [nova] = await amb.db.select().from(e.epi_entrada_estoque).where(eq(e.epi_entrada_estoque.nota_fiscal, "NF-778"));
    expect(new epi_estoque.LoteDisponivel(nova!, 5).rotulo).toContain("NF NF-778");
  });

  it("valor inválido tem a mensagem padronizada e marca o campo", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const r = await lote(await como(amb, "almoxarife_sesmt"), cen, { valor_unitario: "doze" });
    expect(r.text).toContain("Valor unitário inválido: use números, ex. 12,50.");
    expect(r.text).toMatch(/class="campo com-erro">\s*<label for="valor_unitario">/);
  });

  it("o seletor de tamanho vem do item", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const r = await (await como(amb, "almoxarife_sesmt")).get(`/epis/estoque/tamanhos?item_id=${cen.item}`);
    expect(r.text).toContain('<option value="P"');
    expect(r.text).toContain('<option value="G"');
  });
});

// =====================================================================
describe("D19 / D82 / D83 — link só com a permissão do destino", () => {
  it("a fila do servidor não oferece o balcão", async () => {
    const amb = await novo();
    const fila = (await (await como(amb, "servidor_consulta")).get(FILA)).text;
    expect(fila).not.toContain('href="/epis/entregas/nova');
    const nova = (await (await como(amb, "secretaria_csso")).get(NOVA)).text;
    expect(nova).not.toContain('href="/epis/entregas/nova');
  });

  it("o extrato do lote não liga a ficha para a secretaria", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    await entregar(await como(amb, "coordenador_csso"), cen);
    const extrato = (await (await como(amb, "secretaria_csso")).get(`/epis/estoque/${cen.entrada}/movimentos`)).text;
    expect(extrato).toContain("ficha nº");
    expect(extrato).not.toContain('href="/epis/fichas/registros/');
  });

  it("o anexo da ficha de outra pessoa volta para a própria ficha, com recado", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    await entregar(await como(amb, "coordenador_csso"), cen);
    const [registro] = await registros(amb.db);
    await ligar(amb, "servidor_consulta", await outro_servidor(amb));
    const r = await (await como(amb, "servidor_consulta")).get(`/epis/fichas/registros/${registro!.id}/anexo`, {
      seguir: false,
    });
    expect(r.status).toBe(303);
    expect(r.location).toMatch(/^\/epis\/fichas\/minha\?erro=/);
  });
});

// =====================================================================
describe("D20 / M26 — o painel e a fila de falta no escopo de quem lê", () => {
  it("itens esperando estoque saem pelo escopo do usuário", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const bruno = await outro_servidor(amb);
    const [conta] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
    const falta = async (servidor_id: number) => {
      const numero = 900 + servidor_id;
      const [r] = await amb.db
        .insert(e.epi_requisicao)
        .values({ servidor_id, solicitado_por_id: conta!.id, estado: "ANALISADA", ano: 2026, numero, protocolo: `EPI-2026-${numero}`, termo_exigido: false })
        .returning();
      await amb.db
        .insert(e.epi_requisicao_item)
        .values({ requisicao_id: r!.id, epi_item_id: cen.item, quantidade_solicitada: 1, quantidade_aprovada: 1, estado: "SEM_ESTOQUE" });
      return r!.id;
    };
    const da_joana = await falta(cen.servidor);
    await falta(bruno);
    const joana = new UsuarioAtual({
      id: 999, login: "j", nome: "J", permissoes: ["epi.ver"], perfis: ["servidor_consulta"], servidor_id: cen.servidor,
    });
    const vistos = await servico.itens_esperando_estoque(amb.db, { usuario: joana });
    expect(vistos.map((l) => l.requisicao_id)).toEqual([da_joana]);
    expect(await servico.itens_esperando_estoque(amb.db)).toHaveLength(2);
  });

  it("o servidor comum vê o painel dele, sem números do setor nem código de permissão", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    await enviado(amb, cen);
    await ligar(amb, "servidor_consulta", await outro_servidor(amb));
    const painel = (await (await como(amb, "servidor_consulta")).get("/epis")).text;
    expect(painel).toContain("Meus pedidos");
    expect(painel).toContain("Minhas trocas vencidas");
    expect(painel).not.toContain("EPI-");
    expect(painel).not.toContain("<code>epi.");
  });
});

// =====================================================================
describe("D21 / M23 — o catálogo marca o campo que falhou", () => {
  it("máxima menor que a padrão marca e foca a máxima, não o nome", async () => {
    const amb = await novo();
    const [categoria] = await amb.db.select().from(e.epi_categoria).limit(1);
    const r = await (await como(amb, "tecnico_seguranca")).post(
      "/epis/catalogo",
      { nome: "Bota X", categoria_id: String(categoria!.id), quantidade_padrao: "5", quantidade_maxima: "2", periodo_maximo_meses: "12" },
      { seguir: false },
    );
    expect(r.status).toBe(200);
    expect(r.text).toContain("A quantidade máxima não pode ser menor que a padrão.");
    expect(r.text).toContain('<div class="campo com-erro"><label for="novo-maxima">');
    expect(r.text).toContain('<div class="campo"><label for="novo-nome">');
    expect(r.text).toMatch(/id="novo-maxima"[^>]*autofocus/);
  });

  it("editar abre o mesmo formulário num popup, e a recusa reabre o popup do item", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const tecnico = await como(amb, "tecnico_seguranca");
    const lista = (await tecnico.get("/epis/catalogo")).text;
    expect(lista).toContain(`id="editar-epi-${cen.item}"`);
    expect(lista).not.toContain(`form="f-epi-${cen.item}"`);
    const r = await tecnico.post(`/epis/catalogo/${cen.item}`, { nome: "", categoria_id: "1", quantidade_padrao: "1" }, { seguir: false });
    expect(r.status).toBe(200);
    expect(r.text).toMatch(new RegExp(`<dialog class="popup" id="editar-epi-${cen.item}"[^>]* open>`));
  });
});

// =====================================================================
describe("D22 / M25 — recados em linguagem comum, e o indeferimento de uma vez", () => {
  it("indeferir recusa os pendentes com o motivo, e o recado diz o motivo pelo nome", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const id = await enviado(amb, cen);
    const tecnico = await como(amb, "tecnico_seguranca");
    await tecnico.post(`${FILA}/${id}/analise`, {}, { seguir: false });
    expect((await tecnico.get(`${FILA}/${id}`)).text).toContain('id="indeferir"');
    const [m] = await amb.db.select().from(e.epi_motivo_recusa).where(eq(e.epi_motivo_recusa.codigo, "SEM_EXPOSICAO"));
    const r = await tecnico.post(`${FILA}/${id}/indeferir`, { motivo_id: String(m!.id), complemento: "Posto sem o agente", parecer: "" }, {
      seguir: false,
    });
    const texto = recado(r);
    expect(texto).toContain(m!.rotulo);
    expect(texto).not.toContain("SEM_EXPOSICAO");
    expect((await pedidos(amb)).at(-1)!.estado).toBe("INDEFERIDA");
    expect((await linhas_de(amb, id))[0]!.estado).toBe("RECUSADO");
  });

  it("concluir não escreve código de estado, e o HTMX diz que aprovou", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const id = await enviado(amb, cen);
    const tecnico = await como(amb, "tecnico_seguranca");
    await tecnico.post(`${FILA}/${id}/analise`, {}, { seguir: false });
    const [linha] = await linhas_de(amb, id);
    const parcial = await tecnico.post(
      `${FILA}/${id}/itens/${linha!.id}/aprovar`,
      { quantidade_aprovada: "1", justificativa: "" },
      { seguir: false, cabecalhos: { "HX-Request": "true" } },
    );
    expect(parcial.status).toBe(200);
    expect(parcial.text).toMatch(/aviso aviso-ok" role="status">[^<]*aprovado/);
    const r = await tecnico.post(`${FILA}/${id}/concluir`, { parecer: "" }, { seguir: false });
    const texto = recado(r);
    expect(texto).toContain("em atendimento");
    expect(texto).not.toMatch(/`|EM_ATENDIMENTO|ATENDIDA/);
  });

  it("a guia só aparece com item aprovado, e a trilha vem recolhida para a secretaria", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const id = await enviado(amb, cen);
    const ficha = (await (await como(amb, "secretaria_csso")).get(`${FILA}/${id}`)).text;
    expect(ficha).not.toContain(`/epis/requisicoes/${id}/guia`);
    expect(ficha).toContain('<details class="recolhido" id="trilha-do-pedido">');
    expect(ficha).not.toContain("append-only");
  });
});

// =====================================================================
describe("D23 / M28 — custo em real e exercício escolhido na tela", () => {
  it("o custo sai como R$ 3.150,00, e há o seletor de exercício", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db, { recebido: 3 });
    await amb.db.update(e.epi_entrada_estoque).set({ valor_unitario: "1050.00", data_entrada: HOJE }).where(eq(e.epi_entrada_estoque.id, cen.entrada));
    const tela = (await (await como(amb, "coordenador_csso")).get("/epis/relatorios")).text;
    expect(tela).toContain("R$ 3.150,00");
    expect(tela).not.toContain("3150.00");
    expect(tela).toContain('<select id="exercicio" name="exercicio">');
    expect(tela).not.toContain('aria-current="page">Relatórios');
  });
});

// =====================================================================
describe("M20 / M51 / M22 — a ficha fala com o titular, e o estorno avisa do saldo", () => {
  it("o titular lê a situação em palavras, sem hash, e pede a troca vencida", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const coord = await como(amb, "coordenador_csso");
    expect((await entregar(coord, cen, { data_evento: "2025-01-02" })).status).toBe(303);
    await ligar(amb, "servidor_consulta", cen.servidor);
    const minha = await (await como(amb, "servidor_consulta")).get("/epis/fichas/minha");
    expect(minha.text).toContain("Falta você assinar o comprovante");
    expect(minha.text).toContain("passou do prazo de troca");
    expect(minha.text).toContain(`/epis/requisicoes/nova?item=${cen.item}`);
    expect(minha.text).toContain('class="empilhavel"');
    expect(minha.text).toContain("tabela-cartao lista sem-altura");
    expect(minha.text).not.toContain("SHA-256");
    expect(minha.text).not.toContain("sem poder demonstrá-la");
  });

  it("quem opera o balcão vê a própria ficha como operador, com as ações da linha", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    await entregar(await como(amb, "coordenador_csso"), cen);
    const [registro] = await registros(amb.db);
    await ligar(amb, "almoxarife_sesmt", cen.servidor);
    const propria = (await (await como(amb, "almoxarife_sesmt")).get(`/epis/fichas/${cen.servidor}`)).text;
    expect(propria).toContain(`href="#anexar-${registro!.id}"`);
    expect(propria).not.toContain("Falta você assinar o comprovante");
  });

  it("a linha sem comprovante tem imprimir e anexar à vista, e o estorno avisa que o saldo não volta", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const coord = await como(amb, "coordenador_csso");
    await entregar(coord, cen);
    const [registro] = await registros(amb.db);
    const ficha = (await coord.get(`/epis/fichas/${cen.servidor}`)).text;
    expect(ficha).toContain(`href="#anexar-${registro!.id}"`);
    expect(ficha).toContain(`<dialog class="popup" id="anexar-${registro!.id}"`);
    expect(ficha).toContain("lotação na entrega:");
    const r = await coord.post(`/epis/fichas/registros/${registro!.id}/estorno`, { motivo: "lote errado" }, { seguir: false });
    expect(r.location).toContain(`lote_estornado=${cen.entrada}`);
    const depois = (await coord.get(r.location!)).text;
    expect(depois).toContain("não foi\n      reposto");
    expect(depois).toContain(`/epis/estoque#ajuste-lote-${cen.entrada}`);
  });
});

// =====================================================================
describe("M27 — a fila do servidor e o filtro inválido", () => {
  it("o servidor vê “Meus pedidos”, sem selo de permissão, e o filtro torto é avisado", async () => {
    const amb = await novo();
    const fila = (await (await como(amb, "servidor_consulta")).get(`${FILA}?estado=XYZ`)).text;
    expect(fila).toContain("Meus pedidos de EPI");
    expect(fila).not.toContain("somente leitura");
    expect(fila).toContain("não é um estado de pedido");
  });
});

// =====================================================================
describe("M84 — a permissão antes do formulário", () => {
  it("quem não edita o catálogo recebe 403, e não “preencha o campo”", async () => {
    const amb = await novo();
    const [categoria] = await amb.db.select().from(e.epi_categoria).limit(1);
    const secretaria = await como(amb, "secretaria_csso");
    expect((await secretaria.post(`/epis/catalogo/categorias/${categoria!.id}`, {}, { seguir: false })).status).toBe(403);
    const [motivo] = await amb.db.select().from(e.epi_motivo_recusa).limit(1);
    expect((await secretaria.post(`/epis/catalogo/motivos-recusa/${motivo!.id}`, {}, { seguir: false })).status).toBe(403);
  });
});
