/**
 * Windows-1252 sem depender do ICU do Node (`dominio/winansi.ts`): o travessão,
 * as aspas curvas e o euro saem certos, e os acentos continuam como eram.
 */
import { describe, expect, it } from "vitest";
import { decodificar_windows_1252 } from "../src/dominio/winansi.js";

describe("decodificar_windows_1252", () => {
  it("a faixa 0x80–0x9F vira o caractere de verdade, não controle invisível", () => {
    expect(decodificar_windows_1252(Uint8Array.from([0x97, 0x96, 0x93, 0x94, 0x85, 0x80]))).toBe("—–“”…€");
  });
  it("acentos e ASCII ficam como eram", () => {
    expect(decodificar_windows_1252(Uint8Array.from([0x4a, 0x6f, 0xe3, 0x6f, 0x20, 0xc7, 0xe9]))).toBe("João Çé");
  });
});
