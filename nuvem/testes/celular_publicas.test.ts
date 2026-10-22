/**
 * Telas públicas no celular (LOTE F, P14): os campos de identificação não podem
 * ganhar maiúscula automática, correção nem sublinhado de ortografia — o
 * teclado do celular trocaria "fulano@ufvjm" por "Fulano@ufvjm" e a entrada
 * falharia sem que a pessoa visse por quê.
 */
import { describe, expect, it } from "vitest";
import { bancoLimpo, contas } from "./ajuda";

/** A tag `<input ...>` inteira do campo com este id. */
function campo(html: string, id: string): string {
  const m = html.match(new RegExp(`<input[^>]*\\bid="${id}"[^>]*>`));
  expect(m, `campo #${id}`).not.toBeNull();
  return m![0];
}

function semAjudaDoTeclado(tag: string) {
  expect(tag).toContain('autocapitalize="none"');
  expect(tag).toContain('autocorrect="off"');
  expect(tag).toContain('spellcheck="false"');
}

describe("telas públicas no celular", () => {
  it("/login: o campo de identificação sem maiúscula, correção nem ortografia", async () => {
    const { db, cliente } = await bancoLimpo();
    await contas(db); // com contas, /login não manda para /primeiro-acesso
    const html = (await cliente.get("/login")).text;
    const login = campo(html, "login");
    semAjudaDoTeclado(login);
    expect(login).toContain('inputmode="email"');
    expect(login).toContain('autocomplete="username email"');
    // a senha continua só com o autocomplete dela
    expect(campo(html, "senha")).toContain('autocomplete="current-password"');
  });

  it("/primeiro-acesso: o e-mail sem maiúscula, correção nem ortografia; o nome continua livre", async () => {
    const { cliente } = await bancoLimpo();
    const html = (await cliente.get("/primeiro-acesso")).text;
    const email = campo(html, "email");
    semAjudaDoTeclado(email);
    expect(email).toContain('type="email"');
    expect(email).toContain('autocomplete="email"');
    // nome próprio quer a maiúscula do teclado
    expect(campo(html, "nome")).not.toContain('autocapitalize="none"');
  });

  it("/validar: a chave sem correção nem ortografia, em maiúsculas", async () => {
    const { cliente } = await bancoLimpo();
    const chave = campo((await cliente.get("/validar")).text, "chave");
    expect(chave).toContain('autocapitalize="characters"');
    expect(chave).toContain('autocorrect="off"');
    expect(chave).toContain('spellcheck="false"');
  });
});
