/**
 * Portal do servidor (22/10/2026): "Meus certificados" em cartões, a ficha
 * leve do titular, o comprovante de treinamentos e o acesso sem conta.
 *
 * Banco limpo por teste. O titular é a conta `servidor_consulta` (só
 * `treinamento.ver`), ligada ao servidor do `_cenario` (Marco).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-portal-cert-"));

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { somar_dias } from "../src/dominio/datas.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import * as acesso from "../src/servicos/acesso_participante.js";
import * as titular from "../src/servicos/certificados_titular.js";
import * as datas_br from "../src/servicos/datas_br.js";
import * as servico from "../src/servicos/emissao_certificado.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as servico_presenca from "../src/servicos/presenca.js";
import type { UsuarioAtual } from "../src/servicos/rbac.js";
import * as servico_turma from "../src/servicos/turma.js";
import * as validacao from "../src/servicos/validacao_certificado.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda.js";
import { INICIO, _cenario, _modelo_com_tags, _usuario, type Cenario } from "./ajuda_certificado.js";

definirArmazenamento(null);

let db: Banco;
let cliente: Cliente;
let novoCliente: () => Cliente;

await bancoLimpo();
beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  novoCliente = amb.novoCliente;
  validacao.limpar_limites();
  acesso.limpar_limites();
});
afterEach(() => {
  delete process.env.CSSO_SMTP_URL;
  delete process.env.CSSO_EMAIL_REMETENTE;
});

const HOJE = datas_br.hoje();

/** Liga a conta `servidor_consulta` ao servidor e entra com ela. */
async function _entrar_como(servidor_id: number | null, c: Cliente = cliente): Promise<Cliente> {
  await contas(db);
  await db.update(e.usuario).set({ servidor_id }).where(eq(e.usuario.login, "servidor_consulta"));
  return entrar(c, "servidor_consulta");
}

/** Um treinamento a mais, com modelo, sem conteúdo programático. */
async function _treinamento(d: { codigo: string; nome: string; norma?: string; conteudo?: string | null; validade?: number }) {
  const [t] = await db
    .insert(e.treinamento)
    .values({
      codigo: d.codigo,
      nome: d.nome,
      carga_horaria_horas: "4",
      conteudo_programatico: d.conteudo ?? null,
      validade_meses: d.validade ?? 12,
      norma_referencia: d.norma ?? null,
    })
    .returning();
  const modelo = await _modelo_com_tags(db, t!);
  await db.update(e.treinamento).set({ modelo_vigente_id: modelo.id }).where(eq(e.treinamento.id, t!.id));
  const [fresco] = await db.select().from(e.treinamento).where(eq(e.treinamento.id, t!.id));
  return fresco!;
}

/** Turma concluída do treinamento com o servidor aprovado; emite se `emitir`. */
async function _turma_concluida(
  usuario: UsuarioAtual,
  cen: Cenario,
  treinamento: typeof e.treinamento.$inferSelect,
  d: { emitir?: boolean; inicio?: string } = {},
) {
  const inicio = d.inicio ?? INICIO;
  const turma = await servico_turma.criar_turma(db, usuario, {
    treinamento,
    data_inicio: inicio,
    data_fim: inicio,
    local: "Auditório",
    nota_minima_aprovacao: null,
  });
  await servico_turma.vincular_instrutor(db, usuario, turma, { ...cen.instrutor, servidor: null } as never);
  const pessoa = await servico_participante.de_servidor(db, cen.servidor, usuario);
  const inscricao = await servico_turma.inscrever(db, usuario, turma, pessoa);
  await servico_turma.mudar_situacao(db, usuario, turma, "EM_ANDAMENTO");
  await servico_presenca.lancar_presenca(db, usuario, inscricao, { data: inicio, presente: true, horas: treinamento.carga_horaria_horas });
  await servico_turma.mudar_situacao(db, usuario, turma, "CONCLUIDA");
  const fresca = (await servico_turma.carregar_turma(db, turma.id))!;
  const relida = (await servico_turma.carregar_inscricao(db, inscricao.id, fresca))!;
  if (d.emitir === false) return { turma: fresca, inscricao: relida, certificado: null };
  const r = await servico.emitir(db, usuario, relida);
  return { turma: fresca, inscricao: relida, certificado: r.certificado };
}

async function _vencer(id: number, data: string) {
  await db.update(e.certificado).set({ data_vencimento: data }).where(eq(e.certificado.id, id));
}

/** O `<article>` do cartão do certificado `id`. */
function _cartao(html: string, id: number): string {
  const i = html.indexOf(`aria-labelledby="titulo-cert-${id}"`);
  if (i < 0) return "";
  const fim = html.indexOf("</article>", i);
  return html.slice(i, fim);
}

const SEM_INLINE = (html: string) => {
  expect(html).not.toMatch(/\sstyle=/);
  expect(html).not.toMatch(/<style[\s>]/);
  // a casca tem um <script nonce> (CSP); fora dele, nenhum script embutido
  expect(html).not.toMatch(/<script(?![^>]*\b(?:src|nonce)=)[^>]*>/);
};

const CPF = /\d{3}\.\d{3}\.\d{3}-\d{2}/;

describe("Meus certificados em cartões", () => {
  it("o cartão traz selo, título, setor, carga, período, 'Emitido em' e as ações com o nome do curso", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const { certificado } = await servico.emitir(db, usuario, cen.inscricao);
    await _entrar_como(cen.servidor.id);
    const tela = (await cliente.get("/certificados/meus")).text;
    expect(tela).toContain("1 certificado emitido");
    expect(tela).toContain("8 h de capacitação");
    expect(tela).toContain('<ul class="grade-cert" role="list">');
    const cartao = _cartao(tela, certificado.id);
    expect(cartao).toContain("Válido");
    expect(cartao).toContain("NR-35");
    expect(cartao).toContain(`id="titulo-cert-${certificado.id}"`);
    expect(cartao).toContain("Trabalho em Altura — NR-35");
    expect(cartao).toContain("8 h");
    expect(cartao).toContain(`Emitido em <time datetime="${certificado.data_emissao}">`);
    expect(cartao).toContain(`<time datetime="${INICIO}">${datas_br.numerica(INICIO)}</time>`);
    expect(cartao).toContain("Válido até");
    expect(cartao).toContain('aria-label="Baixar certificado de Trabalho em Altura — NR-35"');
    expect(cartao).toContain(`href="/certificados/${certificado.id}/pdf"`);
    // validar: a chave em mono, o link para copiar e o QR
    expect(cartao).toContain(`<span class="mono cert-chave">${certificado.chave_validacao}</span>`);
    expect(cartao).toContain(`data-copiar="validacao-${certificado.id}"`);
    expect(cartao).toContain(`/validar/${certificado.chave_validacao}`);
    expect(cartao).toContain('src="data:image/png;base64,');
    expect(cartao).toContain(`Nº <span class="mono">${certificado.numero_impresso ?? `${certificado.numero}/${certificado.ano}`}</span>`);
    // válido: sem reciclagem
    expect(cartao).not.toContain("Inscrever-se na reciclagem");
    expect(cartao).not.toMatch(CPF);
    SEM_INLINE(tela);
  });

  it("filtro por situação: 'vencidos' só com os vencidos, contagens nas pílulas e lista fechada", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const { certificado: nr35 } = await servico.emitir(db, usuario, cen.inscricao);
    const t2 = await _treinamento({ codigo: "BRIG", nome: "Brigada de Incêndio", norma: "NR-23" });
    const { certificado: brigada } = await _turma_concluida(usuario, cen, t2);
    await _vencer(nr35.id, somar_dias(HOJE, -10));
    await _entrar_como(cen.servidor.id);

    const todos = (await cliente.get("/certificados/meus")).text;
    expect(todos).toMatch(/Todos\s*<span class="contagem">2<\/span>/);
    expect(todos).toMatch(/Válidos\s*<span class="contagem">1<\/span>/);
    expect(todos).toMatch(/A vencer\s*<span class="contagem">0<\/span>/);
    expect(todos).toMatch(/Vencidos\s*<span class="contagem">1<\/span>/);
    expect(todos).toContain('href="/certificados/meus" aria-current="true"');

    const vencidos = (await cliente.get("/certificados/meus?situacao=vencidos")).text;
    expect(vencidos).toContain('href="/certificados/meus?situacao=vencidos" aria-current="true"');
    expect(_cartao(vencidos, nr35!.id)).toContain("Vencido");
    expect(_cartao(vencidos, nr35!.id)).toContain("Venceu em");
    expect(vencidos).not.toContain(`titulo-cert-${brigada!.id}"`);

    // valor fora da lista: vale "todos"
    const estranho = (await cliente.get("/certificados/meus?situacao=%3Cscript%3E&ano=abc")).text;
    expect(estranho).toContain(`titulo-cert-${brigada!.id}"`);
    expect(estranho).toContain(`titulo-cert-${nr35!.id}"`);
    // com 2 certificados não há seletor de ano nem busca
    expect(estranho).not.toContain('name="ano"');
    expect(estranho).not.toContain('id="cert-q"');

    // filtro sem resultado
    const a_vencer = (await cliente.get("/certificados/meus?situacao=a_vencer")).text;
    expect(a_vencer).toContain("Nenhum certificado vence nos próximos 60 dias.");
    expect(a_vencer).toContain('<a href="/certificados/meus">Ver todos</a>');
  });

  it("conteúdo programático só no cartão do treinamento que tem conteúdo", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const { certificado: nr35 } = await servico.emitir(db, usuario, cen.inscricao);
    const t2 = await _treinamento({ codigo: "ERGO", nome: "Ergonomia no Laboratório", conteudo: null });
    const { certificado: ergo } = await _turma_concluida(usuario, cen, t2);
    await _entrar_como(cen.servidor.id);
    const tela = (await cliente.get("/certificados/meus")).text;
    const com = _cartao(tela, nr35.id);
    expect(com).toContain("Conteúdo programático");
    expect(com).toContain("<li>Análise de risco e condições impeditivas</li>");
    expect(_cartao(tela, ergo!.id)).not.toContain("Conteúdo programático");
  });

  it("reciclagem só em a vencer ou vencido não superado; sem turma aberta, o aviso", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const { certificado: nr35 } = await servico.emitir(db, usuario, cen.inscricao);
    const t2 = await _treinamento({ codigo: "PSOC", nome: "Primeiros Socorros" });
    const { certificado: valido } = await _turma_concluida(usuario, cen, t2);
    await _vencer(nr35.id, somar_dias(HOJE, 20));
    await _entrar_como(cen.servidor.id);

    let tela = (await cliente.get("/certificados/meus")).text;
    let cartao = _cartao(tela, nr35.id);
    expect(cartao).toContain("Vence em 20 dias");
    expect(cartao).toContain("Sem turma aberta de reciclagem. Avisaremos por e-mail.");
    expect(cartao).not.toContain("Inscrever-se na reciclagem");
    expect(_cartao(tela, valido!.id)).not.toContain("reciclagem");

    // abre uma turma do treinamento, recebendo pedido: o botão aparece
    const inicio = somar_dias(HOJE, 15);
    const aberta = await servico_turma.criar_turma(db, usuario, {
      treinamento: cen.treinamento,
      data_inicio: inicio,
      data_fim: inicio,
      local: "Auditório",
      nota_minima_aprovacao: null,
    });
    await db.update(e.turma).set({ situacao: "INSCRICOES_ABERTAS" }).where(eq(e.turma.id, aberta.id));
    tela = (await cliente.get("/certificados/meus")).text;
    cartao = _cartao(tela, nr35.id);
    expect(cartao).toContain(`href="/turmas/minhas?treinamento=${cen.treinamento.id}#abertas"`);
    expect(cartao).toContain('aria-label="Inscrever-se na reciclagem de Trabalho em Altura — NR-35"');
    expect(cartao).not.toContain("Sem turma aberta");
  });

  it("o superado pela reciclagem: selo próprio, sem destaque de vencido, sem reciclagem e fora da contagem de vencidos", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const { certificado: antigo } = await servico.emitir(db, usuario, cen.inscricao);
    const { certificado: novo } = await _turma_concluida(usuario, cen, cen.treinamento, { inicio: somar_dias(HOJE, -1) });
    await _vencer(antigo.id, somar_dias(HOJE, -5));
    await _entrar_como(cen.servidor.id);
    const tela = (await cliente.get("/certificados/meus")).text;
    const cartao = _cartao(tela, antigo.id);
    expect(cartao).toContain("Substituído pela reciclagem");
    expect(cartao).not.toContain(">Vencido<");
    expect(cartao).not.toContain("reciclagem</a>");
    expect(cartao).not.toContain("Sem turma aberta");
    expect(tela).not.toMatch(new RegExp(`class="cert cert--vencido[^"]*"\\s*aria-labelledby="titulo-cert-${antigo.id}"`));
    expect(cartao).toContain("Em vigor: Nº");
    expect(tela).toMatch(/Vencidos\s*<span class="contagem">0<\/span>/);
    expect(_cartao(tela, novo!.id)).toContain("Válido");

    const dados = await titular.do_titular(db, cen.servidor.id, HOJE);
    expect(dados.resumo.vencidos).toBe(0);
    expect(dados.resumo.substituidos).toBe(1);
  });

  it("inscrição aprovada sem certificado vira o cartão 'Em emissão', sem botões", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    await _entrar_como(cen.servidor.id);
    const tela = (await cliente.get("/certificados/meus")).text;
    const i = tela.indexOf("titulo-emissao-");
    expect(i).toBeGreaterThan(-1);
    const cartao = tela.slice(i, tela.indexOf("</article>", i));
    expect(cartao).toContain("Em emissão");
    expect(cartao).toContain("está emitindo o seu certificado");
    expect(cartao).not.toContain("Baixar");
    expect(tela).toContain("0 certificados emitidos");
  });

  it("estados vazios: nenhum certificado e conta sem servidor", async () => {
    const [outro] = await db.insert(e.servidor).values({ siape: "3330001", nome: "Sem Curso Nenhum" }).returning();
    await _entrar_como(outro!.id);
    const vazio = (await cliente.get("/certificados/meus")).text;
    expect(vazio).toContain("Você ainda não tem certificados emitidos.");
    expect(vazio).toContain('href="/turmas/minhas#abertas"');
    expect(vazio).not.toContain("filtro-pilulas");
    SEM_INLINE(vazio);

    const sem = novoCliente();
    await _entrar_como(null, sem);
    const tela = (await sem.get("/certificados/meus")).text;
    expect(tela).toContain("Sua conta não está ligada a um cadastro de servidor.");
    expect(tela).toContain("Nada a listar enquanto a conta não tiver cadastro de servidor.");
  });

  it("titular A não vê o certificado de B, nem pela lista nem pela ficha", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario, { extras: [["2220001", "Ana Lima", "8"]] });
    await servico.emitir_lote(db, usuario, cen.turma);
    const todos = await db.select().from(e.certificado);
    const da_ana = todos.find((c) => c.servidor_id !== cen.servidor.id)!;
    const do_marco = todos.find((c) => c.servidor_id === cen.servidor.id)!;
    await _entrar_como(cen.servidor.id);
    const tela = (await cliente.get("/certificados/meus")).text;
    expect(tela).toContain(`titulo-cert-${do_marco.id}"`);
    expect(tela).not.toContain(`titulo-cert-${da_ana.id}"`);
    expect(tela).not.toContain(da_ana.chave_validacao);
    const ficha = await cliente.get(`/certificados/${da_ana.id}`);
    expect(ficha.url).toBe("/certificados/meus");
    expect(ficha.text).not.toContain(da_ana.chave_validacao);
    expect(ficha.text).not.toContain("Ana Lima");
  });

  it("agrupa por ano, mostra o seletor de ano com mais de 6 e a busca com 12 ou mais (unidade)", () => {
    const base = (id: number, ano: number, nome = `Curso ${id}`): titular.CartaoCertificado =>
      ({
        id,
        ano,
        treinamento: nome,
        norma: "",
        setor: { nome: "", sigla: "", cor: null, icone: null },
        rotulo: String(id),
        turma_codigo: "",
        anulado: false,
        superado_por: null,
        situacao: { tipo: "valido", dias: 300 },
      }) as unknown as titular.CartaoCertificado;
    const seis = { cartoes: [1, 2, 3, 4, 5, 6].map((i) => base(i, 2026)), em_emissao: [] };
    const l6 = titular.filtrar(seis, { ano: "2026", q: "curso 1" });
    expect(l6.com_ano).toBe(false);
    expect(l6.com_busca).toBe(false);
    expect(l6.agrupar).toBe(false);
    expect(l6.filtros.ano).toBeNull();
    expect(l6.total).toBe(6);

    const sete = { cartoes: [...seis.cartoes, base(7, 2025)], em_emissao: [] };
    const l7 = titular.filtrar(sete, {});
    expect(l7.com_ano).toBe(true);
    expect(l7.agrupar).toBe(true);
    expect(l7.grupos.map((g) => [g.ano, g.cartoes.length])).toEqual([
      [2026, 6],
      [2025, 1],
    ]);
    expect(titular.filtrar(sete, { ano: "2025" }).total).toBe(1);
    // ano que não existe nos certificados: ignorado
    expect(titular.filtrar(sete, { ano: "1999" }).filtros.ano).toBeNull();

    const doze = { cartoes: Array.from({ length: 12 }, (_, i) => base(i + 1, 2026, i === 4 ? "Trabalho em Altura" : `Outro ${i}`)), em_emissao: [] };
    const l12 = titular.filtrar(doze, { q: "altura" });
    expect(l12.com_busca).toBe(true);
    expect(l12.total).toBe(1);
  });
});

describe("ficha do certificado", () => {
  it("o titular vê a ficha leve: sem hashes, dicionário nem trilha; a equipe vê a técnica", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const { certificado } = await servico.emitir(db, usuario, cen.inscricao);
    await _entrar_como(cen.servidor.id);
    const leve = (await cliente.get(`/certificados/${certificado.id}`)).text;
    expect(leve).not.toContain("SHA-256");
    expect(leve).not.toContain("<summary>Trilha");
    expect(leve).not.toContain("dicionário de tags");
    expect(leve).toContain("Trabalho em Altura — NR-35");
    expect(leve).toContain("Conteúdo programático");
    expect(leve).toContain('src="data:image/png;base64,');
    expect(leve).toContain(`href="/certificados/${certificado.id}/pdf"`);
    expect(leve).toContain(`href="/certificados/${certificado.id}/documento"`);
    expect(leve).toContain(certificado.chave_validacao);
    expect(leve).not.toMatch(CPF);
    SEM_INLINE(leve);

    const equipe = novoCliente();
    await entrar(equipe, "coordenador_csso");
    const tecnica = (await equipe.get(`/certificados/${certificado.id}`)).text;
    expect(tecnica).toContain("SHA-256");
    expect(tecnica).toContain("<summary>Trilha");
  });
});

describe("comprovante de treinamentos", () => {
  it("lista os em vigor com o link de validação e o aviso; sem CPF nem SIAPE", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const { certificado } = await servico.emitir(db, usuario, cen.inscricao);
    const t2 = await _treinamento({ codigo: "BRIG", nome: "Brigada de Incêndio", norma: "NR-23" });
    const { certificado: vencido } = await _turma_concluida(usuario, cen, t2);
    await _vencer(vencido!.id, somar_dias(HOJE, -3));
    await _entrar_como(cen.servidor.id);
    const meus = (await cliente.get("/certificados/meus")).text;
    expect(meus).toContain('href="/certificados/meus/comprovante"');
    const r = await cliente.get("/certificados/meus/comprovante");
    expect(r.status).toBe(200);
    const tela = r.text;
    expect(tela).toContain("Marco Antônio Alves Schetino");
    expect(tela).toContain("Treinamentos em vigor");
    expect(tela).toContain("Emitido em");
    expect(tela).toContain("Documento de conferência. Vale a validação de cada QR na data da consulta.");
    const congelado = certificado.contexto_congelado as Record<string, string>;
    expect(tela).toContain(congelado.url_validacao!);
    expect(tela).toContain(`/validar/${certificado.chave_validacao}`);
    expect(tela).toContain('src="data:image/png;base64,');
    // o vencido não comprova nada
    expect(tela).not.toContain("Brigada de Incêndio");
    expect(tela).not.toContain(cen.servidor.siape);
    expect(tela).not.toMatch(CPF);
    SEM_INLINE(tela);
  });

  it("pede treinamento.ver e conta de servidor", async () => {
    await contas(db);
    const sem_servidor = await _entrar_como(null);
    const r = await sem_servidor.get("/certificados/meus/comprovante");
    expect(r.url).toBe("/certificados/meus");
    const anonimo = await novoCliente().get("/certificados/meus/comprovante");
    expect(anonimo.url).toMatch(/^\/login/);
  });
});

describe("acesso sem conta", () => {
  it("os mesmos cartões, sem filtros, sem 'Inscrever-se' e sem CPF", async () => {
    const usuario = await _usuario(db);
    const cen = await _cenario(db, usuario);
    const { certificado } = await servico.emitir(db, usuario, cen.inscricao);
    await _vencer(certificado.id, somar_dias(HOJE, 10));
    process.env.CSSO_SMTP_URL = "smtp://teste:teste@localhost:2525";
    process.env.CSSO_EMAIL_REMETENTE = "SISA <sisa@teste.br>";
    const marco = (await servico_participante.carregar(db, cen.inscricao.participante_id))!;
    await servico_participante.registrar_email(db, marco, "marco@exemplo.com", { confirmado_em: new Date() });
    await novoCliente().post(acesso.CAMINHO, { email: "marco@exemplo.com" });
    const [linha] = (await db.select().from(e.email_saida)).filter((x) => x.tipo === acesso.TIPO_EMAIL);
    const token = linha!.corpo!.match(/\/certificados\/acesso\/([A-Za-z0-9_-]{20,})/)![1]!;

    const aberto = (await acesso.abrir(db, token))!;
    const [item] = acesso.itens(aberto.certificados);
    expect(item!.carga_horaria).toBe("8");
    expect(item!.chave_validacao).toBe(certificado.chave_validacao);
    expect(item!.conteudo.length).toBe(3);
    expect(JSON.stringify(item)).not.toMatch(/cpf/i);

    const tela = (await novoCliente().get(`${acesso.CAMINHO}/${token}`)).text;
    expect(tela).toContain('<ul class="grade-cert" role="list">');
    const cartao = _cartao(tela, certificado.id);
    expect(cartao).toContain("Vence em 10 dias");
    expect(cartao).toContain(`href="${acesso.CAMINHO}/${token}/${certificado.id}"`);
    expect(cartao).toContain("8 h");
    expect(cartao).toContain(certificado.chave_validacao);
    expect(cartao).not.toContain(`href="/certificados/${certificado.id}"`);
    expect(tela).not.toContain("Inscrever-se");
    expect(tela).not.toContain("Sem turma aberta");
    expect(tela).not.toContain("filtro-pilulas");
    expect(tela).not.toMatch(CPF);
    SEM_INLINE(tela);
  });
});
