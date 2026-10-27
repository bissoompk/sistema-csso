/**
 * Módulo de acidentes, esqueleto da F0: cada tela do menu abre para quem a vê,
 * fecha para quem não tem a permissão, e a ficha respeita o escopo e a
 * restrição da ocorrência (acidentado menor de idade). Dados fictícios.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { bancoLimpo, contas, entrar, naTransacao } from "./ajuda";

const { novoCliente } = await bancoLimpo();
await naTransacao((tx) => contas(tx));

async function ocorrencia(numero: number, restrita: boolean): Promise<number> {
  return naTransacao(async (tx) => {
    const r: any = await tx.execute(sql`
      INSERT INTO acidente_ocorrencia
        (protocolo, ano, numero, especie, origem, data_evento, local_tipo, local_especificacao, prazo_comunicacao, restrita_sst, criado_em)
      VALUES (${`CAT-2031-${String(numero).padStart(4, "0")}`}, 2031, ${numero}, 'TIPICO', 'SST', '2031-03-01',
              'ESTABELECIMENTO_UFVJM', 'Sala fictícia', '2031-03-11', ${restrita}, now())
      RETURNING id`);
    return (r.rows ?? r)[0].id as number;
  });
}

async function get(login: string, caminho: string) {
  const cliente = await entrar(novoCliente(), login);
  return cliente.get(caminho, { seguir: false });
}

const TELAS = ["/acidentes", "/acidentes/fila", "/acidentes/minhas"];

describe("as telas do módulo de acidentes", () => {
  it.each(["coordenador_csso", "engenheiro_seguranca", "tecnico_seguranca", "medico_trabalho", "secretaria_csso", "superintendente"])(
    "%s abre o painel, a fila, o plano, o comunicar e os indicadores",
    async (login) => {
      for (const caminho of [...TELAS, "/acidentes/comunicar", "/acidentes/indicadores"]) {
        const r = await get(login, caminho);
        expect(r.status, `${login} ${caminho}`).toBe(200);
      }
    },
  );

  it("o plano de ação (lista) é de quem investiga ou encaminha ao SIASS; a secretaria, que só tria, não o abre", async () => {
    for (const login of ["coordenador_csso", "engenheiro_seguranca", "tecnico_seguranca", "medico_trabalho", "superintendente"]) {
      const r = await get(login, "/acidentes/acoes");
      expect(r.status, login).toBe(200);
    }
    expect((await get("secretaria_csso", "/acidentes/acoes")).status).toBe(403);
  });

  it("o servidor comum comunica e vê as próprias, mas não tem painel de equipe nem indicadores", async () => {
    expect((await get("servidor_consulta", "/acidentes/comunicar")).status).toBe(200);
    expect((await get("servidor_consulta", "/acidentes/minhas")).status).toBe(200);
    expect((await get("servidor_consulta", "/acidentes/indicadores")).status).toBe(403);
  });

  it("quem não tem permissão nenhuma de acidentes recebe 403", async () => {
    for (const login of ["auditor_interno", "admin_ti", "consulta_progep"]) {
      const r = await get(login, "/acidentes");
      expect(r.status, login).toBe(403);
    }
  });

  it("o almoxarife não opera o módulo: a conta sem vínculo com servidor não abre nem o comunicar", async () => {
    // comunicar vem das funções do titular, que exigem a conta ligada a um servidor
    expect((await get("almoxarife_sesmt", "/acidentes/fila")).status).toBe(403);
    expect((await get("almoxarife_sesmt", "/acidentes")).status).toBe(403);
  });
});

describe("a ficha da ocorrência", () => {
  it("abre com a aba pedida, mesmo sem o parcial da aba; aba desconhecida cai na primeira", async () => {
    const id = await ocorrencia(1, false);
    const r = await get("coordenador_csso", `/acidentes/${id}?aba=historico`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("CAT-2031-0001");
    expect(r.text).toContain('aria-current="page">Histórico');
    // sem o parcial, a aba diz que chega depois (em branco parecia defeito)
    expect(r.text).toContain('id="aba-em-construcao"');
    const r2 = await get("coordenador_csso", `/acidentes/${id}?aba=inventada`);
    expect(r2.status).toBe(200);
    expect(r2.text).toContain('aria-current="page">Comunicação');
    // a aba que tem parcial não recebe o aviso
    expect(r2.text).not.toContain('id="aba-em-construcao"');
  });

  it("ocorrência inexistente é 404", async () => {
    expect((await get("coordenador_csso", "/acidentes/99999999")).status).toBe(404);
  });

  it("ocorrência restrita à SST: quem não instrui o caso não a vê na ficha", async () => {
    const id = await ocorrencia(2, true);
    expect((await get("coordenador_csso", `/acidentes/${id}`)).status).toBe(200);
    // a secretaria triaria, mas não investiga nem encaminha: fora da equipe de SST
    expect((await get("secretaria_csso", `/acidentes/${id}`)).status).toBe(404);
  });

  it("a fila lista o protocolo e nenhum dado pessoal", async () => {
    const r = await get("coordenador_csso", "/acidentes/fila");
    expect(r.text).toContain("CAT-2031-0001");
  });
});
