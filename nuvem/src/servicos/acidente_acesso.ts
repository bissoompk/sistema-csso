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
import { eq, or, type SQL } from "drizzle-orm";
import { acidente_ocorrencia } from "../db/esquema/index.js";
import { aplicar_escopo, type UsuarioAtual } from "./rbac.js";

export function pode_ver_restrita_sst(usuario: UsuarioAtual): boolean {
  return usuario.pode("acidente.investigar") || usuario.pode("acidente.siass");
}

/**
 * O recorte das ocorrências que a conta alcança (F1). É o `aplicar_escopo` de
 * `acidente.ver` com um acréscimo no escopo PRÓPRIO: além da ocorrência em que
 * a pessoa é o acidentado principal (`servidor_id`), a que ela mesma comunicou
 * (`criado_por`) — a chefia e o colega que comunicam acompanham o que enviaram,
 * sem passar a ver as dos outros.
 */
export function escopo_ocorrencias(usuario: UsuarioAtual): SQL | undefined {
  const base = aplicar_escopo(usuario, acidente_ocorrencia, "acidente.ver");
  if (base === undefined) return undefined;
  if (!usuario.alcance("acidente.ver").proprio) return base;
  return or(base, eq(acidente_ocorrencia.criado_por, usuario.id));
}

/** A ocorrência restrita (menor de idade) sai das listas de quem não instrui o caso. */
export function filtro_restrita(usuario: UsuarioAtual): SQL | undefined {
  return pode_ver_restrita_sst(usuario) ? undefined : eq(acidente_ocorrencia.restrita_sst, false);
}
