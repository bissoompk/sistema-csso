/**
 * CPF só para o certificado (19/10/2026, `servicos/cpf_certificado.ts`).
 *
 * O dono do sistema decidiu guardar o CPF do participante e do responsável
 * pela formação, porque o certificado de Brigadista Orgânico (CBMMG) o exige.
 * O que estes testes cobram é o cercado em volta do dado:
 *
 * - entra só pelo campo `cpf_certificado` (o resto do formulário continua
 *   mascarado), com dígito verificador conferido, guardado só em dígitos;
 * - nenhuma tela mostra dígito do CPF — só `***.***.***-**`;
 * - a trilha diz que mudou, nunca o valor;
 * - é congelado na emissão só quando o modelo o pede, e então o certificado
 *   não muda se o cadastro mudar;
 * - a validação pública e a exportação em claro não o levam.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inflateSync } from "node:zlib";
import path from "node:path";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-cpf-"));

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import { sem_credenciais } from "../src/servicos/backup.js";
import { CAMPOS_CERTIFICADO } from "../src/servicos/certificado.js";
import * as cpf_certificado from "../src/servicos/cpf_certificado.js";
import * as servico from "../src/servicos/emissao_certificado.js";
import * as textos from "../src/servicos/textos.js";
import * as servico_participante from "../src/servicos/participante.js";
import * as servico_turma from "../src/servicos/turma.js";
import { bancoLimpo, contas, entrar, type AmbienteDeTeste, type Cliente } from "./ajuda.js";
import { _cenario, _usuario } from "./ajuda_certificado.js";

definirArmazenamento(null);

// CPFs válidos (dígito verificador confere), gerados para teste
const CPF_PARTICIPANTE = "52998224725";
const CPF_INSTRUTOR = "11144477735";
const CPF_NOVO = "39053344705";
const FORMATADO = (d: string) => textos.formatar_cpf(d);

let db: Banco;
let cliente: Cliente;
let amb: AmbienteDeTeste;
await bancoLimpo();
beforeEach(async () => {
  amb = await bancoLimpo();
  db = amb.db;
  cliente = amb.cliente;
});

/** Qualquer forma do número (só dígitos, pontuado, ou os blocos do meio). */
function tem_cpf(texto: string, digitos: string): boolean {
  return (
    texto.includes(digitos) ||
    texto.includes(FORMATADO(digitos)) ||
    texto.includes(`${digitos.slice(3, 6)}.${digitos.slice(6, 9)}`)
  );
}

/** O texto que o pdf-lib escreve com fonte padrão sai em hexadecimal WinAnsi. */
function no_pdf(bytes: Uint8Array, trecho: string): boolean {
  const buf = Buffer.from(bytes);
  const bruto = buf.toString("latin1");
  // os fluxos de conteúdo saem comprimidos (Flate): abre cada um
  const partes = [bruto];
  for (const m of bruto.matchAll(/stream\r?\n/g)) {
    const ini = m.index! + m[0].length;
    const fim = bruto.indexOf("endstream", ini);
    try {
      partes.push(inflateSync(buf.subarray(ini, fim)).toString("latin1"));
    } catch {
      // fluxo não comprimido ou de imagem
    }
  }
  const tudo = partes.join("\n");
  const hex = Buffer.from(trecho, "latin1").toString("hex").toUpperCase();
  return tudo.includes(trecho) || tudo.toUpperCase().includes(hex);
}

async function _mapear_cpf(modelo_id: number) {
  await db.insert(e.certificado_modelo_tag).values([
    { modelo_id, marcador: "cpf_participante", campo: "participante_cpf", ordem: 90, obrigatorio: true },
    { modelo_id, marcador: "cpf_instrutor", campo: "instrutor_cpf", ordem: 91, obrigatorio: true },
    { modelo_id, marcador: "nome_instrutor", campo: "instrutor_nome", ordem: 92, obrigatorio: false },
  ]);
}

describe("o dado", () => {
  it("valida o dígito verificador e guarda só dígitos", () => {
    expect(textos.cpf_digitos("529.982.247-25")).toBe(CPF_PARTICIPANTE);
    expect(textos.cpf_digitos(" 52998224725 ")).toBe(CPF_PARTICIPANTE);
    expect(textos.cpf_digitos("529.982.247-24")).toBeNull();
    expect(textos.cpf_digitos("111.111.111-11")).toBeNull();
    expect(textos.cpf_digitos("5299822472")).toBeNull();
    expect(textos.cpf_digitos("CPF 52998224725")).toBeNull();
    expect(textos.formatar_cpf(CPF_PARTICIPANTE)).toBe("529.982.247-25");
    expect(cpf_certificado.ler_campo("")).toBeUndefined();
    expect(cpf_certificado.ler_campo("x", true)).toBeNull();
    expect(() => cpf_certificado.ler_campo("123.456.789-00")).toThrow(cpf_certificado.CpfInvalido);
    expect(cpf_certificado.exibir(CPF_PARTICIPANTE)).toBe(textos.CPF_MASCARADO);
  });

  it("o banco recusa CPF fora do formato", async () => {
    const [p] = await db
      .insert(e.participante)
      .values({ nome: "Externa", identificador_publico: "PTC-AAAAAAAA", vinculo: "VISITANTE" })
      .returning();
    await expect(db.update(e.participante).set({ cpf: "529.982.247-25" }).where(eq(e.participante.id, p!.id))).rejects.toThrow();
  });

  it("os campos do vocabulário formatam o CPF; vazio quando não congelado", () => {
    expect(Object.keys(CAMPOS_CERTIFICADO)).toEqual(
      expect.arrayContaining(["participante_cpf", "instrutor_cpf", "instrutor_nome", "instrutor_titulo", "instrutor_registro"]),
    );
  });
});

describe("instrutor (/treinamentos/assinaturas)", () => {
  it("só o campo cpf_certificado escapa da máscara; a tela e a trilha não mostram o número", async () => {
    await entrar(cliente, (await contas(db)).coordenador_csso![0]);
    const r = await cliente.post("/treinamentos/assinaturas", {
      nome: "Instrutora Externa",
      externo: "1",
      // outro campo com CPF continua mascarado na porta
      organizacao: `Brigada ${FORMATADO(CPF_NOVO)}`,
      cpf_certificado: FORMATADO(CPF_INSTRUTOR),
    });
    expect(r.status).toBe(200);
    const [a] = await db.select().from(e.assinatura_instrutor).where(eq(e.assinatura_instrutor.nome, "Instrutora Externa"));
    expect(a!.cpf).toBe(CPF_INSTRUTOR);
    expect(a!.organizacao).toBe(`Brigada ${textos.CPF_MASCARADO}`);

    const tela = await cliente.get("/treinamentos/assinaturas");
    expect(tem_cpf(tela.text, CPF_INSTRUTOR)).toBe(false);
    expect(tela.text).toContain(textos.CPF_MASCARADO);

    // edição: em branco não mexe; CPF inválido é recusado sem eco
    const ruim = await cliente.post(`/treinamentos/assinaturas/${a!.id}`, {
      nome: "Instrutora Externa",
      externo: "1",
      ativo: "1",
      vigencia_inicio: "2000-01-01",
      cpf_certificado: "529.982.247-24",
    });
    expect(ruim.text).toContain("CPF inválido");
    expect(ruim.text).not.toContain("247-24");
    // a recusa reabre o popup da linha, e o campo do CPF volta vazio
    expect(ruim.text).toMatch(new RegExp(`<dialog class="popup" id="editar-assin-${a!.id}"[^>]* open>`));
    expect(ruim.text).toContain(`id="ed-assin-${a!.id}-cpf" name="cpf_certificado" value=""`);
    await cliente.post(`/treinamentos/assinaturas/${a!.id}`, {
      nome: "Instrutora Externa",
      externo: "1",
      ativo: "1",
      vigencia_inicio: "2000-01-01",
      titulo: "Bombeira civil",
    });
    let [b] = await db.select().from(e.assinatura_instrutor).where(eq(e.assinatura_instrutor.id, a!.id));
    expect(b!.cpf).toBe(CPF_INSTRUTOR);
    expect(b!.titulo).toBe("Bombeira civil");
    await cliente.post(`/treinamentos/assinaturas/${a!.id}`, {
      nome: "Instrutora Externa",
      externo: "1",
      ativo: "1",
      vigencia_inicio: "2000-01-01",
      titulo: "Bombeira civil",
      apagar_cpf: "1",
    });
    [b] = await db.select().from(e.assinatura_instrutor).where(eq(e.assinatura_instrutor.id, a!.id));
    expect(b!.cpf).toBeNull();

    const eventos = await db
      .select()
      .from(e.historico_evento)
      .where(eq(e.historico_evento.tipo_evento, "ASSINATURA_INSTRUTOR_CPF_ALTERADO"));
    expect(eventos.map((ev) => ev.descricao.split(" · ").pop())).toEqual(["CPF informado", "CPF apagado"]);
    const trilha = JSON.stringify(await db.select().from(e.historico_evento));
    expect(tem_cpf(trilha, CPF_INSTRUTOR)).toBe(false);
    const auditoria = await cliente.get("/auditoria");
    expect(tem_cpf(auditoria.text, CPF_INSTRUTOR)).toBe(false);
  });
});

describe("participante (aba Inscrições)", () => {
  it("grava pela inscrição, mostra só a máscara, e a trilha não leva o número", async () => {
    const usuario = await _usuario(db);
    const c = await _cenario(db, usuario);
    await entrar(cliente, (await contas(db)).coordenador_csso![0]);
    const base = `/turmas/${c.turma.id}/inscricoes/${c.inscricao.id}/cpf`;

    const ruim = await cliente.post(base, { cpf_certificado: "529.982.247-24" });
    expect(ruim.text).toContain("CPF inválido");
    const r = await cliente.post(base, { cpf_certificado: FORMATADO(CPF_PARTICIPANTE) });
    expect(r.status).toBe(200);
    const [p] = await db.select().from(e.participante).where(eq(e.participante.id, c.inscricao.participante_id));
    expect(p!.cpf).toBe(CPF_PARTICIPANTE);

    for (const aba of ["inscricoes", "presencas", "emissao", "turma"]) {
      const tela = await cliente.get(`/turmas/${c.turma.id}?aba=${aba}`);
      expect(tem_cpf(tela.text, CPF_PARTICIPANTE), aba).toBe(false);
    }
    // o CPF não é chave de busca: digitá-lo não acha ninguém
    expect(await servico_participante.buscar(db, CPF_PARTICIPANTE, usuario)).toEqual([]);
    expect(await servico_participante.buscar(db, FORMATADO(CPF_PARTICIPANTE), usuario)).toEqual([]);

    const ev = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "PARTICIPANTE_CPF_ALTERADO"));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.descricao).toMatch(/^PTC-\w+ · CPF informado$/);
  });

  it("sem turma.inscrever, 403 e nada gravado", async () => {
    const usuario = await _usuario(db);
    const c = await _cenario(db, usuario);
    await entrar(cliente, (await contas(db)).auditor_interno![0]);
    const r = await cliente.post(`/turmas/${c.turma.id}/inscricoes/${c.inscricao.id}/cpf`, { cpf_certificado: CPF_PARTICIPANTE });
    expect(r.status).toBe(403);
    const [p] = await db.select().from(e.participante).where(eq(e.participante.id, c.inscricao.participante_id));
    expect(p!.cpf).toBeNull();
  });
});

describe("certificado", () => {
  it("congela o CPF só quando o modelo pede; não muda com o cadastro; validação pública não mostra", async () => {
    const usuario = await _usuario(db);
    const c = await _cenario(db, usuario);
    await cpf_certificado.definir_do_participante(db, usuario, c.inscricao.participante, CPF_PARTICIPANTE);
    await cpf_certificado.definir_do_instrutor(db, usuario, c.instrutor.id, CPF_INSTRUTOR);

    // sem marcador para o CPF: nada é congelado
    const insc = (await servico_turma.carregar_inscricao(db, c.inscricao.id))!;
    const sem = await servico.emitir(db, usuario, insc);
    const congelado_sem = sem.certificado.contexto_congelado as Record<string, unknown>;
    expect(congelado_sem.participante_cpf).toBeNull();
    expect(JSON.stringify(congelado_sem)).not.toContain(CPF_INSTRUTOR);
    await servico.anular(db, usuario, sem.certificado, "teste do CPF no modelo");

    // com marcador: congela, e o documento leva o número formatado
    await _mapear_cpf(c.modelo.id);
    const insc2 = (await servico_turma.carregar_inscricao(db, c.inscricao.id))!;
    const com = await servico.emitir(db, usuario, insc2);
    const contexto = servico.montar_contexto(db, com.certificado);
    expect(contexto.participante_cpf).toBe(CPF_PARTICIPANTE);
    expect(contexto.instrutores[0]!.cpf).toBe(CPF_INSTRUTOR);
    const dic = contexto.como_dicionario();
    expect(dic.cpf_participante).toBe("529.982.247-25");
    expect(dic.cpf_instrutor).toBe("111.444.777-35");
    expect(dic.nome_instrutor).toBe("Fabrício Raimundi Andrade");

    // o cadastro muda; o certificado emitido, não
    await cpf_certificado.definir_do_participante(db, usuario, insc2.participante, CPF_NOVO);
    const [relido] = await db.select().from(e.certificado).where(eq(e.certificado.id, com.certificado.id));
    expect(servico.montar_contexto(db, relido!).participante_cpf).toBe(CPF_PARTICIPANTE);

    const pdf = await servico.pdf_do_certificado(db, usuario, relido!);
    expect(no_pdf(pdf.bytes, "529.982.247-25")).toBe(true);
    expect(no_pdf(pdf.bytes, "111.444.777-35")).toBe(true);

    // a validação pública, a ficha e a lista não mostram o número
    await entrar(cliente, (await contas(db)).coordenador_csso![0]);
    for (const url of [
      `/validar/${relido!.chave_validacao}`,
      `/certificados/${relido!.id}`,
      "/certificados",
      `/turmas/${c.turma.id}?aba=emissao`,
    ]) {
      const tela = await cliente.get(url);
      expect(tem_cpf(tela.text, CPF_PARTICIPANTE), url).toBe(false);
      expect(tem_cpf(tela.text, CPF_INSTRUTOR), url).toBe(false);
    }
    const anonimo = amb.novoCliente();
    const publica = await anonimo.get(`/validar/${relido!.chave_validacao}`);
    expect(tem_cpf(publica.text, CPF_PARTICIPANTE)).toBe(false);
    expect(tem_cpf(publica.text, CPF_INSTRUTOR)).toBe(false);
  });

  it("CPF obrigatório no modelo e ausente no cadastro bloqueia a emissão", async () => {
    const usuario = await _usuario(db);
    const c = await _cenario(db, usuario);
    await _mapear_cpf(c.modelo.id);
    const insc = (await servico_turma.carregar_inscricao(db, c.inscricao.id))!;
    await expect(servico.emitir(db, usuario, insc)).rejects.toThrow(/CPF/);
  });
});

describe("saídas sem o CPF", () => {
  it("a exportação em claro tira o CPF das colunas e do congelado", () => {
    const dump = new Map<string, string>([
      ["participante", JSON.stringify([{ id: 1, cpf: CPF_PARTICIPANTE }])],
      ["assinatura_instrutor", JSON.stringify([{ id: 1, cpf: CPF_INSTRUTOR }])],
      [
        "certificado",
        JSON.stringify([
          { id: 1, contexto_congelado: { participante_cpf: CPF_PARTICIPANTE, instrutores: [{ nome: "X", cpf: CPF_INSTRUTOR }] } },
        ]),
      ],
    ]);
    const limpo = [...sem_credenciais(dump).values()].join("\n");
    expect(tem_cpf(limpo, CPF_PARTICIPANTE)).toBe(false);
    expect(tem_cpf(limpo, CPF_INSTRUTOR)).toBe(false);
  });

  it("template nenhum imprime o CPF (só `cpf_exibicao`)", () => {
    const raiz = path.resolve(import.meta.dirname, "../templates");
    const achados: string[] = [];
    const andar = (dir: string) => {
      for (const nome of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, nome.name);
        if (nome.isDirectory()) andar(p);
        else if (nome.name.endsWith(".html")) {
          for (const m of readFileSync(p, "utf8").matchAll(/\{\{[^}]*?(\.cpf\b|\bparticipante_cpf\b|\binstrutor_cpf\b|\[\s*['"]cpf['"]\s*\])[^}]*\}\}/gi)) {
            achados.push(`${path.relative(raiz, p)}: ${m[0]}`);
          }
        }
      }
    };
    andar(raiz);
    expect(achados).toEqual([]);
  });
});
