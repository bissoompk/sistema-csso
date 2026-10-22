/**
 * O envio de e-mail (NUVEM): a caixa de saída, o certificado anexado e as
 * telas. O SMTP é trocado por um transporte que guarda a mensagem.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import * as email from "../src/servicos/email.js";
import * as acesso from "../src/servicos/acesso_participante.js";
import * as servico from "../src/servicos/emissao_certificado.js";
import * as reciclagem from "../src/servicos/reciclagem.js";
import * as datas_br from "../src/servicos/datas_br.js";
import * as servico_participante from "../src/servicos/participante.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda.js";
import { TODAS, _cenario, _usuario } from "./ajuda_certificado.js";

definirArmazenamento(null);

let db: Banco;
let cliente: Cliente;
let novoCliente: () => Cliente;
let enviadas: email.Mensagem[];

await bancoLimpo();
beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
  novoCliente = amb.novoCliente;
  enviadas = [];
});
afterEach(() => email.definir_transporte(null));

function _guardar() {
  email.definir_transporte(async (m) => {
    enviadas.push(m);
  });
}

/** Turma concluída com dois aprovados emitidos; só Marco tem e-mail. */
async function cenario() {
  await contas(db);
  const montador = await _usuario(db, TODAS, "montador");
  const d = await _cenario(db, montador, { extras: [["2220001", "Ana Lima", "8"]] });
  await servico.emitir_lote(db, montador, d.turma);
  const marco = (await servico_participante.carregar(db, d.inscricao.participante_id))!;
  await servico_participante.registrar_email(db, marco, "marco@ufvjm.edu.br");
  const certificados = await db.select().from(e.certificado).orderBy(asc(e.certificado.id));
  const do_marco = certificados.find((c) => c.participante_id === marco.id)!;
  return { turma_id: d.turma.id, do_marco, montador };
}

/** Pede o envio pela ficha, como o coordenador (a conta que o envio relê). */
async function pedir(certificado_id: number) {
  await entrar(cliente, "coordenador_csso");
  const r = await cliente.post(`/certificados/${certificado_id}/email`, {}, { seguir: false });
  expect(r.status).toBe(303);
}

async function _caixa() {
  return db.select().from(e.email_saida).orderBy(asc(e.email_saida.id));
}

describe("pedido de envio", () => {
  it("a turma enfileira quem tem e-mail, diz quem ficou de fora e não manda duas vezes", async () => {
    const h = await cenario();
    await entrar(cliente, "coordenador_csso");
    const r = await cliente.post(`/turmas/${h.turma_id}/certificados/email`, {});
    expect(r.text).toContain("1 certificado(s) na fila de envio; 1 sem e-mail cadastrado.");
    expect(r.text).toContain("ainda não está ligado");
    const [linha] = await _caixa();
    expect(linha!.situacao).toBe("PENDENTE");
    expect(linha!.destinatario).toBe("marco@ufvjm.edu.br");
    expect(linha!.certificado_id).toBe(h.do_marco.id);
    expect(linha!.corpo).toContain("Olá, Marco Antônio Alves Schetino.");
    expect(linha!.corpo).toContain("/validar/");
    const de_novo = await cliente.post(`/turmas/${h.turma_id}/certificados/email`, {});
    expect(de_novo.text).toContain("1 já enviado(s) antes");
    expect(await _caixa()).toHaveLength(1);
    // a aba e a ficha mostram a fila
    expect((await cliente.get(`/turmas/${h.turma_id}?aba=emissao`)).text).toContain("e-mail: na fila");
    const ficha = (await cliente.get(`/certificados/${h.do_marco.id}`)).text;
    expect(ficha).toContain("Envio por e-mail");
    expect(ficha).toContain("Enviar de novo");
    // a ficha reenvia
    await cliente.post(`/certificados/${h.do_marco.id}/email`, {});
    expect(await _caixa()).toHaveLength(2);
  });

  it("quem só vê certificado não envia nem abre a caixa", async () => {
    const h = await cenario();
    await entrar(cliente, "auditor_interno");
    expect((await cliente.post(`/certificados/${h.do_marco.id}/email`, {})).status).toBe(403);
    expect((await cliente.get("/certificados/emails")).status).toBe(403);
    expect((await cliente.post(`/turmas/${h.turma_id}/certificados/email`, {})).status).toBe(403);
    expect(await _caixa()).toHaveLength(0);
  });
});

describe("envio", () => {
  it("sai com o PDF anexado e a trilha diz quem mandou", async () => {
    const h = await cenario();
    await pedir(h.do_marco.id);
    expect((await email.processar_fila(db)).desligado).toBe(true);
    _guardar();
    const r = await email.processar_fila(db);
    expect(r).toEqual({ enviados: 1, falhas: 0, desligado: false });
    expect(enviadas).toHaveLength(1);
    const [m] = enviadas;
    expect(m!.para).toBe("marco@ufvjm.edu.br");
    expect(m!.anexos).toHaveLength(1);
    expect(m!.anexos[0]!.tipo).toBe("application/pdf");
    expect(new TextDecoder().decode(m!.anexos[0]!.bytes.slice(0, 5))).toBe("%PDF-");
    const [linha] = await _caixa();
    expect(linha!.situacao).toBe("ENVIADO");
    expect(linha!.enviado_em).not.toBeNull();
    const trilha = await db.select().from(e.historico_evento).where(eq(e.historico_evento.entidade_id, h.do_marco.id));
    expect(trilha.map((t) => t.tipo_evento)).toContain("CERTIFICADO_ENVIO_PEDIDO");
    expect(trilha.map((t) => t.tipo_evento)).toContain(servico.CERTIFICADO_SEGUNDA_VIA);
    // fila vazia: nada mais sai
    expect((await email.processar_fila(db)).enviados).toBe(0);
  });

  it("a falha volta à fila com espera; depois de 5 tentativas, falhou — e volta pela tela", async () => {
    const h = await cenario();
    await pedir(h.do_marco.id);
    email.definir_transporte(async () => {
      throw new Error("conexão recusada pelo SMTP");
    });
    let agora = Date.now();
    for (let n = 1; n <= email.MAXIMO_TENTATIVAS; n++) {
      const r = await email.processar_fila(db, { agora: () => new Date(agora) });
      expect(r.falhas).toBe(1);
      const [linha] = await _caixa();
      expect(linha!.tentativas).toBe(n);
      expect(linha!.ultimo_erro).toContain("conexão recusada");
      expect(linha!.situacao).toBe(n < email.MAXIMO_TENTATIVAS ? "PENDENTE" : "FALHOU");
      // antes da espera, não tenta de novo
      expect((await email.processar_fila(db, { agora: () => new Date(agora) })).falhas).toBe(0);
      agora += 2 * 3_600_000;
    }
    await entrar(cliente, "coordenador_csso");
    const caixa = (await cliente.get("/certificados/emails?situacao=FALHOU")).text;
    expect(caixa).toContain("marco@ufvjm.edu.br");
    expect(caixa).toContain("Tentar de novo");
    const [linha] = await _caixa();
    await cliente.post(`/certificados/emails/${linha!.id}/tentar`, {});
    _guardar();
    const r = await cliente.post("/certificados/emails/processar", {});
    expect(r.text).toContain("1 enviado(s), 0 falha(s)");
    expect((await _caixa())[0]!.situacao).toBe("ENVIADO");
  });

  it("certificado anulado depois do pedido não sai", async () => {
    const h = await cenario();
    await pedir(h.do_marco.id);
    await db.transaction((tx) => servico.anular(tx, h.montador, h.do_marco, "emitido com erro de digitação"));
    _guardar();
    expect((await email.processar_fila(db)).falhas).toBe(1);
    expect(enviadas).toHaveLength(0);
    expect((await _caixa())[0]!.ultimo_erro).toContain("anulado");
  });

  it("cancelar tira da fila; o texto sai depois de 90 dias e a linha fica", async () => {
    const h = await cenario();
    await pedir(h.do_marco.id);
    const [linha] = await _caixa();
    await entrar(cliente, "coordenador_csso");
    await cliente.post(`/certificados/emails/${linha!.id}/cancelar`, {});
    expect((await _caixa())[0]!.situacao).toBe("CANCELADO");
    expect(await email.expurgar_corpos(db)).toBe(0);
    expect(await email.expurgar_corpos(db, new Date(Date.now() + 91 * 86_400_000))).toBe(1);
    const [depois] = await _caixa();
    expect(depois!.corpo).toBeNull();
    expect(depois!.destinatario).toBe("marco@ufvjm.edu.br");
  });
});

describe("acesso do participante sem conta", () => {
  beforeEach(() => acesso.limpar_limites());

  function _ligar() {
    process.env.CSSO_SMTP_URL = "smtp://teste:teste@localhost:2525";
    process.env.CSSO_EMAIL_REMETENTE = "CSSO <csso@teste.br>";
  }
  afterEach(() => {
    delete process.env.CSSO_SMTP_URL;
    delete process.env.CSSO_EMAIL_REMETENTE;
  });

  /** Pede o link pela página pública e o tira do e-mail que entrou na caixa. */
  async function _link(publico: Cliente, endereco: string): Promise<string | null> {
    const r = await publico.post(acesso.CAMINHO, { email: endereco });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Se este e-mail estiver cadastrado");
    const [linha] = (await _caixa()).filter((x) => x.tipo === acesso.TIPO_EMAIL).slice(-1);
    const m = linha?.corpo?.match(/\/certificados\/acesso\/([A-Za-z0-9_-]{20,})/);
    return m ? m[1]! : null;
  }

  it("sem o envio ligado, a página diz que está indisponível e nada sai", async () => {
    await cenario();
    const publico = novoCliente();
    expect((await publico.get(acesso.CAMINHO)).text).toContain("indisponível");
    await publico.post(acesso.CAMINHO, { email: "marco@ufvjm.edu.br" });
    expect(await _caixa()).toHaveLength(0);
  });

  it("o link vai ao e-mail cadastrado, lista e baixa só os certificados dele", async () => {
    const h = await cenario();
    _ligar();
    const publico = novoCliente();
    const token = await _link(publico, "MARCO@ufvjm.edu.br");
    expect(token).not.toBeNull();
    const [aviso] = await _caixa();
    expect(aviso!.destinatario).toBe("marco@ufvjm.edu.br");
    const [registro] = await db.select().from(e.acesso_participante);
    expect(registro!.token_hash).not.toContain(token!);

    const lista = await publico.get(`${acesso.CAMINHO}/${token}`);
    expect(lista.status).toBe(200);
    expect(lista.text).toContain("Trabalho em Altura");
    expect(lista.text).toContain(`${acesso.CAMINHO}/${token}/${h.do_marco.id}`);
    expect(lista.cabecalho("referrer-policy")).toBe("no-referrer");
    const pdf = await publico.get(`${acesso.CAMINHO}/${token}/${h.do_marco.id}`);
    expect(pdf.status).toBe(200);
    expect(pdf.cabecalho("content-type")).toBe("application/pdf");
    // o da Ana não sai por este link
    const da_ana = (await db.select().from(e.certificado)).find((x) => x.id !== h.do_marco.id)!;
    expect((await publico.get(`${acesso.CAMINHO}/${token}/${da_ana.id}`)).status).toBe(404);
    // a trilha diz que a segunda via saiu pelo link, sem usuário
    const trilha = await db.select().from(e.historico_evento).where(eq(e.historico_evento.entidade_id, h.do_marco.id));
    const via = trilha.find((t) => t.descricao?.includes("pelo link de acesso do participante"))!;
    expect(via.usuario_id).toBeNull();
  });

  it("e-mail desconhecido recebe a mesma resposta, e nada sai", async () => {
    await cenario();
    _ligar();
    expect(await _link(novoCliente(), "ninguem@exemplo.com")).toBeNull();
    expect(await _caixa()).toHaveLength(0);
  });

  it("no máximo 3 links por hora para o mesmo endereço, e o limite por IP", async () => {
    await cenario();
    _ligar();
    const publico = novoCliente();
    for (let n = 0; n < 5; n++) await publico.post(acesso.CAMINHO, { email: "marco@ufvjm.edu.br" });
    expect(await _caixa()).toHaveLength(acesso.LINKS_POR_HORA);
    expect((await publico.post(acesso.CAMINHO, { email: "marco@ufvjm.edu.br" })).status).toBe(429);
  });

  it("o link vence em 2 horas; o registro sai em 7 dias", async () => {
    await cenario();
    _ligar();
    const token = (await _link(novoCliente(), "marco@ufvjm.edu.br"))!;
    expect(await acesso.abrir(db, token, new Date(Date.now() + 3 * 3_600_000))).toBeNull();
    expect((await novoCliente().get(`${acesso.CAMINHO}/nao-existe-este-token`)).status).toBe(404);
    expect(await acesso.expurgar(db)).toBe(0);
    expect(await acesso.expurgar(db, new Date(Date.now() + 8 * 86_400_000))).toBe(1);
  });

  it("certificado anulado sai da lista", async () => {
    const h = await cenario();
    _ligar();
    const token = (await _link(novoCliente(), "marco@ufvjm.edu.br"))!;
    await db.transaction((tx) => servico.anular(tx, h.montador, h.do_marco, "emitido com erro de digitação"));
    const lista = await novoCliente().get(`${acesso.CAMINHO}/${token}`);
    expect(lista.text).toContain("Nenhum certificado em vigor");
  });
});

describe("busca em /certificados", () => {
  it("acha por nome sem acento e fora de ordem, SIAPE, PTC, turma, número e chave; CPF não", async () => {
    const h = await cenario();
    await entrar(cliente, "coordenador_csso");
    const busca = async (termo: string) =>
      (await cliente.get(`/certificados?busca=${encodeURIComponent(termo)}`)).text;
    const rotulo = `${h.do_marco.numero}/${h.do_marco.ano}`;
    const so_marco = (html: string) => html.includes(`>${rotulo}<`) && !html.includes("Ana Lima");
    expect(so_marco(await busca("marco schetino"))).toBe(true);
    expect(so_marco(await busca("ANTONIO"))).toBe(true);
    expect(so_marco(await busca("1110654"))).toBe(true);
    expect(so_marco(await busca(rotulo))).toBe(true);
    expect(so_marco(await busca(h.do_marco.chave_validacao))).toBe(true);
    const [p] = await db.select().from(e.participante).where(eq(e.participante.id, h.do_marco.participante_id));
    expect(so_marco(await busca(p!.identificador_publico))).toBe(true);
    // a turma e o treinamento trazem os dois
    const turma = await busca((h.do_marco.contexto_congelado as Record<string, string>)["turma_codigo"]!);
    expect(turma).toContain("Ana Lima");
    expect(turma).toContain("Marco Antônio");
    expect(await busca("altura")).toContain("Ana Lima");
    expect(await busca("ninguem com este nome")).toContain("Nenhum certificado encontrado");
    expect(await busca("100%_")).toContain("Nenhum certificado encontrado");
    const cpf = await busca("529.982.247-25");
    expect(cpf).toContain("O sistema não busca por CPF");
  });
});

describe("envio pela fila de emissão", () => {
  it("os marcados entre turmas vão para a caixa; o já enviado vem desmarcado", async () => {
    const h = await cenario();
    await entrar(cliente, "coordenador_csso");
    const antes = (await cliente.get("/certificados/fila?etapa=EMITIDO")).text;
    expect(antes).toContain('action="/certificados/fila/email"');
    expect(antes).toContain(`name="certificado_id" value="${h.do_marco.id}"\n                 checked`);
    const todos = (await db.select().from(e.certificado)).map((x) => String(x.id));
    const r = await cliente.post("/certificados/fila/email", { certificado_id: todos });
    expect(r.text).toContain("1 certificado(s) na fila de envio; 1 sem e-mail cadastrado.");
    const [linha] = await _caixa();
    expect(linha!.certificado_id).toBe(h.do_marco.id);
    const depois = (await cliente.get("/certificados/fila?etapa=EMITIDO")).text;
    expect(depois).toContain("e-mail: na fila");
    expect(depois).not.toContain(`name="certificado_id" value="${h.do_marco.id}"\n                 checked`);
    // quem só vê certificado não envia
    await entrar(cliente, "auditor_interno");
    expect((await cliente.post("/certificados/fila/email", { certificado_id: todos })).status).toBe(403);
    expect(await _caixa()).toHaveLength(1);
  });
});

describe("aviso de reciclagem por e-mail", () => {
  const HOJE = datas_br.hoje();

  /** Marco a vencer em 10 dias, Ana vencida há 5 (só Marco tem e-mail). */
  async function na_janela() {
    const h = await cenario();
    await db.update(e.certificado).set({ data_vencimento: datas_br.somar_dias(HOJE, 10) }).where(eq(e.certificado.id, h.do_marco.id));
    const da_ana = (await db.select().from(e.certificado)).find((x) => x.id !== h.do_marco.id)!;
    await db.update(e.certificado).set({ data_vencimento: datas_br.somar_dias(HOJE, -5) }).where(eq(e.certificado.id, da_ana.id));
    return { ...h, da_ana };
  }

  it("os marcados no monitor recebem um aviso, uma vez só", async () => {
    const h = await na_janela();
    await entrar(cliente, "coordenador_csso");
    const tela = (await cliente.get("/certificados/vencimentos")).text;
    expect(tela).toContain("Avisar por e-mail os marcados");
    expect(tela).toMatch(new RegExp(`value="${h.do_marco.id}"\\s+checked`));
    expect(tela).not.toMatch(new RegExp(`value="${h.da_ana.id}"\\s+checked`));
    const r = await cliente.post("/certificados/vencimentos/avisar", { certificado_id: [String(h.do_marco.id), String(h.da_ana.id)] });
    expect(r.text).toContain("1 aviso(s) de reciclagem na fila de envio; 1 sem e-mail cadastrado.");
    const [aviso] = await _caixa();
    expect(aviso!.tipo).toBe("RECICLAGEM_AVISO");
    expect(aviso!.destinatario).toBe("marco@ufvjm.edu.br");
    expect(aviso!.corpo).toContain(`vence em ${datas_br.numerica(datas_br.somar_dias(HOJE, 10))}`);
    expect(aviso!.corpo).toContain("procure a CSSO");
    expect((await cliente.get("/certificados/vencimentos")).text).toContain(">avisado<");
    const de_novo = await cliente.post("/certificados/vencimentos/avisar", { certificado_id: String(h.do_marco.id) });
    expect(de_novo.text).toContain("1 já avisado(s) antes");
    expect(await _caixa()).toHaveLength(1);
  });

  it("o automático vem desligado; ligado, a varredura avisa quem entra na janela, uma vez", async () => {
    await na_janela();
    await entrar(cliente, "coordenador_csso");
    // o interruptor mora na configuração recolhida da tela, e o estado no cabeçalho
    const antes = (await cliente.get("/certificados/vencimentos")).text;
    expect(antes).toContain("Avisar sozinho quem entra na janela de reciclagem");
    expect(antes).toContain("aviso automático desligado");
    await cliente.post("/certificados/vencimentos/automatico", { ligado: "sim" });
    expect((await cliente.get("/certificados/vencimentos")).text).toContain("aviso automático ligado");
    const r = await reciclagem.varrer(db, HOJE);
    // a vencida há 5 dias não entra na janela (e nem tem e-mail): só Marco
    expect(r).toEqual({ abertas: 1, fechadas: 0, avisados: 1 });
    const [aviso] = await _caixa();
    expect(aviso!.criado_por).toBeNull();
    expect((await reciclagem.varrer(db, HOJE)).avisados).toBe(0);
    expect(await _caixa()).toHaveLength(1);
  });

  it("desligado, a varredura só abre a tarefa do setor", async () => {
    await na_janela();
    expect(await reciclagem.varrer(db, HOJE)).toEqual({ abertas: 1, fechadas: 0, avisados: 0 });
    expect(await _caixa()).toHaveLength(0);
  });

  it("quem só vê certificado não avisa nem liga o automático", async () => {
    const h = await na_janela();
    await entrar(cliente, "auditor_interno");
    expect((await cliente.post("/certificados/vencimentos/avisar", { certificado_id: String(h.do_marco.id) })).status).toBe(403);
    expect((await cliente.post("/certificados/vencimentos/automatico", { ligado: "sim" })).status).toBe(403);
    expect((await cliente.get("/certificados/vencimentos")).text).not.toContain('form="f-avisar"');
  });
});
