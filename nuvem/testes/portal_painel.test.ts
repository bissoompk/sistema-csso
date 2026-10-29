/**
 * NUVEM (Portal do servidor, 22/10/2026): o menu do "Meu espaço" e o painel
 * do titular (Início).
 *
 * O que protegem:
 * - a condição "titular": o Início aparece para a conta ligada a servidor
 *   mesmo sem `processo.ver`; a conta de equipe SEM servidor não ganha o bloco;
 * - os grupos (Treinamentos, EPI, Adicional, Eu), os itens novos (Comprovante,
 *   Minha atividade, Meu perfil) e "Meus dados" fora do menu;
 * - `aria-current="page"` no item ativo, o cartão de identificação e o "Sair";
 * - os cartões de status contam o que o teste montou; os chips não levam SIAPE
 *   nem CPF; aviso vermelho com NR vencida, nenhum aviso quando não há nada;
 * - os atalhos seguem as permissões do menu; nada de `style=`/`<script>` inline.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import * as modulos from "../src/modulos.js";
import { inicio_do_servidor } from "../src/rotas/painel.js";
import { somar_dias } from "../src/dominio/datas.js";
import * as datas_br from "../src/servicos/datas_br.js";
import * as servico_certificado from "../src/servicos/certificado.js";
import * as servico_participante from "../src/servicos/participante.js";
import { UsuarioAtual } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, criarUsuario, entrar, liberarProcessos, usuarioAtual } from "./ajuda";

const { db, novoCliente } = await bancoLimpo();
await contas(db);
const HOJE = datas_br.hoje();
const ANO = Number(HOJE.slice(0, 4));

// --- o cadastro: campus, unidade com sigla, cargo ---
const [campus] = await db.insert(e.campus).values({ sigla: "PTJK", nome: "Campus Portal", cidade: "Diamantina" }).returning();
const [unidade] = await db
  .insert(e.unidade_uorg)
  .values({ sigla: "ICTP", nome_oficial: "INSTITUTO PORTAL", nome_extenso: "Instituto do Portal", tipo: "INSTITUTO", campus_id: campus!.id })
  .returning();
const [cargo] = await db.insert(e.cargo).values({ nome: "Técnica de Laboratório do Portal" }).returning();

async function novo_servidor(siape: string, nome: string) {
  const [s] = await db
    .insert(e.servidor)
    .values({ siape, nome, unidade_uorg_id: unidade!.id, cargo_id: cargo!.id })
    .returning();
  return s!;
}

const ana = await novo_servidor("7700001", "MARIANA ALVES ROCHA");
const bia = await novo_servidor("7700002", "Beatriz Sem Pendencia");
await criarUsuario(db, { login: "titular_mariana", nome: "Mariana Alves Rocha", perfis: ["servidor_consulta"], servidor_id: ana.id });
await criarUsuario(db, { login: "titular_beatriz", nome: "Beatriz Sem Pendencia", perfis: ["servidor_consulta"], servidor_id: bia.id });

// --- três certificados da Mariana: NR-35 vencido, NR-10 a vencer, NR-06 válido ---
let sequencia = 0;
async function treinamento(codigo: string, validade_meses: number) {
  const [t] = await db
    .insert(e.treinamento)
    .values({ codigo, nome: `Treinamento ${codigo}`, carga_horaria_horas: "8", validade_meses })
    .returning();
  return t!;
}
async function certificado(servidor: typeof ana, t: Awaited<ReturnType<typeof treinamento>>, emissao: string) {
  sequencia += 1;
  const ano = Number(emissao.slice(0, 4));
  const pessoa = await servico_participante.de_servidor(db, servidor);
  const [turma] = await db
    .insert(e.turma)
    .values({
      treinamento_id: t.id,
      numero: 500 + sequencia,
      ano,
      codigo: `PTL-${ano}-${String(sequencia).padStart(3, "0")}`,
      data_inicio: emissao,
      data_fim: emissao,
      situacao: "CONCLUIDA",
    })
    .returning();
  const [inscricao] = await db
    .insert(e.inscricao)
    .values({ turma_id: turma!.id, participante_id: pessoa.id, situacao: "APROVADO" })
    .returning();
  await db.insert(e.certificado).values({
    inscricao_id: inscricao!.id,
    numero: 7700 + sequencia,
    ano,
    chave_validacao: servico_certificado.gerar_chave(ano),
    situacao: "EMITIDO",
    data_emissao: emissao,
    data_base_vencimento: emissao,
    data_vencimento: datas_br.somar_meses(emissao, t.validade_meses!),
    validade_meses_congelada: t.validade_meses,
    contexto_congelado: {
      turma_codigo: turma!.codigo,
      treinamento_nome: t.nome,
      treinamento_norma: t.codigo,
      turma_data_inicio: emissao,
      turma_data_fim: emissao,
      carga_horaria: "8",
    },
    modelo_arquivo: "certificado_padrao_v1.docx",
    servidor_id: servidor.id,
    treinamento_id: t.id,
    participante_id: pessoa.id,
  });
}
const nr35 = await treinamento("NR-35", 24);
const nr10 = await treinamento("NR-10", 24);
const nr06 = await treinamento("NR-06", 24);
await certificado(ana, nr35, datas_br.somar_meses(HOJE, -25));
// vence daqui a 30 dias: a janela de "a vencer" é 60
await certificado(ana, nr10, datas_br.somar_meses(somar_dias(HOJE, 30), -24));
await certificado(ana, nr06, somar_dias(HOJE, -10));

// --- uma turma com inscrições abertas e uma inscrição CONFIRMADA que começa em 3 dias ---
await db.insert(e.turma).values({
  treinamento_id: nr35.id,
  numero: 600,
  ano: ANO,
  codigo: `PTL-${ANO}-ABERTA`,
  data_inicio: somar_dias(HOJE, 20),
  data_fim: somar_dias(HOJE, 21),
  situacao: "INSCRICOES_ABERTAS",
});
const [proxima] = await db
  .insert(e.turma)
  .values({
    treinamento_id: nr35.id,
    numero: 601,
    ano: ANO,
    codigo: `PTL-${ANO}-PROXIMA`,
    data_inicio: somar_dias(HOJE, 3),
    data_fim: somar_dias(HOJE, 3),
    local: "Auditório do Portal",
    situacao: "PLANEJADA",
  })
  .returning();
const pessoa_ana = await servico_participante.de_servidor(db, ana);
await db.insert(e.inscricao).values({ turma_id: proxima!.id, participante_id: pessoa_ana.id, situacao: "CONFIRMADA" });

// --- um pedido de EPI em aberto (ENVIADA) da Mariana ---
const [conta_ana] = await db.select().from(e.usuario).where(eq(e.usuario.login, "titular_mariana"));
await db.insert(e.epi_requisicao).values({
  protocolo: `EPI-${ANO}-0901`,
  numero: 901,
  ano: ANO,
  servidor_id: ana.id,
  solicitado_por_id: conta_ana!.id,
  estado: "ENVIADA",
  enviada_em: new Date(),
  termo_exigido: false,
});

function lateral(corpo: string): string {
  return corpo.slice(corpo.indexOf('<aside class="lateral">'), corpo.indexOf("</aside>"));
}
function bloco_meu(corpo: string): string {
  const l = lateral(corpo);
  return l.slice(l.indexOf('id="lateral-meu"'));
}

const titular_sem_processo = (permissoes: string[]) =>
  new UsuarioAtual({ id: conta_ana!.id, login: "x", nome: "Mariana Alves Rocha", permissoes, perfis: ["servidor_consulta"], servidor_id: ana.id });

describe("menu do Meu espaço", () => {
  it("o titular sem `processo.ver` vê o Início (condição titular)", () => {
    const u = titular_sem_processo(["treinamento.ver", "epi.ver"]);
    expect(modulos.so_o_proprio(u)).toBe(true);
    const caminhos = modulos.meu_espaco_de(u).map((i) => i.caminho);
    expect(caminhos[0]).toBe("/");
    expect(caminhos).toContain("/minha-atividade");
    expect(caminhos).toContain("/minha-conta");
    // sem a permissão, o adicional e os processos não entram
    expect(caminhos).not.toContain("/adicionais");
    expect(caminhos).not.toContain("/processos");
  });

  it("a rota do Início abre para o titular sem `processo.ver`, e o painel não traz o adicional", async () => {
    const dados = await inicio_do_servidor(db, titular_sem_processo(["treinamento.ver", "epi.ver"]), HOJE);
    expect(dados.ve_processo).toBe(false);
    expect(dados.total_meus).toBe(0);
    expect(dados.adicional).toBeNull();
  });

  it("a conta de equipe sem servidor não tem Meu espaço", async () => {
    const coordenador = await usuarioAtual(db, "coordenador_csso");
    expect(coordenador.servidor_id).toBeNull();
    expect(modulos.meu_espaco_de(coordenador)).toEqual([]);
    const corpo = (await (await entrar(novoCliente(), "coordenador_csso")).get("/")).text;
    expect(lateral(corpo)).not.toContain('aria-label="Meu espaço"');
    expect(corpo).not.toContain('class="ident-lateral"');
  });

  it("grupos com subtítulo, itens novos, Meu perfil e nada de Meus dados", async () => {
    const u = await usuarioAtual(db, "titular_mariana");
    const nav = modulos.navegacao("/", u);
    // o grupo "Adicional" só com a exceção da pessoa em Processos SEI (25/10/2026)
    expect(nav.grupos_meu_espaco.map((g) => g.titulo)).toEqual([null, "Treinamentos", "EPI", "Ocorrências", "Acidentes", "Eu"]);
    expect(nav.grupos_meu_espaco.map((g) => g.itens.map((i) => i.rotulo))).toEqual([
      ["Início"],
      ["Meus treinamentos", "Meus certificados", "Comprovante de treinamentos"],
      ["Minha ficha de EPI", "Meus pedidos de EPI", "Pedir EPI"],
      ["Registrar ocorrência", "Minhas ocorrências"],
      ["Comunicar acidente", "Minhas comunicações"],
      ["Minha atividade", "Meu perfil"],
    ]);
    await liberarProcessos(db, "titular_mariana");
    try {
      const liberada = modulos.navegacao("/", await usuarioAtual(db, "titular_mariana"));
      expect(liberada.grupos_meu_espaco.find((g) => g.titulo === "Adicional")?.itens.map((i) => i.rotulo)).toEqual([
        "Meu adicional",
        "Meus processos",
      ]);
    } finally {
      await liberarProcessos(db, "titular_mariana", false);
    }
    const corpo = (await (await entrar(novoCliente(), "titular_mariana")).get("/")).text;
    const meu = bloco_meu(corpo);
    expect(meu).toMatch(/<span class="rotulo-grupo" id="grupo-meu-\d+">Treinamentos<\/span>/);
    expect(meu).toMatch(/<span class="rotulo-grupo" id="grupo-meu-\d+">Eu<\/span>/);
    expect(meu).toContain('href="/certificados/meus/comprovante"');
    expect(meu).toContain('href="/minha-atividade"');
    expect(meu).toContain("<span>Meu perfil</span>");
    expect(meu).not.toContain("Meus dados");
    expect(meu).not.toContain(`href="/servidores/${ana.id}"`);
    // o "Sair" no pé, depois do divisor, leva à tela que faz o POST com CSRF
    expect(meu).toMatch(/<div class="menu-meu-pe">\s*<a class="sair-meu" href="\/sair" data-rotulo="Sair">/);
    // o cabeçalho continua levando o nome da pessoa a /minha-conta
    expect(corpo).toMatch(/aria-label="Minha conta \([^)]*\)"/);
  });

  it("o cartão de identificação: iniciais escondidas do leitor, nome inteiro no title, lotação", async () => {
    const corpo = (await (await entrar(novoCliente(), "titular_mariana")).get("/")).text;
    const l = lateral(corpo);
    expect(l).toContain('<span class="ident-avatar" aria-hidden="true">MR</span>');
    expect(l).toContain('<strong class="ident-nome" title="Mariana Alves Rocha">Mariana Alves Rocha</strong>');
    expect(l).toContain('<span class="ident-linha">ICTP · Campus Portal</span>');
    expect(modulos.iniciais_de("Maria da Silva dos Santos")).toBe("MS");
    expect(modulos.iniciais_de("")).toBe("?");
  });

  it("`aria-current` no item ativo do Meu espaço", async () => {
    const cliente = await entrar(novoCliente(), "titular_mariana");
    const meu = bloco_meu((await cliente.get("/certificados/meus")).text);
    expect(meu).toMatch(/<a href="\/certificados\/meus"[^>]*class="ativo"[^>]*aria-current="page"/);
    expect(meu.match(/aria-current="page"/g)).toHaveLength(1);
    const inicio = bloco_meu((await cliente.get("/")).text);
    expect(inicio).toMatch(/<a href="\/"[^>]*aria-current="page"[^>]*data-rotulo="Início"/);
  });

  it("a tela de bolso mostra a mesma lista, com o cartão compacto", async () => {
    const corpo = (await (await entrar(novoCliente(), "titular_mariana")).get("/celular")).text;
    expect(corpo).toContain('class="ident-lateral ident-compacto"');
    expect(corpo).toContain('href="/minha-atividade"');
    expect(corpo).toContain('href="/certificados/meus/comprovante"');
    expect(corpo).not.toContain("ident-linha");
  });
});

describe("painel do titular", () => {
  it("as contagens dos cartões batem com o que foi montado", async () => {
    const dados = await inicio_do_servidor(db, await usuarioAtual(db, "titular_mariana"), HOJE);
    expect(dados.cartoes.emitidos).toBe(3);
    // válidos = em vigor e não vencidos (o a vencer ainda vale)
    expect(dados.cartoes.validos).toBe(2);
    expect(dados.cartoes.a_vencer).toBe(1);
    expect(dados.cartoes.proximo?.nome).toBe("NR-10");
    expect(dados.cartoes.turmas_abertas).toBe(1);
    expect(dados.cartoes.inscrito_em).toBe(1);
    expect(dados.cartoes.epi_abertos).toBe(1);
    expect(dados.cartoes.trocas_vencidas).toBe(0);
    expect(dados.total_certificados).toBe(3);
    expect(dados.ultimos_certificados).toHaveLength(2);
    expect(dados.primeiro_nome).toBe("Mariana");
  });

  it("a tela mostra saudação, cartões, últimos certificados e avisos por severidade", async () => {
    const corpo = (await (await entrar(novoCliente(), "titular_mariana")).get("/")).text;
    expect(corpo).toContain("Olá, Mariana!");
    expect(corpo).toContain("Certificados válidos");
    expect(corpo).toContain("A vencer (60 dias)");
    expect(corpo).toContain("Inscrições abertas para você");
    expect(corpo).toContain("você está inscrito em 1");
    expect(corpo).toContain("Últimos certificados");
    expect(corpo).toContain("Todos os certificados (3)");
    const avisos = corpo.slice(corpo.indexOf('<div class="avisos-titular" role="status">'));
    expect(avisos).toMatch(/aviso-titular--erro[\s\S]*?NR-35 vencido em/);
    expect(avisos).toMatch(/aviso-titular--alerta[\s\S]*?NR-10 vence em \d+ dias/);
    expect(avisos).toMatch(/aviso-titular--info[\s\S]*?Sua turma começa em/);
    expect(avisos).toContain('href="/turmas/minhas">Ver turmas de reciclagem</a>');
  });

  it("os chips não levam SIAPE nem CPF, e o último acesso é o ANTERIOR", async () => {
    await entrar(novoCliente(), "titular_mariana");
    const corpo = (await (await entrar(novoCliente(), "titular_mariana")).get("/")).text;
    const chips = corpo.slice(corpo.indexOf('<ul class="chips"'), corpo.indexOf("</ul>", corpo.indexOf('<ul class="chips"')));
    expect(chips).toContain("ICTP · Instituto do Portal");
    expect(chips).toContain("Técnica de Laboratório do Portal");
    expect(chips).toContain("Campus Portal · Diamantina");
    expect(chips).toMatch(/Último acesso \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
    expect(corpo).not.toContain(ana.siape);
    expect(corpo).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
  });

  it("nenhum aviso quando não há nada", async () => {
    const corpo = (await (await entrar(novoCliente(), "titular_beatriz")).get("/")).text;
    expect(corpo).toContain("Olá, Beatriz!");
    expect(corpo).not.toContain("avisos-titular");
    expect(corpo).not.toContain("aviso-titular--");
    expect(corpo).not.toContain("Últimos certificados");
  });

  it("os atalhos seguem as permissões do menu", async () => {
    const cheio = await inicio_do_servidor(db, await usuarioAtual(db, "titular_mariana"), HOJE);
    expect(cheio.atalhos.map((a) => a.caminho)).toEqual([
      "/turmas/minhas",
      "/certificados/meus",
      "/epis/fichas/minha",
      "/epis/requisicoes/nova",
      "/minha-atividade",
      "/minha-conta",
    ]);
    const sem_pedido = await inicio_do_servidor(db, titular_sem_processo(["treinamento.ver", "epi.ver"]), HOJE);
    expect(sem_pedido.atalhos.map((a) => a.caminho)).not.toContain("/epis/requisicoes/nova");
    const so_epi = await inicio_do_servidor(db, titular_sem_processo(["epi.ver"]), HOJE);
    const caminhos = so_epi.atalhos.map((a) => a.caminho);
    expect(caminhos).not.toContain("/turmas/minhas");
    expect(caminhos).not.toContain("/certificados/meus");
    expect(caminhos).toContain("/epis/fichas/minha");
    // e a tela também não oferece os cartões de treinamento sem a permissão
    expect(so_epi.ve_treinamento).toBe(false);
  });

  it("sem `style=` nem `<style>`/`<script>` embutido", async () => {
    for (const url of ["/", "/celular"]) {
      const corpo = (await (await entrar(novoCliente(), "titular_mariana")).get(url)).text;
      expect(corpo, url).not.toMatch(/<style[\s>]/);
      expect(corpo, url).not.toMatch(/\sstyle="/);
      for (const s of corpo.match(/<script[^>]*>/g) ?? []) expect(s, url).toMatch(/\ssrc="|\snonce="/);
    }
  });
});

