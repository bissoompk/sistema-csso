/** T1 (24/11/2026): o QR do certificado não pode apontar para a própria máquina. */
import { describe, expect, it } from "vitest";
import { endereco_local } from "../src/servicos/emissao_certificado.js";

describe("endereço local no QR", () => {
  it("reconhece o endereço da própria máquina", () => {
    for (const u of ["http://127.0.0.1:8766", "http://localhost:8777", "https://app.localhost", "http://[::1]:80", "http://127.0.1.1"]) {
      expect(endereco_local(u), u).toBe(true);
    }
  });
  it("aceita endereço que outro aparelho alcança", () => {
    for (const u of ["https://cssosisa.netlify.app", "http://100.90.45.44:8777", "https://sisa.ufvjm.edu.br", "lixo"]) {
      expect(endereco_local(u), u).toBe(false);
    }
  });
});
