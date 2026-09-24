/**
 * A trilha encadeada. Porte de `testes/integracao/test_auditoria_integridade.py`
 * e da parte de serviço de `test_concorrencia_auditoria.py` (a janela, o passe
 * completo, uma conferência por vez), mais o que o PostgreSQL trouxe de novo:
 * duas transações gravando ao mesmo tempo não podem bifurcar a cadeia.
 *
 * Os testes de TELA do Python (`/auditoria`, o botão, a rotina de linha de
 * comando) entram com a rota de auditoria.
 */
import postgres from "postgres";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

// duas transações simultâneas precisam de duas conexões (o padrão é uma)
process.env.CSSO_POOL_MAX = "6";

import { bancoLimpo, criarUsuario, naTransacao } from "./ajuda";
import * as auditoria from "../src/servicos/auditoria";
import * as esquema from "../src/db/esquema/index";
import { UsuarioAtual } from "../src/servicos/rbac";
import type { Executor } from "../src/db/cliente";

const { db, url } = await bancoLimpo();

// Texto que o JSON relê como outra coisa. Nenhum é hipotético.
const TEXTO_AMBIGUO = ["50.00", "100.00", "1110654", "250", "0", "1.5e3", "true", "false", "null", "NaN", "[1, 2]", '{"a": 1}', '"aspas"'];

// O que o sistema grava hoje, por tipo (Decimal e date do Python já chegam
// como texto aqui: numeric vem do driver como string, date é 'AAAA-MM-DD').
const VALOR_LEGITIMO: unknown[] = [
  null,
  "",
  "Marco Antônio Alves Schetino",
  "TECNICO DE LABORATORIO AREA",
  "2026-01-01",
  "007",
  "None",
  12,
  1.5,
  true,
  false,
  "50.00",
  new Date(Date.UTC(2026, 0, 1)),
  { numero: 1, ano: 2026 },
  [1, 2, 3],
  { "ç": ["ã", { b: null, a: 0.1 }], "a b": "x\ny\t\"z\"" },
];

async function registrar(tx: Executor, valor: unknown) {
  return auditoria.registrar(tx, {
    entidade: "servidor",
    entidade_id: 1,
    tipo_evento: "CAMPO_ALTERADO",
    descricao: "conferência de integridade",
    campo: "siape",
    valor_anterior: valor,
    valor_novo: valor,
  });
}

/** Esvazia a trilha (por fora da trava de append-only, só no banco de teste). */
async function esvaziar() {
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`
      ALTER TABLE historico_evento DISABLE TRIGGER USER;
      DELETE FROM historico_evento; DELETE FROM conferencia_cadeia;
      ALTER TABLE historico_evento ENABLE TRIGGER USER;`);
  } finally {
    await admin.end();
  }
}

/**
 * Reescreve um evento por fora do sistema, como quem tem o banco na mão: a
 * trava de UPDATE (CA-16) protege quem passa PELO sistema; o encadeamento
 * existe para pegar quem derruba a trava.
 */
async function adulterar(evento_id: number, campos: Record<string, string>) {
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await admin.begin(async (t) => {
      await t.unsafe("ALTER TABLE historico_evento DISABLE TRIGGER trg_historico_sem_update");
      for (const [k, v] of Object.entries(campos)) {
        await t.unsafe(`UPDATE historico_evento SET ${k} = $1 WHERE id = $2`, [v, evento_id]);
      }
      await t.unsafe("ALTER TABLE historico_evento ENABLE TRIGGER trg_historico_sem_update");
    });
  } finally {
    await admin.end();
  }
}

async function encher(quantos: number) {
  await naTransacao(async (tx) => {
    for (let n = 0; n < quantos; n++) {
      await auditoria.registrar(tx, {
        entidade: "servidor",
        entidade_id: 1,
        tipo_evento: "CAMPO_ALTERADO",
        descricao: `evento de carga ${n}`,
        campo: "siape",
        valor_anterior: `${n}`,
        valor_novo: `${n + 1}`,
      });
    }
  });
}

async function ids(): Promise<number[]> {
  return (await db.select({ id: esquema.historico_evento.id }).from(esquema.historico_evento).orderBy(esquema.historico_evento.id)).map(
    (l) => l.id,
  );
}

afterEach(async () => {
  auditoria._instrumentos.digerir = auditoria._digerir;
  await esvaziar();
});

describe("a prova de integridade não depende do tipo gravado", () => {
  it.each(TEXTO_AMBIGUO)("texto que o JSON relê diferente não quebra a cadeia: %s", async (valor) => {
    await naTransacao((tx) => registrar(tx, valor));
    const [ok, defeito] = await auditoria.cadeia_integra(db);
    expect(ok, `cadeia acusada no evento ${defeito} por gravar ${valor}`).toBe(true);
  });

  it.each(TEXTO_AMBIGUO)("texto ambíguo volta do banco como texto: %s", async (valor) => {
    const evento = await naTransacao((tx) => registrar(tx, valor));
    const [relido] = await db.select().from(esquema.historico_evento).where(eq(esquema.historico_evento.id, evento.id));
    expect(relido!.valor_anterior).toBe(valor);
    expect(relido!.valor_novo).toBe(valor);
    // e dentro de relação (`with:`), onde o Drizzle parseia a linha agregada
    const pelo_relacional = await db.query.historico_evento.findFirst({ where: eq(esquema.historico_evento.id, evento.id) });
    expect(pelo_relacional!.valor_novo).toBe(valor);
  });

  it.each(VALOR_LEGITIMO.map((v) => [v]))("a trava aceita o que o sistema grava hoje: %o", async (valor) => {
    await naTransacao((tx) => registrar(tx, valor));
    const [ok, defeito] = await auditoria.cadeia_integra(db);
    expect(ok, `cadeia rompida no evento ${defeito}`).toBe(true);
  });

  it("valor nulo é NULL na coluna, não JSON null", async () => {
    const evento = await naTransacao((tx) => registrar(tx, null));
    const [linha] = await db.execute<{ nulo: boolean }>(
      sql`SELECT valor_novo IS NULL AS nulo FROM historico_evento WHERE id = ${evento.id}`,
    );
    expect(linha!.nulo).toBe(true);
  });

  it("instante vira texto na forma do str(datetime) do Python, e volta assim", async () => {
    const evento = await naTransacao((tx) => registrar(tx, new Date(Date.UTC(2026, 0, 1, 12, 30))));
    expect(evento.valor_novo).toBe("2026-01-01 12:30:00+00:00");
  });

  it("a trava recusa gravação que o banco não devolveria igual", async () => {
    // o atalho antigo do JSONTexto de volta: string ia crua, sem aspas de JSON
    const original = auditoria._TIPO_DO_VALOR.ida;
    auditoria._TIPO_DO_VALOR.ida = (v: unknown) => (typeof v === "string" ? v : original(v));
    try {
      await expect(naTransacao((tx) => registrar(tx, "50.00"))).rejects.toThrow(/valor_anterior/);
      await expect(naTransacao((tx) => registrar(tx, "50.00"))).rejects.toBeInstanceOf(auditoria.ValorNaoAuditavel);
    } finally {
      auditoria._TIPO_DO_VALOR.ida = original;
    }
    expect(await ids()).toEqual([]);
  });

  it("NaN, Infinity e \\u0000 não entram (o jsonb não os devolveria)", async () => {
    for (const v of [NaN, Infinity, "a\u0000b", { x: NaN }]) {
      await expect(naTransacao((tx) => registrar(tx, v))).rejects.toBeInstanceOf(auditoria.ValorNaoAuditavel);
    }
  });
});

describe("a serialização canônica é a do json.dumps do Python", () => {
  it("chaves ordenadas, separadores do Python, sem escapar acento", () => {
    expect(auditoria.corpo({ b: 1, a: [1, "ç"], c: null })).toBe('{"a": [1, "ç"], "b": 1, "c": null}');
    expect(auditoria.corpo("aspas \" e \\ e \n")).toBe('"aspas \\" e \\\\ e \\n"');
    expect(auditoria.corpo(1.5)).toBe("1.5");
    expect(auditoria.corpo(1e-7)).toBe("1e-07");
    expect(auditoria.corpo(1e20)).toBe("1e+20");
    expect(auditoria.corpo(true)).toBe("true");
  });

  it("isoformat é o do Python", () => {
    expect(auditoria.isoformat(new Date(Date.UTC(2025, 1, 11, 9, 5, 7)))).toBe("2025-02-11T09:05:07+00:00");
    expect(auditoria.isoformat(new Date(Date.UTC(2025, 1, 11, 9, 5, 7, 120)))).toBe("2025-02-11T09:05:07.120000+00:00");
  });

  it("o digest confere com o calculado pelo Python para o mesmo evento", () => {
    // json.dumps({...}, ensure_ascii=False, sort_keys=True, default=str) +
    // sha256 — calculado no Python 3.12 com os mesmos valores
    const evento = {
      entidade: "servidor",
      entidade_id: 1,
      tipo_evento: "CAMPO_ALTERADO",
      descricao: "siape: '1110654' -> '1110655'",
      campo: "siape",
      valor_anterior: "1110654",
      valor_novo: "1110655",
      usuario_nome: "Coordenador de Teste",
      ocorrido_em: new Date(Date.UTC(2026, 8, 24, 12, 0, 0)),
    };
    expect(auditoria._digerir(evento, null)).toBe("a0035cf890344ac2165dcd96f49053b6801c486756cf4fb3c980e427f03d17b6");
    const outro = {
      entidade: "servidor",
      entidade_id: 1,
      tipo_evento: "X",
      descricao: 'ç "q"\n',
      campo: null,
      valor_anterior: { b: [1, 2.5, null], a: true },
      valor_novo: 0.1,
      usuario_nome: "sistema",
      ocorrido_em: new Date(Date.UTC(2026, 8, 24, 12, 0, 0, 120)),
    };
    expect(auditoria._digerir(outro, "ab".repeat(32))).toBe("4c78c5b1ecea7d246dc51f0313b152af1ad104f56cc407c501acba6233191fe2");
  });
});

describe("registrar e registrar_diferencas", () => {
  it("encadeia: cada hash_anterior é o hash_atual do anterior", async () => {
    await encher(5);
    const linhas = await db.select().from(esquema.historico_evento).orderBy(esquema.historico_evento.id);
    expect(linhas[0]!.hash_anterior).toBeNull();
    for (let i = 1; i < linhas.length; i++) expect(linhas[i]!.hash_anterior).toBe(linhas[i - 1]!.hash_atual);
    expect(await auditoria.cadeia_integra(db)).toEqual([true, null]);
  });

  it("rn14: cada campo alterado vira um evento, com o repr do Python na descrição", async () => {
    const eventos = await naTransacao((tx) =>
      auditoria.registrar_diferencas(tx, {
        entidade: "servidor",
        entidade_id: 3,
        antes: { siape: "1110654", nome: "A", situacao: "ATIVO" },
        depois: { siape: "1110655", nome: "A", email: "a@b" },
        usuario: null,
      }),
    );
    expect(eventos.map((e) => e.campo)).toEqual(["email", "siape", "situacao"]);
    expect(eventos.map((e) => e.descricao)).toEqual([
      "email: None -> 'a@b'",
      "siape: '1110654' -> '1110655'",
      "situacao: 'ATIVO' -> None",
    ]);
    expect(eventos[0]!.usuario_nome).toBe("sistema");
  });

  it("duas transações gravando ao mesmo tempo não bifurcam a cadeia", async () => {
    // no SQLite o escritor era um só; no PostgreSQL a trava de transação faz
    // esse papel — sem ela, as duas leriam o mesmo "anterior"
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        db.transaction(async (tx) => {
          for (let k = 0; k < 5; k++) {
            await auditoria.registrar(tx, {
              entidade: "servidor",
              entidade_id: i,
              tipo_evento: "COMENTARIO",
              descricao: `concorrente ${i}.${k}`,
            });
            await new Promise((r) => setTimeout(r, 1));
          }
        }),
      ),
    );
    expect((await ids()).length).toBe(30);
    expect(await auditoria.cadeia_integra(db)).toEqual([true, null]);
  });
});

describe("conferir o encadeamento (Q-2)", () => {
  it("a janela confere também com filtro (eventos que não são vizinhos)", async () => {
    await naTransacao(async (tx) => {
      for (let n = 0; n < 30; n++) {
        await auditoria.registrar(tx, {
          entidade: n % 2 ? "servidor" : "processo",
          entidade_id: 1,
          tipo_evento: "CAMPO_ALTERADO",
          descricao: `alternado ${n}`,
        });
      }
    });
    let chamadas = 0;
    auditoria._instrumentos.digerir = (e, a) => {
      chamadas++;
      return auditoria._digerir(e, a);
    };
    const so_processo = await db
      .select()
      .from(esquema.historico_evento)
      .where(eq(esquema.historico_evento.entidade, "processo"));
    expect(await auditoria.janela_integra(db, so_processo)).toEqual([true, null]);
    expect(chamadas).toBe(so_processo.length);
  });

  it("a janela acusa o evento adulterado que ela exibe", async () => {
    await encher(10);
    const alvo = (await ids()).at(-1)!;
    await adulterar(alvo, { descricao: "reescrito por fora do sistema" });
    const janela = await db.select().from(esquema.historico_evento);
    expect(await auditoria.janela_integra(db, janela)).toEqual([false, alvo]);
  });

  it("a janela acusa o elo trocado, e não só o corpo", async () => {
    await encher(6);
    const todos = await ids();
    const [alvo, seguinte] = [todos[2]!, todos[3]!];
    await adulterar(alvo, { descricao: "reescrito com digest novo", hash_atual: "0".repeat(64) });
    const so_o_seguinte = await db.select().from(esquema.historico_evento).where(eq(esquema.historico_evento.id, seguinte));
    expect(await auditoria.janela_integra(db, so_o_seguinte)).toEqual([false, seguinte]);
  });

  it("o passe completo conferiu a trilha inteira", async () => {
    await encher(25);
    const resultado = await naTransacao((tx) => auditoria.conferir_fora_da_transacao(tx, { origem: auditoria.ORIGEM_ROTINA }));
    const todos = await ids();
    expect(resultado.eventos).toBe(todos.length);
    expect(resultado.ultimo_evento_id).toBe(Math.max(...todos));
    expect(resultado.integra).toBe(true);
    expect(resultado.primeiro_defeito_id).toBeNull();
    expect(resultado.origem).toBe("ROTINA");
    expect(resultado.usuario_id).toBeNull();
    expect((await naTransacao((tx) => auditoria.ultima_conferencia(tx)))!.id).toBe(resultado.id);
  });

  it("o passe completo aponta o defeito e conta até ali", async () => {
    await encher(12);
    const todos = await ids();
    const alvo = todos[4]!;
    await adulterar(alvo, { descricao: "reescrito por fora do sistema" });
    const resultado = await naTransacao((tx) => auditoria.conferir_fora_da_transacao(tx, { origem: auditoria.ORIGEM_ROTINA }));
    expect(resultado.integra).toBe(false);
    expect(resultado.primeiro_defeito_id).toBe(alvo);
    expect(resultado.eventos).toBe(todos.indexOf(alvo) + 1);
  });

  it("o passe completo lê em lotes (mais de um lote de 1000)", async () => {
    await encher(1205);
    const resultado = await naTransacao((tx) => auditoria.conferir_fora_da_transacao(tx));
    expect(resultado.eventos).toBe(1205);
    expect(resultado.integra).toBe(true);
  });

  it("uma conferência por vez: o segundo clique é recusado, e a trava não fica presa", async () => {
    await encher(20);
    let entrou!: () => void;
    const dentro = new Promise<void>((r) => (entrou = r));
    let soltar!: () => void;
    const pode_seguir = new Promise<void>((r) => (soltar = r));
    let primeira = true;
    auditoria._instrumentos.digerir = (e, a) => {
      if (primeira) {
        primeira = false;
        entrou();
      }
      return auditoria._digerir(e, a);
    };
    const lenta = db.transaction(async (tx) => {
      const r = await auditoria.conferir_fora_da_transacao(tx);
      await pode_seguir; // segura a transação (e a trava) aberta
      return r;
    });
    await dentro;
    await expect(naTransacao((tx) => auditoria.conferir_fora_da_transacao(tx))).rejects.toBeInstanceOf(
      auditoria.ConferenciaEmCurso,
    );
    soltar();
    expect((await lenta).integra).toBe(true);
    expect((await naTransacao((tx) => auditoria.conferir_fora_da_transacao(tx))).integra).toBe(true);
  });

  it("o botão tem dono", async () => {
    const conta = await criarUsuario(db, { login: `auditor_${Date.now()}`, perfis: ["auditor_interno"] });
    const u = new UsuarioAtual({ id: conta.id, login: conta.login, nome: conta.nome, permissoes: [], perfis: [] });
    const r = await naTransacao((tx) => auditoria.conferir_fora_da_transacao(tx, { usuario: u }));
    expect(r.origem).toBe("BOTAO");
    expect(r.usuario_id).toBe(conta.id);
  });

  it("nada em src/ chama cadeia_integra (só janela_integra e o passe completo)", () => {
    const infratores: string[] = [];
    const varrer = (dir: string) => {
      for (const nome of readdirSync(dir)) {
        const p = path.join(dir, nome);
        if (statSync(p).isDirectory()) varrer(p);
        else if (p.endsWith(".ts") && !p.endsWith(path.join("servicos", "auditoria.ts"))) {
          if (/\bcadeia_integra\s*\(/.test(readFileSync(p, "utf8"))) infratores.push(p);
        }
      }
    };
    varrer(path.resolve(__dirname, "../src"));
    expect(infratores).toEqual([]);
  });
});

describe("rótulo do evento", () => {
  it("o recuo humaniza e nunca devolve o código cru", () => {
    expect(auditoria.rotulo_evento("PROCESSO_CRIADO")).toBe("Processo criado");
    expect(auditoria.rotulo_evento("EVENTO_QUE_NAO_EXISTE")).toBe("Evento que nao existe");
    expect(auditoria.rotulo_evento(null)).toBe("—");
    expect(auditoria.rotulo_evento("")).toBe("—");
    expect(auditoria.rotulo_evento("toString")).toBe("Tostring");
  });

  it("todo evento que o sistema grava tem rótulo (varre o Python de referência e o src/)", () => {
    const emitidos = new Set<string>();
    const constantes = new Map<string, string>();
    const varrer = (dir: string, ext: string) => {
      for (const nome of readdirSync(dir)) {
        const p = path.join(dir, nome);
        if (statSync(p).isDirectory()) varrer(p, ext);
        else if (p.endsWith(ext)) {
          const t = readFileSync(p, "utf8");
          for (const m of t.matchAll(/^\s*(?:export const )?([A-Z][A-Z0-9_]+)\s*=\s*["']([A-Z][A-Z0-9_]+)["']/gm)) {
            constantes.set(m[1]!, m[2]!);
          }
          for (const m of t.matchAll(/tipo_evento\s*[=:]\s*(?:\w+\.)?(["']([A-Z][A-Z0-9_]+)["']|([A-Z][A-Z0-9_]+)\b)/g)) {
            emitidos.add(m[2] ?? `@${m[3]}`);
          }
        }
      }
    };
    varrer(path.resolve(__dirname, "../../app"), ".py");
    varrer(path.resolve(__dirname, "../src"), ".ts");
    const resolvidos = [...emitidos].map((e) => (e.startsWith("@") ? constantes.get(e.slice(1)) : e)).filter(Boolean) as string[];
    expect(resolvidos.length).toBeGreaterThan(20);
    expect(resolvidos.filter((e) => !(e in auditoria.ROTULO_EVENTO))).toEqual([]);
  });
});

describe("registro de leitura (RN-23)", () => {
  it("leitura de terceiro: servidor nulo não conta; titular não é terceiro", () => {
    const equipe = new UsuarioAtual({ id: 1, login: "a", nome: "A", permissoes: [], perfis: [] });
    const titular = new UsuarioAtual({ id: 2, login: "b", nome: "B", permissoes: [], perfis: [], servidor_id: 9 });
    expect(auditoria.leitura_de_terceiro(equipe, null)).toBe(false);
    expect(auditoria.leitura_de_terceiro(equipe, 9)).toBe(true);
    expect(auditoria.leitura_de_terceiro(titular, 9)).toBe(false);
    expect(auditoria.leitura_de_terceiro(titular, 10)).toBe(true);
  });

  it("registrar_leitura_nominal grava só a de terceiro", async () => {
    const conta = await criarUsuario(db, { login: `leitor_${Date.now()}` });
    const u = new UsuarioAtual({ id: conta.id, login: conta.login, nome: conta.nome, permissoes: [], perfis: [] });
    const nada = await naTransacao((tx) => auditoria.registrar_leitura_nominal(tx, u, "parecer", { servidor_id: null }));
    expect(nada).toBeNull();
    const [servidor] = await db.select({ id: esquema.servidor.id }).from(esquema.servidor).limit(1);
    if (servidor) {
      const r = await naTransacao((tx) =>
        auditoria.registrar_leitura_nominal(tx, u, "parecer", { servidor_id: servidor.id }),
      );
      expect(r!.finalidade).toBe("consulta operacional do modulo Adicional Ocupacional");
      expect(r!.servidor_id).toBe(servidor.id);
    }
  });
});
