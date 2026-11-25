/**
 * Ajustes do reteste do lote 5 (25/11/2026): 1 frase do dono no singular, 2 saúde em rotina e
 * riscos declarados (caixa de confirmação), 3 pendência concluída que se lia como aberta,
 * 4 a página de 403 em recusa de regra, 5 a cópia do comprovante para o titular, 6 o cartão
 * "A vencer" com o nome do treinamento.
 */
import { asc, desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as e from "../src/db/esquema/index.js";
import { somar_dias } from "../src/dominio/datas.js";
import { hoje } from "../src/servicos/datas_br.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste, type Cliente, type Resposta } from "./ajuda";
import { _cenario, _usuario } from "./ajuda_certificado";
import { cenario, entregar, recado, registros, type Cenario } from "./ajuda_epi_ficha";

const FILA = "/epis/requisicoes";
const CONCESSAO = "A saída é a concessão do perfil";

await bancoLimpo();

async function novo(): Promise<AmbienteDeTeste> {
  const amb = await bancoLimpo();
  await contas(amb.db);
  return amb;
}
const como = (amb: AmbienteDeTeste, login: string): Promise<Cliente> => entrar(amb.novoCliente(), login);
const ligar = (amb: AmbienteDeTeste, login: string, servidor_id: number | null) =>
  amb.db.update(e.usuario).set({ servidor_id }).where(eq(e.usuario.login, login));

/** O pedido da própria tela, da conta de servidor ligada a quem vai usar. */
function pedir(cliente: Cliente, cen: Cenario, extra: Record<string, string> = {}): Promise<Resposta> {
  return cliente.post(
    FILA,
    {
      servidor_id: String(cen.servidor),
      finalidade: "ROTINA",
      descricao_atividade: "Manipulação de reagentes no laboratório",
      riscos_declarados: "Respingo de ácido",
      urgencia: "NORMAL",
      item_id: String(cen.item),
      quantidade: "1",
      tamanho: "M",
      motivo: "DESGASTE",
      ...extra,
    },
    { seguir: false },
  );
}

// =====================================================================
describe("ajuste 1 — com dono, a frase do cartão de ajudantes fica no singular", () => {
  it("'só <dono> ou a coordenação acima altera esta turma', nunca '<nome> alteram'", async () => {
    const amb = await novo();
    const cli = await como(amb, "coordenador_csso");
    const r = await cli.post(
      "/treinamentos/catalogo",
      { codigo: "AJ1", nome: "Treinamento do ajuste 1", carga_horaria_horas: "4", carga_unidade: "HORAS", validade_meses: "12" },
      { seguir: false },
    );
    expect(r.status).toBe(303);
    const [t] = await amb.db.select().from(e.treinamento).orderBy(desc(e.treinamento.id)).limit(1);
    const rt = await cli.post(
      "/turmas",
      { treinamento_id: String(t!.id), data_inicio: somar_dias(hoje(), 5), data_fim: somar_dias(hoje(), 5), local: "Sala", frequencia_minima_percentual: "75" },
      { seguir: false },
    );
    expect(rt.status).toBe(303);
    const [turma] = await amb.db.select().from(e.turma).orderBy(desc(e.turma.id)).limit(1);
    const aba = (await cli.get(`/turmas/${turma!.id}?aba=turma`)).text.replace(/\s+/g, " ");
    expect(aba).toContain("ou a coordenação acima altera esta turma.");
    expect(aba).not.toMatch(/Nenhum ajudante: só [^<]*? alteram esta turma/);
  });
});

// =====================================================================
describe("ajuste 2 — rotina e riscos declarados: termo de saúde pede a caixa (conta de servidor, pela tela)", () => {
  async function servidor(): Promise<{ amb: AmbienteDeTeste; cen: Cenario; cli: Cliente }> {
    const amb = await novo();
    const cen = await cenario(amb.db);
    await ligar(amb, "servidor_consulta", cen.servidor);
    return { amb, cen, cli: await como(amb, "servidor_consulta") };
  }
  const pedidos = (amb: AmbienteDeTeste) => amb.db.select().from(e.epi_requisicao).orderBy(asc(e.epi_requisicao.id));

  it("'tenho alergia ao látex' em riscos declarados: volta com a caixa e a mensagem do posto; com a caixa, grava", async () => {
    const { amb, cen, cli } = await servidor();
    const r = await pedir(cli, cen, { riscos_declarados: "tenho alergia ao látex" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("descreve o posto e os riscos da atividade");
    expect(r.text).toContain("não a saúde de quem pede");
    expect(r.text).toContain('name="confirmo_mencao_saude"');
    expect(await pedidos(amb)).toHaveLength(0);
    const ok = await pedir(cli, cen, { riscos_declarados: "tenho alergia ao látex", confirmo_mencao_saude: "1" });
    expect(ok.status, recado(ok)).toBe(303);
    expect((await pedidos(amb))[0]!.riscos_declarados).toBe("tenho alergia ao látex");
  });

  it("'asma' na rotina de trabalho também pede a caixa", async () => {
    const { cen, cli } = await servidor();
    const r = await pedir(cli, cen, { descricao_atividade: "Trabalho com asma ocupacional no setor" });
    expect(r.status).toBe(200);
    expect(r.text).toContain('name="confirmo_mencao_saude"');
  });

  it("'risco de dermatite de contato' e 'risco de lesão por corte' passam, com a caixa", async () => {
    for (const texto of ["risco de dermatite de contato", "risco de lesão por corte"]) {
      const { amb, cen, cli } = await servidor();
      const sem = await pedir(cli, cen, { riscos_declarados: texto });
      expect(sem.status, texto).toBe(200);
      expect(sem.text, texto).toContain('name="confirmo_mencao_saude"');
      const com = await pedir(cli, cen, { riscos_declarados: texto, confirmo_mencao_saude: "1" });
      expect(com.status, texto).toBe(303);
      expect((await pedidos(amb))[0]!.riscos_declarados).toBe(texto);
    }
  });

  it("a lista antiga continua bloqueando, mesmo com a caixa marcada (gestante, CID)", async () => {
    for (const texto of ["servidora gestante", "CID J45"]) {
      const { amb, cen, cli } = await servidor();
      const r = await pedir(cli, cen, { riscos_declarados: texto, confirmo_mencao_saude: "1" });
      expect(r.status, texto).toBe(200);
      expect(r.text, texto).toContain("não podem ser registrados no EPI");
      expect(await pedidos(amb)).toHaveLength(0);
    }
  });

  it("texto do posto sem termo de saúde grava sem caixa", async () => {
    const { amb, cen, cli } = await servidor();
    const r = await pedir(cli, cen, { riscos_declarados: "Respingo de ácido sulfúrico na bancada" });
    expect(r.status, recado(r)).toBe(303);
    expect(await pedidos(amb)).toHaveLength(1);
  });
});

// =====================================================================
describe("ajuste 3 — pendência concluída não se lê como aberta", () => {
  it("a seção 'Concluídas recentemente' diz o tipo, com 'concluída', e não repete 'espera você retirar'", async () => {
    const amb = await novo();
    const [coord] = await amb.db.select().from(e.usuario).where(eq(e.usuario.login, "coordenador_csso"));
    await amb.db.insert(e.pendencia).values({
      tipo: "EPI_RETIRADA_DISPONIVEL",
      descricao: "2 × 'Luva' do pedido EPI-2026-0001 está separado no lote L-1 e espera você retirar.",
      responsavel_id: coord!.id,
      concluida: true,
      concluida_em: new Date(),
      criada_em: new Date(),
      chave: "retirada:requisicao_item:999",
    });
    const tela = (await (await como(amb, "coordenador_csso")).get("/pendencias")).text;
    expect(tela).toContain("Concluídas recentemente");
    expect(tela).toContain("Retirar o EPI reservado para você");
    expect(tela).not.toContain("espera você retirar");
  });
});

// =====================================================================
describe("ajuste 4 — recusa de regra: a página diz o motivo, sem a orientação de concessão", () => {
  it("pedir EPI para outra pessoa: motivo e caminho, sem 'concessão do perfil'", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    const [outro] = await amb.db.insert(e.servidor).values({ siape: "1112225", nome: "Bruno Outro" }).returning();
    await ligar(amb, "servidor_consulta", outro!.id);
    const r = await pedir(await como(amb, "servidor_consulta"), cen);
    expect(r.status).toBe(403);
    expect(r.text).toContain("O pedido de EPI é individual");
    expect(r.text).toContain("Nenhuma permissão muda isso");
    expect(r.text).not.toContain(CONCESSAO);
  });

  it("o servidor tentando analisar o próprio pedido lê a RN-28, sem 'concessão do perfil'", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    await ligar(amb, "servidor_consulta", cen.servidor);
    const cli = await como(amb, "servidor_consulta");
    const r = await pedir(cli, cen, { acao: "enviar", termo_aceito: "1" });
    expect(r.status, recado(r)).toBe(303);
    const [pedido] = await amb.db.select().from(e.epi_requisicao).orderBy(desc(e.epi_requisicao.id)).limit(1);
    for (const sufixo of ["indeferir", "aprovar-tudo"]) {
      const t = await cli.post(`${FILA}/${pedido!.id}/${sufixo}`, { motivo_id: "1" }, { seguir: false });
      expect(t.status, sufixo).toBe(403);
      expect(t.text, sufixo).toContain("Quem analisa não é quem requisita");
      expect(t.text, sufixo).not.toContain(CONCESSAO);
    }
  });

  it("falta de permissão comum continua com a orientação de concessão", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    await ligar(amb, "coordenador_csso", cen.servidor);
    expect((await pedir(await como(amb, "coordenador_csso"), cen, { acao: "enviar", termo_aceito: "1" })).status).toBe(303);
    await ligar(amb, "coordenador_csso", null);
    const [pedido] = await amb.db.select().from(e.epi_requisicao).orderBy(desc(e.epi_requisicao.id)).limit(1);
    // o servidor de outra pessoa (não é o dono do pedido) sem epi.analisar
    const [outro] = await amb.db.insert(e.servidor).values({ siape: "1112226", nome: "Carla Outra" }).returning();
    await ligar(amb, "servidor_consulta", outro!.id);
    const t = await (await como(amb, "servidor_consulta")).post(`${FILA}/${pedido!.id}/aprovar-tudo`, {}, { seguir: false });
    expect(t.status).toBe(403);
    expect(t.text).toContain(CONCESSAO);
  });
});

// =====================================================================
describe("ajuste 5 — o titular baixa a cópia do comprovante das próprias entregas", () => {
  it("o próprio: 200, o mesmo .docx, trilha de cópia (não de impressão); de outra pessoa: 403 de regra", async () => {
    const amb = await novo();
    const cen = await cenario(amb.db);
    expect((await entregar(await como(amb, "coordenador_csso"), cen)).status).toBe(303);
    const [registro] = await registros(amb.db);
    await ligar(amb, "servidor_consulta", cen.servidor);
    const cli = await como(amb, "servidor_consulta");
    expect((await cli.get(`/epis/fichas/${cen.servidor}`)).text).toContain("Comprovante (cópia)");
    const r = await cli.get(`/epis/fichas/registros/${registro!.id}/comprovante`, { seguir: false });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("wordprocessingml");
    const trilha = await amb.db.select().from(e.historico_evento).where(eq(e.historico_evento.entidade_id, registro!.id));
    expect(trilha.map((h) => h.tipo_evento)).toContain("EPI_COMPROVANTE_COPIA_TITULAR");
    expect(trilha.map((h) => h.tipo_evento)).not.toContain("EPI_COMPROVANTE_IMPRESSO");

    const [outro] = await amb.db.insert(e.servidor).values({ siape: "1112227", nome: "Dora Outra" }).returning();
    await ligar(amb, "servidor_consulta", outro!.id);
    const alheio = await (await como(amb, "servidor_consulta")).get(`/epis/fichas/registros/${registro!.id}/comprovante`, { seguir: false });
    expect(alheio.status).toBe(403);
    expect(alheio.text).not.toContain(CONCESSAO);
  });
});

// =====================================================================
describe("ajuste 6 — o cartão 'A vencer' mostra o nome do treinamento", () => {
  it("'Próximo: Trabalho em Altura — NR-35', e não só a norma", async () => {
    const amb = await novo();
    const usuario = await _usuario(amb.db);
    const cen = await _cenario(amb.db, usuario);
    const emissao = await import("../src/servicos/emissao_certificado.js");
    await emissao.emitir(amb.db, usuario, cen.inscricao, { gerar_pdf: false });
    await ligar(amb, "servidor_consulta", cen.servidor.id);
    const inicio = (await (await como(amb, "servidor_consulta")).get("/")).text;
    expect(inicio).toContain("Próximo: Trabalho em Altura — NR-35");
  });
});
