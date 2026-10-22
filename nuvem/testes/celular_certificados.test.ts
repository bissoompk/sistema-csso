/**
 * As listas de certificados no celular (lote A do plano de celular: P7, P15 e
 * P19).
 *
 * O que é regra aqui:
 *
 * - /certificados, /certificados/fila, /certificados/vencimentos e
 *   /certificados/emails usam o contrato `table.empilhavel`: abaixo de 600px a
 *   linha vira cartão, e cada célula diz o próprio nome (`data-coluna`);
 * - a célula-título (participante; assunto, nos e-mails) é a ÚNICA sem
 *   `data-coluna`, e a dos botões é `td.acao-linha`;
 * - datas e situação são `td.curta` (dividem a linha do cartão);
 * - a caixinha de marcar (fila e reciclagem) mora num `label.marca-linha` junto
 *   com o nome: o toque no nome marca a linha.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CSSO_DIR_ARQUIVOS = mkdtempSync(path.join(tmpdir(), "csso-celular-cert-"));

import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import { definirArmazenamento } from "../src/servicos/armazenamento.js";
import * as servico from "../src/servicos/emissao_certificado.js";
import * as datas_br from "../src/servicos/datas_br.js";
import * as servico_participante from "../src/servicos/participante.js";
import { bancoLimpo, contas, entrar, type Cliente } from "./ajuda.js";
import { _cenario, _usuario } from "./ajuda_certificado.js";

definirArmazenamento(null);

/** As linhas do `<tbody>` (ou da tabela sem tbody) da primeira `<table>`. */
function tabela(html: string): { abre: string; linhas: string[] } {
  const m = /<table\b([^>]*)>([\s\S]*?)<\/table>/.exec(html);
  expect(m, "a tela não tem tabela").toBeTruthy();
  const corpo = m![2]!.replace(/<thead>[\s\S]*?<\/thead>/, "");
  const linhas = [...corpo.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((x) => x[1]!);
  return { abre: m![1]!, linhas };
}

/** As células `<td ...>` de uma linha: [atributos, conteúdo]. */
function celulas(linha: string): [string, string][] {
  return [...linha.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)].map((x) => [x[1]!, x[2]!]);
}

/** Confere o contrato: empilhavel, uma célula-título só, o resto rotulado. */
function confere_contrato(html: string, titulo: RegExp) {
  const { abre, linhas } = tabela(html);
  expect(abre).toMatch(/class="[^"]*\bempilhavel\b/);
  const dados = linhas.filter((l) => !/colspan=/.test(l));
  expect(dados.length, "a tela renderizou sem linhas de dado").toBeGreaterThan(0);
  for (const linha of dados) {
    const sem_rotulo = celulas(linha).filter(([a]) => !/data-coluna=/.test(a) && !/\bacao-linha\b/.test(a));
    expect(sem_rotulo, "uma célula-título por linha").toHaveLength(1);
    expect(sem_rotulo[0]![1]).toMatch(titulo);
  }
  return dados;
}

const curtas = (linha: string) =>
  celulas(linha).filter(([a]) => /class="[^"]*\bcurta\b/.test(a)).map(([a]) => /data-coluna="([^"]*)"/.exec(a)?.[1]);

const telas: Record<string, string> = {};

beforeAll(async () => {
  const { db, novoCliente } = await bancoLimpo();
  const usuario = await _usuario(db);
  const cen = await _cenario(db, usuario, { extras: [["2220001", "Ana Lima", "8"]] });
  await contas(db);
  const cliente: Cliente = await entrar(novoCliente(), "coordenador_csso");

  // fila AGUARDANDO antes de emitir: as duas inscrições com a caixinha
  telas.aguardando = (await cliente.get("/certificados/fila?etapa=AGUARDANDO")).text;

  // emite o do Marco, e ele ganha e-mail para o envio ter destinatário
  const emitido = await servico.emitir(db, usuario, cen.inscricao, { gerar_pdf: false });
  const marco = (await servico_participante.carregar(db, cen.inscricao.participante_id))!;
  await servico_participante.registrar_email(db, marco, "marco@ufvjm.edu.br");
  // vence em 10 dias: entra na reciclagem como "a vencer", com caixinha
  await db
    .update(e.certificado)
    .set({ data_vencimento: datas_br.somar_dias(datas_br.hoje(), 10) })
    .where(eq(e.certificado.id, emitido.certificado.id));

  telas.emitidos = (await cliente.get("/certificados")).text;
  telas.fila_emitidos = (await cliente.get("/certificados/fila?etapa=EMITIDO")).text;
  telas.vencimentos = (await cliente.get("/certificados/vencimentos")).text;
  await cliente.post("/certificados/fila/email", { certificado_id: [String(emitido.certificado.id)] });
  telas.emails = (await cliente.get("/certificados/emails")).text;
});

describe("listas de certificados no celular (lote A)", () => {
  it("/certificados: participante de título, datas e situação curtas", () => {
    const [linha] = confere_contrato(telas.emitidos!, /Marco Antônio/);
    expect(curtas(linha!)).toEqual(["Emissão", "Vencimento", "Situação"]);
  });

  it("/certificados/fila: a caixinha no label.marca-linha do participante", () => {
    for (const html of [telas.aguardando!, telas.fila_emitidos!]) {
      const dados = confere_contrato(html, /marca-linha/);
      for (const linha of dados) {
        expect(linha).toMatch(/<label class="marca-linha"><input class="marcar"[^>]*type="checkbox"[\s\S]*?<\/label>/);
        expect(curtas(linha)[0]).toBe("Terminou em");
      }
    }
    // sem a coluna separada da caixinha
    expect(telas.aguardando).not.toContain('<span class="oculto">Selecionar</span>');
    expect(telas.aguardando).toMatch(/marca-linha"><input class="marcar"[^>]*name="inscricao_id"[\s\S]*?Ana Lima[\s\S]*?<\/label>/);
  });

  it("/certificados/vencimentos: vencimento e situação curtos, caixinha com o nome", () => {
    const [linha] = confere_contrato(telas.vencimentos!, /Marco Antônio/);
    expect(curtas(linha!)).toEqual(["Vencimento", "Situação"]);
    expect(linha).toMatch(/<label class="marca-linha"><input\s+class="marcar"[^>]*name="certificado_id"[\s\S]*?Marco Antônio[\s\S]*?<\/label>/);
  });

  it("/certificados/emails: assunto de título e os botões em td.acao-linha", () => {
    const [linha] = confere_contrato(telas.emails!, /\S/);
    const acao = celulas(linha!).find(([a]) => /\bacao-linha\b/.test(a));
    expect(acao, "falta a td.acao-linha").toBeTruthy();
    expect(acao![1]).toContain("/cancelar");
    // o endereço vai de ponta a ponta: em meia coluna, quebrava no meio
    expect(curtas(linha!)).toEqual(["Pedido em"]);
  });

  it("nenhuma das quatro telas tem style= ou <style> inline", () => {
    for (const html of Object.values(telas)) expect(html).not.toMatch(/\sstyle=|<style/);
  });
});
