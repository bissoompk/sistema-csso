/**
 * M84 — a permissão vem ANTES do formulário, em toda rota que escreve.
 *
 * O defeito (D77 e os relatos repetidos dele): várias rotas POST validavam os
 * campos ou consultavam o banco antes de conferir a permissão, e respondiam
 * 422 "Campo obrigatório ausente: nome, cidade" ou um 303 com "preencha o
 * campo" a quem nem tinha acesso — ensinando o formato da rota e sugerindo
 * "preencha e tente de novo". A regra: `usuario.exigir(...)` (ou
 * `usuarioCom`) na primeira linha do handler.
 *
 * A tabela de rotas não é escrita à mão: sai de `app.routes`, então rota POST
 * nova entra aqui sozinha. Cada uma é chamada com o CORPO VAZIO por uma conta
 * sem permissão nenhuma — e por perfis reais que têm algumas permissões e não
 * a da rota — e tem de dar 403. Ficam de fora só as rotas que, por desenho,
 * não pedem permissão de RBAC (públicas ou de qualquer sessão), cada uma com
 * o motivo escrito.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { MATRIZ_PERFIS } from "../src/servicos/rbac";
import { PERMISSOES_VER as PERMISSOES_VER_PENDENCIAS } from "../src/servicos/pendencias";
import { bancoLimpo, contas, criarUsuario, entrar, PERFIS_DE_TESTE, type AmbienteDeTeste, type Cliente } from "./ajuda";

let amb: AmbienteDeTeste;

/**
 * Rotas POST que não exigem permissão de RBAC, e por quê. Prefixo de caminho
 * (o padrão do Hono, com `:param`).
 */
export const SEM_PERMISSAO_DE_RBAC: readonly (readonly [string, string])[] = [
  ["/login", "é a entrada: anterior à sessão"],
  ["/sair", "qualquer sessão sai"],
  ["/primeiro-acesso", "bootstrap da instalação: só sem conta nenhuma e na própria máquina"],
  ["/trocar-senha", "qualquer sessão troca a própria senha"],
  ["/minha-conta", "qualquer sessão cuida da própria conta (contato, e-mail com a senha atual, sessões); nunca de outra"],
  ["/inscricao/", "inscrição pública pelo link da turma"],
  ["/acidente/", "comunicação de acidente pelo link do setor, sem conta (F2 do módulo de acidentes)"],
  ["/validar", "validação pública do certificado"],
  ["/acesso-participante", "acesso do participante externo pelo link do e-mail"],
  ["/participante", "acesso do participante externo pelo link do e-mail"],
  ["/ativar-acesso", "o servidor ativa o acesso ou redefine a senha pelo link do e-mail do cadastro, sem conta"],
  ["/certificados/acesso", "o participante externo pede o link de acesso pelo e-mail, sem conta"],
  ["/cadastre-se", "o terceirizado ou discente pede a conta, sem conta; nada nasce antes da conferência da equipe"],
  ["/esqueci-senha", "qualquer conta pede o link de redefinição pelo e-mail, sem sessão"],
  ["/avaliacao/", "o participante responde a avaliação de reação pelo link de uso único do e-mail, sem conta; o token é a autorização"],
];

/**
 * Rotas que aceitam QUALQUER UMA de várias permissões: a recusa cita só a
 * primeira, e o perfil que tem outra da lista passa com razão. Para elas,
 * "sem a permissão" é não ter nenhuma.
 */
export const ALTERNATIVAS: Readonly<Record<string, readonly string[]>> = {
  "/pendencias/:pendencia_id{[0-9]+}/concluir": PERMISSOES_VER_PENDENCIAS,
  "/epis/requisicoes/:requisicao_id{[0-9]+}/itens/:linha_id{[0-9]+}/cancelar": ["epi.requisitar", "epi.analisar"],
  "/usuarios/:id{[0-9]+}/senha": ["perfil.conceder", "usuario.resetar_senha"],
};

function isenta(caminho: string): boolean {
  return SEM_PERMISSAO_DE_RBAC.some(([prefixo]) => caminho === prefixo || caminho.startsWith(prefixo));
}

/**
 * `/catalogos/campi/:id{[0-9]+}` -> `/catalogos/campi/1`; parâmetro de
 * alternativas (`:acao{tentar|cancelar}`) recebe a primeira delas.
 */
function concreto(caminho: string): string {
  return caminho.replace(/:[a-z_]+(\{([^}]*)\})?/g, (_t, _r, regex: string | undefined) => {
    const palavra = regex && /^[a-z_]+(\|[a-z_]+)*$/.test(regex) ? regex.split("|")[0]! : "1";
    return palavra;
  });
}

function rotas_post(): string[] {
  const vistas = new Set<string>();
  for (const r of amb.app.routes) {
    if (r.method !== "POST") continue;
    if (r.path.startsWith("/api/")) continue; // a API tem o próprio teste de 401/403 (api.test.ts)
    vistas.add(r.path);
  }
  return [...vistas].sort();
}

let sem_perfil: Cliente;

beforeAll(async () => {
  amb = await bancoLimpo();
  await contas(amb.db);
  await criarUsuario(amb.db, { login: "sem_perfil", nome: "Conta sem perfil" });
  sem_perfil = await entrar(amb.novoCliente(), "sem_perfil");
});

describe("M84: toda rota POST nega antes de ler o formulário", () => {
  it("a lista de rotas não está vazia (a tabela é de verdade)", () => {
    expect(rotas_post().length).toBeGreaterThan(50);
  });

  it("conta sem perfil: 403 com o corpo vazio, em toda rota POST", async () => {
    const falhas: string[] = [];
    for (const caminho of rotas_post()) {
      if (isenta(caminho)) continue;
      const r = await sem_perfil.post(concreto(caminho), {}, { seguir: false });
      if (r.status !== 403) falhas.push(`${caminho} -> ${r.status} ${r.text.replace(/\s+/g, " ").slice(0, 90)}`);
    }
    expect(falhas, falhas.join("\n")).toEqual([]);
  }, 300_000);

  /**
   * A tabela rota × perfil: a permissão que cada rota exige sai da própria
   * recusa da conta sem perfil (a tela de 403 diz qual falta), e cada perfil
   * real que NÃO a tem — mas tem outras, que é o caso do D77: a secretaria
   * com `processo.ver` no catálogo — recebe 403 com o corpo vazio.
   */
  it("perfil sem a permissão da rota: 403 com o corpo vazio, e não 422 nem 303", async () => {
    const exigida = new Map<string, string>();
    for (const caminho of rotas_post()) {
      if (isenta(caminho)) continue;
      const r = await sem_perfil.post(concreto(caminho), {}, { seguir: false });
      const codigo =
        /qual\s+permissão\s+falta:\s*<code>([^<]+)<\/code>/.exec(r.text)?.[1] ??
        /Permissão necessária: ([a-z_.]+)/.exec(r.text)?.[1];
      if (r.status === 403 && codigo) exigida.set(caminho, codigo);
    }
    expect(exigida.size).toBeGreaterThan(50);

    const falhas: string[] = [];
    for (const [perfil] of PERFIS_DE_TESTE) {
      const cliente = await entrar(amb.novoCliente(), perfil);
      const tem = new Set(MATRIZ_PERFIS[perfil]!.permissoes);
      for (const [caminho, codigo] of exigida) {
        if ((ALTERNATIVAS[caminho] ?? [codigo]).some((p) => tem.has(p))) continue;
        const r = await cliente.post(concreto(caminho), {}, { seguir: false });
        if (r.status !== 403) {
          falhas.push(`${perfil} sem ${codigo}: ${caminho} -> ${r.status} ${r.text.replace(/\s+/g, " ").slice(0, 80)}`);
        }
      }
    }
    expect(falhas, falhas.join("\n")).toEqual([]);
  }, 600_000);
});
