/**
 * Quem alcança a ocorrência RESTRITA do módulo de acidentes (D14a, 23/10/2026).
 *
 * O acidentado menor de idade deixa a ocorrência restrita à equipe de SST: a
 * que investiga ou encaminha ao SIASS (engenharia, técnico, médico, coordenação).
 * A secretaria, que só recebe e tria a comunicação, e a chefia, que comunica,
 * não a abrem — a ficha responde 404, igual à inexistente, e o anexo idem.
 *
 * Um lugar só: a ficha (`rotas/acidentes.ts`), os anexos (`anexo_acesso.ts`) e,
 * nas fatias seguintes, as listas e a busca leem daqui.
 */
import type { UsuarioAtual } from "./rbac.js";

export function pode_ver_restrita_sst(usuario: UsuarioAtual): boolean {
  return usuario.pode("acidente.investigar") || usuario.pode("acidente.siass");
}
