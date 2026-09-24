/**
 * Monta um ambiente de teste com dados de mentira, para clicar à vontade.
 * Porte de `ferramentas/ambiente_teste_cli.py`.
 *
 *     npm run ambiente-teste                     # recria o banco do .env e povoa
 *     npm run ambiente-teste -- --permitir-remoto  # idem, num banco que não é localhost
 *
 * **O que mudou na nuvem.** No Python o ambiente de teste era OUTRA pasta
 * (`dados-teste/`, com banco SQLite próprio) e as três travas do isolamento eram
 * de disco. Aqui não há disco: o isolamento é o próprio banco do `.env`. A trava
 * que sobra é a que importa — recriar apaga TUDO, então a ferramenta recusa banco
 * que não esteja em localhost, a não ser que se peça com `--permitir-remoto`
 * (a instalação de homologação do Supabase, que só tem dado de teste — PORTE.md).
 *
 * **Por que passa pelos serviços.** Como no Python: numeração, contexto
 * congelado, máquinas de estado e a cadeia de auditoria moram nos serviços.
 * Onde não há serviço, imita-se a rota — inclusive o `auditoria.registrar`.
 *
 * TODO(porte): o Python povoa MUITO mais do que a base. Fica para quando os
 * serviços dos módulos estiverem portados (cada item abaixo depende deles):
 *   - portarias de localização e laudos (L1, L2, L3), laudo superado
 *     (`processo.marcar_laudo_superado`, cascata da RN-11);
 *   - processos em cada coluna do kanban, três fora do SLA (`servicos/processo`,
 *     `servicos/nup`), pareceres emitidos/assinados (`servicos/parecer`,
 *     `servicos/documento`), direito concedido (`servicos/direito`), anexos
 *     (`servicos/anexos`, PDF_FALSO);
 *   - EPI: itens, entradas de estoque, entregas e fichas, requisições em vários
 *     estados (`epi_estoque`, `epi_ficha`, `epi_requisicao`);
 *   - treinamentos, modelo de certificado com tags, assinaturas, turmas,
 *     inscrições, presença e certificados emitidos (`turma`, `participante`,
 *     `presenca`, `emissao_certificado`);
 *   - as sete demandas em todos os desfechos (`servicos/demandas`);
 *   - envelhecer pendências para o sino ter atrasadas (`servicos/pendencias`).
 * A lotação inicial dos servidores é gravada aqui imitando
 * `servidores.registrar_lotacao_inicial` (o serviço ainda não foi portado);
 * quando ele existir, troque o bloco pela chamada.
 */
import { pathToFileURL } from "node:url";
import { carregarEnvLocal } from "./env-local.js";

export const SENHA = "teste2026";
export const DOMINIO = "csso.teste";

// As contas: uma por perfil, para o dono trocar de login e ver a mesma tela
// mudar. O `servidor_consulta` fica ligado a um servidor porque sem isso o
// caminho do titular da LGPD (art. 18, II) não existe.
export const CONTAS: readonly (readonly [string, string, string])[] = [
  ["coordenador", "coordenador_csso", "Nádia Quintanilha Serra"],
  ["engenheiro", "engenheiro_seguranca", "Otávio Bengala Freire"],
  ["tecnico", "tecnico_seguranca", "Perpétua Andrade Lousã"],
  ["medico", "medico_trabalho", "Quirino Baptista Mesquita"],
  ["secretaria", "secretaria_csso", "Rosalina Teixeira Bopp"],
  ["almoxarife", "almoxarife_sesmt", "Salustiano Vidigal Prado"],
  ["admin", "admin_ti", "Tarcísio Werneck Aguiar"],
  ["servidor", "servidor_consulta", "Adelaide Nunes Prata"],
];

// (siape, nome, cargo, sigla da unidade, nome do posto ou null)
// Nomes, matrículas e lotações são inventados. Nenhum CPF, nenhuma condição de saúde.
export const SERVIDORES: readonly (readonly [string, string, string, string, string | null])[] = [
  ["3010011", "Adelaide Nunes Prata", "TECNICO DE LABORATORIO AREA", "FAMED", "Laboratório Escola de análises Clínicas (LEAC)"],
  ["3010022", "Bruno Sacramento Vilela", "TECNICO DE LABORATORIO AREA", "IECT", "Laboratório de Química"],
  ["3010033", "Cíntia Rebouças Amorim", "TECNICO EM ENFERMAGEM", "DODO", "Central de Esterilização de Materiais (CME)"],
  ["3010044", "Dagoberto Salles Fontoura", "TECNICO DE LABORATORIO AREA", "FAMMUC", "Laboratório de Agentes Patológicos (LAP)"],
  ["3010055", "Elisandra Toffoli Braga", "TECNICO DE LABORATORIO AREA", "ICA", "Laboratório de Química"],
  ["3010066", "Feliciano Duarte Amâncio", "Técnica de Laboratório / Zootecnia", "DZO", "Laboratório de Aquicultura, Ecologia Aquática e Limnologia"],
  ["3010077", "Gorete Vasconcelos Pimenta", "TECNICO DE LABORATORIO AREA", "FAMED", "Laboratório de Doenças Infecciosas e Parasitárias"],
  ["3010088", "Hamilton Peçanha Cordeiro", "ENGENHEIRO/AREA", "CSSO", null],
  ["3010099", "Iolanda Sampaio Rezende", "ASSISTENTE EM ADMINISTRACAO", "PROGEP", null],
  ["3010101", "Juvenal Ataíde Brandão", "AUXILIAR EM ADMINISTRACAO", "FCBS", null],
  ["3010112", "Kátia Lousada Ferrão", "ASSISTENTE EM ADMINISTRACAO", "FCA", null],
  ["3010123", "Lourival Bittencourt Sá", "TECNICO DE LABORATORIO AREA", "TESJAN", "Laboratório de Solos (teste)"],
];

export const CARGOS_EXTRA = [
  "ENGENHEIRO/AREA",
  "MEDICO/AREA",
  "TECNICO EM ENFERMAGEM",
  "ASSISTENTE EM ADMINISTRACAO",
  "AUXILIAR EM ADMINISTRACAO",
];

/** Só localhost, a não ser que se peça: recriar apaga o banco inteiro. */
export function bancoLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  } catch {
    return false;
  }
}

/** `date.today() - timedelta(days=n)` no dia de negócio. */
async function diasAtras(n: number): Promise<string> {
  const { hoje_iso, somar_dias } = await import("../src/dominio/datas.js");
  return somar_dias(hoje_iso(), -n);
}

/**
 * Povoa um banco JÁ migrado e semeado. Devolve o resumo impresso.
 * Recebe o executor (uma transação): quem chama decide quando confirmar.
 */
export async function povoar(tx: import("../src/db/cliente.js").Executor): Promise<Record<string, number>> {
  const { eq, and } = await import("drizzle-orm");
  const e = await import("../src/db/esquema/index.js");
  const autenticacao = await import("../src/servicos/autenticacao.js");
  const auditoria = await import("../src/servicos/auditoria.js");
  const rbac = await import("../src/servicos/rbac.js");

  const resumo: Record<string, number> = {};

  // -----------------------------------------------------------------
  // Contas, uma por perfil. O hash é um só para as oito: Argon2id de produção
  // custa ~80 ms, e a senha é a mesma (o sal repetido não importa em banco
  // descartável com a senha impressa na tela).
  // -----------------------------------------------------------------
  const hash = await autenticacao.gerar_hash(SENHA);
  for (const [login, codigo_perfil, nome] of CONTAS) {
    const [conta] = await tx
      .insert(e.usuario)
      .values({ login, nome, email: `${login}@${DOMINIO}`, senha_hash: hash, precisa_trocar_senha: false })
      .returning();
    const [perfil] = await tx.select().from(e.perfil).where(eq(e.perfil.codigo, codigo_perfil));
    await tx.insert(e.atribuicao).values({
      usuario_id: conta!.id,
      perfil_id: perfil!.id,
      vigencia_inicio: "2020-01-01",
      ato_normativo: "Ato de teste — ambiente descartável",
    });
  }
  resumo.contas = CONTAS.length;

  const atual = async (login: string) => {
    const [conta] = await tx.select().from(e.usuario).where(eq(e.usuario.login, login));
    return rbac.carregar_usuario_atual(tx, conta!.id);
  };

  // -----------------------------------------------------------------
  // Organização: o campus de Janaúba não tem unidade nos seeds; a que nasce
  // aqui é declaradamente de teste no próprio nome.
  // -----------------------------------------------------------------
  for (const nome of CARGOS_EXTRA) {
    const [existe] = await tx.select().from(e.cargo).where(eq(e.cargo.nome, nome));
    if (!existe) await tx.insert(e.cargo).values({ nome });
  }
  const [janauba] = await tx.select().from(e.campus).where(eq(e.campus.sigla, "JAN"));
  const [unidade_jan] = await tx
    .insert(e.unidade_uorg)
    .values({
      sigla: "TESJAN",
      nome_oficial: "UNIDADE DE TESTE DE JANAUBA",
      nome_extenso: "Unidade de Teste de Janaúba",
      tipo: "INSTITUTO",
      campus_id: janauba!.id,
      emite_portaria: true,
    })
    .returning();
  await tx
    .insert(e.posto_trabalho)
    .values({ unidade_uorg_id: unidade_jan!.id, nome: "Laboratório de Solos (teste)", sigla: "LSOL" });

  // -----------------------------------------------------------------
  // Servidores. A rota POST /servidores monta o `servidor`, audita
  // SERVIDOR_CRIADO e abre a lotação inicial — é o que se repete aqui.
  // -----------------------------------------------------------------
  const secretaria = await atual("secretaria");
  const inicio_lotacao = await diasAtras(900);
  for (const [siape, nome, cargo_nome, sigla_uorg, posto_nome] of SERVIDORES) {
    const [cargo] = await tx.select().from(e.cargo).where(eq(e.cargo.nome, cargo_nome));
    const [unidade] = await tx.select().from(e.unidade_uorg).where(eq(e.unidade_uorg.sigla, sigla_uorg));
    const [srv] = await tx
      .insert(e.servidor)
      .values({ siape, nome, cargo_id: cargo!.id, unidade_uorg_id: unidade!.id, email: null })
      .returning();
    await auditoria.registrar(tx, {
      entidade: "servidor",
      entidade_id: srv!.id,
      tipo_evento: "SERVIDOR_CRIADO",
      descricao: `Servidor SIAPE ${siape} cadastrado.`,
      usuario: secretaria,
    });
    // TODO(porte): `servidores.registrar_lotacao_inicial` quando for portado.
    const [lotacao] = await tx
      .insert(e.servidor_lotacao)
      .values({
        servidor_id: srv!.id,
        unidade_uorg_id: srv!.unidade_uorg_id,
        uorg_id: srv!.uorg_id,
        cargo_id: srv!.cargo_id,
        funcao: srv!.funcao,
        vigencia_inicio: inicio_lotacao,
        documento: "Portaria de teste",
        registrado_por: secretaria.id,
      })
      .returning();
    if (posto_nome) {
      const [posto] = await tx
        .select()
        .from(e.posto_trabalho)
        .where(and(eq(e.posto_trabalho.unidade_uorg_id, unidade!.id), eq(e.posto_trabalho.nome, posto_nome)));
      await tx.insert(e.lotacao_posto).values({ lotacao_id: lotacao!.id, posto_trabalho_id: posto!.id, ordem: 1 });
    }
  }
  resumo.servidores = SERVIDORES.length;

  // a conta `servidor` é a Adelaide: sem o vínculo o escopo próprio não acha nada
  const [adelaide] = await tx.select().from(e.servidor).where(eq(e.servidor.siape, "3010011"));
  await tx.update(e.usuario).set({ servidor_id: adelaide!.id }).where(eq(e.usuario.login, "servidor"));

  // -----------------------------------------------------------------
  // Habilitação técnica (IN 15/2022, art. 10, §2º, I). Sem uma habilitada
  // vigente ligada a uma CONTA, nenhum parecer se assina. A semeada (Fabrício)
  // fica intocada — as daqui são inventadas.
  // -----------------------------------------------------------------
  const habilitacoes: [string, string, string][] = [
    ["coordenador", "Eng. Seg. do Trabalho", "ENG_SEG_TRABALHO"],
    ["engenheiro", "Eng. Seg. do Trabalho", "ENG_SEG_TRABALHO"],
    ["medico", "Médico do Trabalho", "MED_TRABALHO"],
  ];
  for (const [login, titulo, habilitacao] of habilitacoes) {
    const [conta] = await tx.select().from(e.usuario).where(eq(e.usuario.login, login));
    await tx.insert(e.profissional_habilitado).values({
      usuario_id: conta!.id,
      nome: conta!.nome,
      habilitacao,
      titulo_assinatura: titulo,
      conselho: habilitacao === "ENG_SEG_TRABALHO" ? "CREA" : "CRM",
      registro_conselho: "MG-000000",
      vigencia_inicio: "2020-01-01",
    });
  }
  resumo.habilitacoes = habilitacoes.length;

  return resumo;
}

/** Apaga o banco inteiro (esquemas `public` e `drizzle`), migra e semeia. */
export async function recriar(url: string): Promise<void> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  } finally {
    await sql.end({ timeout: 5 });
  }
  const { migrarBanco } = await import("../src/db/migrar.js");
  await migrarBanco(url);
}

async function principal(argv: string[]): Promise<number> {
  carregarEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL ausente.");
    return 1;
  }
  if (!bancoLocal(url) && !argv.includes("--permitir-remoto")) {
    console.error(
      "ERRO: o banco do .env não está em localhost, e recriar APAGA TUDO. " +
        "Se é mesmo a instalação de homologação (só dado de teste), repita com --permitir-remoto.",
    );
    return 2;
  }
  console.log("Montando o ambiente de teste (banco recriado, dados de mentira)...");
  await recriar(url);
  const { obterBanco, fecharBanco } = await import("../src/db/cliente.js");
  const { semear } = await import("../src/servicos/sementes.js");
  let resumo: Record<string, number>;
  try {
    resumo = await obterBanco(url).transaction(async (tx) => {
      await semear(tx);
      return povoar(tx);
    });
  } finally {
    await fecharBanco();
  }
  const porta = process.env.PORTA ?? "8766";
  console.log();
  console.log("=".repeat(66));
  console.log(" AMBIENTE DE TESTE PRONTO");
  console.log("=".repeat(66));
  console.log(`  Endereço:  http://localhost:${porta}/   (npm run dev)`);
  console.log(`  Banco:     ${url.replace(/:[^:@/]*@/, ":***@")}`);
  console.log();
  console.log("  O que foi criado:");
  for (const chave of Object.keys(resumo).sort()) {
    console.log(`    ${chave.replaceAll("_", " ").padEnd(24)} ${resumo[chave]}`);
  }
  console.log();
  console.log(`  Senha de TODAS as contas: ${SENHA}`);
  console.log("  Contas (entre por qualquer uma e veja a tela mudar):");
  for (const [login, perfil, nome] of CONTAS) {
    console.log(`    ${login.padEnd(14)} ${perfil.padEnd(22)} ${nome}`);
  }
  console.log();
  console.log("  Ainda NÃO povoado (serviços dos módulos por portar): processos, pareceres,");
  console.log("  laudos, EPI, treinamentos, demandas, pendências — ver o TODO no cabeçalho.");
  console.log("=".repeat(66));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await principal(process.argv.slice(2)));
}
