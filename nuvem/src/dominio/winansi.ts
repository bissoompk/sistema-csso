/**
 * Windows-1252 (o "ANSI" do Excel no Windows e o WinAnsi da Helvetica padrão
 * do PDF) em texto, sem `TextDecoder("windows-1252")`.
 *
 * O Node compilado com ICU reduzido trata esse rótulo como latin1 puro: a faixa
 * 0x80–0x9F, onde moram o travessão, as aspas curvas, as reticências e o euro,
 * vira caractere de controle invisível. Os acentos (0xA0–0xFF) não mudam —
 * por isso o defeito só aparecia em texto com travessão ou aspas (25/10/2026).
 */
const FAIXA_80_9F = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ";

export function decodificar_windows_1252(bytes: Uint8Array): string {
  let texto = "";
  for (const b of bytes) texto += b >= 0x80 && b <= 0x9f ? FAIXA_80_9F[b - 0x80] : String.fromCharCode(b);
  return texto;
}
