/**
 * "Tem acesso ao módulo?" — a regra ÚNICA (23/10/2026).
 *
 * O defeito: gravar "Sem acesso" num módulo (no perfil, em
 * `perfis_niveis.html`, ou na exceção da pessoa, em `usuarios.html`) tirava
 * as permissões DO MÓDULO, mas o módulo continuava no menu, no mapa
 * `/modulos` e no seletor de módulos, porque havia telas dele guardadas só por
 * permissões que não se liberam por módulo (`PERMISSOES_SO_DO_PERFIL`):
 * "Instrutores" (`assinatura.gerenciar`) segurava Certificados e Treinamentos,
 * "Importar" (`catalogo.gerenciar`) segurava Processos SEI; e as rotas desses
 * itens, do CSV de EPI (`indicador.ver` + `exportar`) e da exportação de
 * processos (`exportar`) abriam sem a leitura do módulo.
 *
 * A regra: a conta tem acesso ao módulo quando ALGUMA concessão de equipe
 * (perfil de escopo total, de unidade ou agregado — não a do titular nem a do
 * `servidor_consulta`) lhe dá alguma permissão DO módulo
 * (`niveis_modulo.MODULOS_NIVELADOS`). Consequências:
 *
 * - "Sem acesso" no perfil ou na pessoa zera as permissões do módulo naquela
 *   concessão; sem outra concessão que as dê, o módulo some de toda a
 *   navegação e as telas dele guardadas por permissão transversal dão 403;
 * - duas concessões valem pela UNIÃO: se o técnico também é almoxarife e só o
 *   perfil de técnico está "Sem acesso" a EPI, o de almoxarife ainda dá o EPI
 *   (a exceção da PESSOA vale para todas as concessões dela);
 * - EXCEÇÃO consciente: o que é do titular (`rbac.PERMISSOES_DO_TITULAR` — a
 *   própria ficha de EPI, os próprios pedidos, treinamentos e certificados)
 *   continua no "Meu espaço" e no portal do servidor: é dele, e não do
 *   trabalho do módulo. Os próprios processos e o adicional, desde 25/10/2026,
 *   só com a exceção da pessoa em Processos SEI (`rbac.permissoes_do_titular`).
 *
 * Usada pelo menu lateral, pelo seletor de módulos, pelo mapa `/modulos`, pelo
 * despachante `/inicio` (`modulos.ts`) e pelas rotas (`exigir_acesso_ao_modulo`).
 * A home por módulos usa a mesma.
 */
import { PermissaoNegada } from "../nucleo/erros.js";
import { PERMISSAO_DA_BASE, modulo_nivelado, permissoes_do_modulo } from "./niveis_modulo.js";
import { EscopoNaoDeclarado, type UsuarioAtual } from "./rbac.js";

export function tem_acesso_ao_modulo(usuario: UsuarioAtual | null | undefined, codigo: string): boolean {
  if (!usuario) return false;
  const m = modulo_nivelado(codigo);
  // módulo sem permissão nenhuma (os previstos) não abre para ninguém
  if (!m) return false;
  const dele = permissoes_do_modulo(m).filter((p) => usuario.pode(p));
  if (!dele.length) return false;
  try {
    return usuario.pode_na_equipe(dele);
  } catch (erro) {
    // perfil sem escopo declarado: o menu não é a barreira (a consulta no
    // escopo nega com a tela que nomeia o perfil), como em `modulos._na_equipe`
    if (erro instanceof EscopoNaoDeclarado) return true;
    throw erro;
  }
}

/** A porta das telas do módulo guardadas por permissão transversal: 403 sem acesso ao módulo. */
export function exigir_acesso_ao_modulo(usuario: UsuarioAtual, codigo: string): void {
  if (tem_acesso_ao_modulo(usuario, codigo)) return;
  const nome = modulo_nivelado(codigo)?.nome ?? codigo;
  throw new PermissaoNegada(
    `modulo:${codigo}`,
    `A sua conta está sem acesso ao módulo ${nome}. O acesso por módulo se ajusta em Perfis (níveis por módulo) ou na conta, em Usuários.`,
  );
}

/**
 * A porta das telas da BASE (Servidores, Catálogos) para a equipe: a base
 * derivada (`niveis_modulo.PERMISSAO_DA_BASE`) por um perfil de equipe. Não é
 * de módulo nenhum: "Sem acesso" a Processos SEI não a fecha para quem trabalha
 * no EPI ou nos Certificados; fecha quando a concessão não dá módulo nenhum.
 */
export function exigir_a_base_na_equipe(usuario: UsuarioAtual): void {
  if (usuario.pode(PERMISSAO_DA_BASE) && usuario.pode_na_equipe(PERMISSAO_DA_BASE)) return;
  throw new PermissaoNegada(
    "processo.ver",
    "Esta tela é da base compartilhada (servidores e catálogos), que abre para quem trabalha num módulo " +
      "do setor. A sua conta não tem acesso a nenhum módulo que a sustente.",
  );
}
