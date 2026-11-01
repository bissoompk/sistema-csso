/**
 * O segundo fator (TOTP) da entrada, opcional: o algoritmo (vetor do RFC 6238),
 * a cifra do segredo, e o fluxo inteiro — ligar, entrar com código, código
 * repetido, código de recuperação (uma vez) e desligar. Dados fictícios.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import * as sf from "../src/servicos/segundo_fator.js";
import { bancoLimpo, contas, entrar, naTransacao, SENHA_TESTE } from "./ajuda.js";

const { novoCliente, db } = await bancoLimpo();
await naTransacao((tx) => contas(tx));

describe("o algoritmo", () => {
  it("bate com o vetor do RFC 6238 (SHA-1, T=59 s → ...287082)", () => {
    const segredo = Buffer.from("12345678901234567890");
    expect(sf.codigo_do_passo(segredo, Math.floor(59 / 30))).toBe("287082");
    expect(sf.codigo_do_passo(segredo, Math.floor(1111111109 / 30))).toBe("081804");
  });

  it("base32 vai e volta", () => {
    const bruto = Buffer.from("segredo de teste 123");
    expect(sf.base32_decodificar(sf.base32_codificar(bruto)).equals(bruto)).toBe(true);
  });

  it("aceita o passo anterior e o seguinte, recusa o distante e o código repetido", () => {
    const segredo = Buffer.from("12345678901234567890");
    const agora = new Date(59_000);
    const c = (p: number) => sf.codigo_do_passo(segredo, p);
    expect(sf.passo_que_confere(segredo, c(1), null, agora)).toBe(1);
    expect(sf.passo_que_confere(segredo, c(0), null, agora)).toBe(0);
    expect(sf.passo_que_confere(segredo, c(2), null, agora)).toBe(2);
    expect(sf.passo_que_confere(segredo, c(4), null, agora)).toBeNull();
    expect(sf.passo_que_confere(segredo, c(1), 1, agora)).toBeNull();
    expect(sf.passo_que_confere(segredo, "12345", null, agora)).toBeNull();
  });

  it("o segredo cifrado volta igual, e adulterado não decifra", () => {
    const bruto = Buffer.from("01234567890123456789");
    const cifrado = sf.cifrar(bruto);
    expect(cifrado).not.toContain(bruto.toString("base64"));
    expect(sf.decifrar(cifrado)?.equals(bruto)).toBe(true);
    const adulterado = Buffer.from(cifrado, "base64");
    adulterado[adulterado.length - 1]! ^= 1;
    expect(sf.decifrar(adulterado.toString("base64"))).toBeNull();
  });
});

describe("o fluxo na tela", () => {
  const login = "coordenador_csso";

  it("liga, exige o código na entrada, recusa o repetido, aceita recuperação uma vez e desliga", async () => {
    // 1. liga
    const dono = await entrar(novoCliente(), login);
    const inicio = await dono.post("/minha-conta/segundo-fator/iniciar", {});
    expect(inicio.status).toBe(200);
    const chave = /data-testid="chave-manual">([A-Z2-7]+)</.exec(inicio.text)?.[1];
    expect(chave, inicio.text.slice(0, 300)).toBeTruthy();
    const segredo = sf.base32_decodificar(chave!);
    const agora = Date.now();
    const passo = sf.passo_de(new Date(agora));
    // código errado não liga
    const ruim = await dono.post("/minha-conta/segundo-fator/confirmar", { codigo: "000000" });
    expect(ruim.status).toBe(422);
    const ok = await dono.post("/minha-conta/segundo-fator/confirmar", { codigo: sf.codigo_do_passo(segredo, passo) });
    expect(ok.status).toBe(200);
    const codigos = [...ok.text.matchAll(/<li>([a-z0-9]{5}-[a-z0-9]{5})<\/li>/g)].map((m) => m[1]!);
    expect(codigos.length).toBe(8);
    // o segredo está cifrado no banco, e os códigos só em HMAC
    const [linha] = await db.select().from(e.usuario_segundo_fator);
    expect(linha!.segredo_cifrado).not.toContain(chave!);
    const guardados = await db.select().from(e.usuario_codigo_recuperacao);
    expect(guardados.some((g) => codigos.includes(g.codigo_hash))).toBe(false);

    // 2. a entrada só com senha NÃO abre sessão: vai para o código
    const novo = novoCliente();
    const senhaSo = await novo.post("/login", { login, senha: SENHA_TESTE }, { seguir: false });
    expect(senhaSo.status).toBe(303);
    expect(senhaSo.headers.get("location")).toBe("/login/segundo-fator");
    expect((await novo.get("/inicio", { seguir: false })).status).toBe(303);
    // código errado: recusa e conta a falha
    const errado = await novo.post("/login/segundo-fator", { codigo: "123456" }, { seguir: false });
    expect(errado.status).toBe(200);
    expect(errado.text).toContain("Código inválido");
    // o código CERTO do passo seguinte (o do passo da ligação já foi gasto)
    const certo = await novo.post("/login/segundo-fator", { codigo: sf.codigo_do_passo(segredo, passo + 1) }, { seguir: false });
    expect(certo.status).toBe(303);
    expect((await novo.get("/inicio", { seguir: false })).status).toBe(200);
    // o mesmo código não vale de novo
    const outra = novoCliente();
    await outra.post("/login", { login, senha: SENHA_TESTE }, { seguir: false });
    const repetido = await outra.post("/login/segundo-fator", { codigo: sf.codigo_do_passo(segredo, passo + 1) }, { seguir: false });
    expect(repetido.status).toBe(200);
    expect(repetido.text).toContain("Código inválido");

    // 3. código de recuperação: vale uma vez
    const rec = novoCliente();
    await rec.post("/login", { login, senha: SENHA_TESTE }, { seguir: false });
    const comRec = await rec.post("/login/segundo-fator", { codigo: codigos[0]! }, { seguir: false });
    expect(comRec.status).toBe(303);
    const rec2 = novoCliente();
    await rec2.post("/login", { login, senha: SENHA_TESTE }, { seguir: false });
    const denovo = await rec2.post("/login/segundo-fator", { codigo: codigos[0]! }, { seguir: false });
    expect(denovo.status).toBe(200);

    // 4. sem o desafio assinado, a tela do código manda ao login
    const sem = novoCliente();
    const solto = await sem.get("/login/segundo-fator", { seguir: false });
    expect(solto.status).toBe(303);
    expect(solto.headers.get("location")).toBe("/login");

    // 5. desligar pede a senha atual
    const errada = await dono.post("/minha-conta/segundo-fator/desligar", { senha_atual: "senha-errada-123" });
    expect(errada.status).toBe(422);
    const desligou = await dono.post("/minha-conta/segundo-fator/desligar", { senha_atual: SENHA_TESTE });
    expect(desligou.status).toBe(200);
    expect(await db.select().from(e.usuario_segundo_fator)).toEqual([]);
    expect(await db.select().from(e.usuario_codigo_recuperacao)).toEqual([]);
    // a trilha diz que ligou e desligou, sem segredo nem código
    const eventos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.entidade, "usuario"));
    const tipos = eventos.map((x) => x.tipo_evento);
    expect(tipos).toContain(sf.SEGUNDO_FATOR_LIGADO);
    expect(tipos).toContain(sf.SEGUNDO_FATOR_DESLIGADO);
    expect(tipos).toContain(sf.SEGUNDO_FATOR_RECUPERACAO_USADA);
    expect(JSON.stringify(eventos)).not.toContain(chave!);
    // e a entrada volta a ser só a senha
    const volta = await entrar(novoCliente(), login);
    expect((await volta.get("/inicio", { seguir: false })).status).toBe(200);
  });
});
