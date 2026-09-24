/**
 * RN-19 — como o servidor aparece na tela. As regras de
 * `app/servicos/identificacao.py`, exercitadas no serviço e pelos globais de
 * template (`identificar`, `texto_livre`) que `web.ts` registra. As versões de
 * tela (`test_privacidade.py`) entram com as rotas que as exibem.
 */
import { describe, expect, it } from "vitest";
import * as identificacao from "../src/servicos/identificacao";
import { COOKIE_SESSAO } from "../src/servicos/autenticacao";
import { UsuarioAtual } from "../src/servicos/rbac";
import { identificador_opaco } from "../src/servicos/textos";
import { ambiente } from "../src/web";

const usuario = (permissoes: string[], servidor_id: number | null = null) =>
  new UsuarioAtual({ id: 1, login: "x", nome: "X", permissoes, perfis: [], servidor_id });

const SERVIDOR = { id: 7, nome: "Marco Antônio Alves Schetino", siape: "1110654", email: "marco.schetino@ufvjm.edu.br" };
const SEMENTE = "abcdef0123456789";

describe("identificacao (RN-19)", () => {
  it("o nome do cookie é o de autenticacao (cópia guardada por teste)", () => {
    expect(identificacao.COOKIE_SESSAO).toBe(COOKIE_SESSAO);
  });

  it("sem permissão nominal: identificador opaco, nunca o nome nem o SIAPE", () => {
    const id = identificacao.identificar(SERVIDOR, usuario(["processo.ver"]), SEMENTE);
    expect(id.nominal).toBe(false);
    expect(id.nome).toBe(identificador_opaco(7, SEMENTE));
    expect(id.siape).toBe("");
    expect(id.suprimida).toBe(true);
    expect(String(id)).toBe(id.nome);
    expect(id.com_siape).toBe(id.nome);
  });

  it("exposicao.ver (ou epi.ficha) lê o nome", () => {
    for (const p of ["exposicao.ver", "epi.ficha"]) {
      const id = identificacao.identificar(SERVIDOR, usuario([p]), SEMENTE);
      expect(id.nominal).toBe(true);
      expect(id.nome).toBe(SERVIDOR.nome);
      expect(id.com_siape).toBe(`${SERVIDOR.nome} · SIAPE 1110654`);
    }
  });

  it("o titular vê o próprio nome (LGPD art. 18, II)", () => {
    expect(identificacao.identificar(SERVIDOR, usuario([], 7), SEMENTE).nominal).toBe(true);
    expect(identificacao.identificar(SERVIDOR, usuario([], 8), SEMENTE).nominal).toBe(false);
  });

  it("sem usuário: o lado seguro", () => {
    expect(identificacao.identificar(SERVIDOR, null, SEMENTE).nominal).toBe(false);
  });

  it("aceita quem aponta para o servidor, e só o id", () => {
    const processo = { servidor_id: 7, servidor: SERVIDOR };
    expect(identificacao.identificar(processo, usuario(["exposicao.ver"]), SEMENTE).nome).toBe(SERVIDOR.nome);
    // só o id: nem quem pode ver recebe o nome (não há objeto) — código opaco
    const soId = identificacao.identificar(7, usuario(["exposicao.ver"]), SEMENTE);
    expect(soId.nominal).toBe(false);
    expect(soId.nome).toBe(identificador_opaco(7, SEMENTE));
    // relação não carregada: idem
    expect(identificacao.identificar({ servidor_id: 7 }, usuario(["exposicao.ver"]), SEMENTE).nominal).toBe(false);
  });

  it("sem servidor: o vazio, e não 'suprimido'", () => {
    const vazio = identificacao.identificar(null, usuario([]), SEMENTE);
    expect(vazio.nome).toBe(identificacao.SEM_SERVIDOR);
    expect(vazio.suprimida).toBe(false);
    expect(identificacao.identificar({ servidor_id: null, servidor: null }, null, SEMENTE, { vazio: "ninguém" }).nome).toBe(
      "ninguém",
    );
  });

  it("o opaco é estável na sessão e muda entre sessões", () => {
    const a = identificacao.identificar(SERVIDOR, null, SEMENTE).nome;
    expect(identificacao.identificar(SERVIDOR, null, SEMENTE).nome).toBe(a);
    expect(identificacao.identificar(SERVIDOR, null, "outra-sessao-xyz").nome).not.toBe(a);
  });

  it("semente é o prefixo de 16 do cookie de sessão", () => {
    const req = { cookies: { get: (k: string) => (k === COOKIE_SESSAO ? "0123456789abcdefXYZ" : null) } };
    expect(identificacao.semente_de(req)).toBe("0123456789abcdef");
    expect(identificacao.semente_de(null)).toBe("");
  });

  it("casa_a_busca: SIAPE vale para todos; nome e e-mail só para quem vê aquele nome", () => {
    const sem = usuario(["processo.ver"]);
    expect(identificacao.casa_a_busca("1110654", SERVIDOR, sem)).toBe(true);
    expect(identificacao.casa_a_busca("marco", SERVIDOR, sem)).toBe(false);
    expect(identificacao.casa_a_busca("schetino", SERVIDOR, sem)).toBe(false);
    expect(identificacao.casa_a_busca("marco", SERVIDOR, usuario(["exposicao.ver"]))).toBe(true);
    expect(identificacao.casa_a_busca("antonio", SERVIDOR, usuario([], 7))).toBe(true); // chave_busca tira acento
    expect(identificacao.casa_a_busca("marco", null, usuario(["exposicao.ver"]))).toBe(false);
  });

  it("texto_livre suprime a frase inteira para quem não vê nome", () => {
    const frase = "Rascunho de requisição para Gorete (SIAPE 3010077)";
    expect(identificacao.texto_livre(frase, usuario(["processo.ver"]))).toBe(identificacao.TEXTO_SUPRIMIDO);
    expect(identificacao.texto_livre(frase, usuario(["exposicao.ver"]))).toBe(frase);
    // o titular lê a própria trilha quando a tela diz de quem é
    expect(identificacao.texto_livre(frase, usuario([], 7), { sobre: { servidor_id: 7 } })).toBe(frase);
    expect(identificacao.texto_livre(frase, usuario([], 7))).toBe(identificacao.TEXTO_SUPRIMIDO);
    expect(identificacao.texto_livre("", usuario([]))).toBe(identificacao.SEM_SERVIDOR);
  });
});

describe("globais de template", () => {
  const request = { cookies: { get: (k: string) => (k === COOKIE_SESSAO ? SEMENTE + "resto" : null) } };
  const r = (tpl: string, ctx: Record<string, unknown>) => ambiente.renderString(tpl, ctx);

  it("identificar lê usuario e request do contexto", () => {
    expect(r("{{ identificar(s) }}", { s: SERVIDOR, usuario: usuario([]), request })).toBe(identificador_opaco(7, SEMENTE));
    expect(r("{{ identificar(s) }}", { s: SERVIDOR, usuario: usuario(["exposicao.ver"]), request })).toBe(SERVIDOR.nome);
    expect(r("{{ identificar(s).com_siape }}", { s: SERVIDOR, usuario: usuario(["exposicao.ver"]), request })).toBe(
      `${SERVIDOR.nome} · SIAPE 1110654`,
    );
    expect(r("{% if identificar(s).suprimida %}S{% endif %}", { s: SERVIDOR, usuario: null, request })).toBe("S");
    expect(r("{{ identificar(none, vazio='ninguém') }}", { usuario: null, request })).toBe("ninguém");
  });

  it("texto_livre com sobre= e vazio=", () => {
    const ctx = { usuario: usuario([], 7), request, req: { servidor_id: 7 } };
    expect(r("{{ texto_livre('frase') }}", ctx)).toBe(identificacao.TEXTO_SUPRIMIDO.replace("(", "(").replace(")", ")"));
    expect(r("{{ texto_livre('frase', sobre=req) }}", ctx)).toBe("frase");
    expect(r("{{ texto_livre(none, vazio='nada') }}", ctx)).toBe("nada");
  });

  it("o filtro evento", () => {
    expect(r("{{ 'PROCESSO_CRIADO' | evento }}", {})).toBe("Processo criado");
  });
});
