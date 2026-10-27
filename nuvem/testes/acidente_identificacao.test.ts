/**
 * Anexo III da CAT/SP: a identificação pessoal do acidentado e o contato das
 * testemunhas, em bloco RESTRITO. O que importa: o CPF só entra pelo campo
 * próprio e conferido, nunca vai à trilha, ao contexto congelado, à tela nem à
 * exportação em claro; só abre quem tem a permissão, com a finalidade escolhida
 * antes e o acesso registrado; a data de nascimento restringe a ocorrência do
 * menor de idade. Dados fictícios (o CPF abaixo é de teste, com verificador válido).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as e from "../src/db/esquema/index.js";
import type { Banco } from "../src/db/cliente.js";
import { hoje_iso, somar_dias } from "../src/dominio/datas.js";
import * as comunicacao from "../src/servicos/acidente_comunicacao.js";
import * as identificacao from "../src/servicos/acidente_identificacao.js";
import { sem_credenciais } from "../src/servicos/backup.js";
import { PermissaoNegada } from "../src/servicos/rbac.js";
import { bancoLimpo, contas, entrar, usuarioAtual, type Campos, type Cliente } from "./ajuda.js";
import { dados, envolvido, titular } from "./acidente_ajuda.js";

let db: Banco;
let novoCliente: () => Cliente;

beforeEach(async () => {
  const amb = await bancoLimpo();
  db = amb.db;
  novoCliente = amb.novoCliente;
  await contas(db);
});

const CPF = "529.982.247-25";
const CPF_DIGITOS = "52998224725";
const RG = "MG-99.888.777";
const RUA = "Rua dos Testes Inventados";

const IDENT: identificacao.DadosIdentificacao = {
  sexo: "FEMININO",
  cpf: CPF,
  rg: RG,
  data_nascimento: "1985-04-20",
  cep: "39100-000",
  logradouro: RUA,
  numero: "123",
  complemento: "apto 4",
  bairro: "Bairro Inventado",
  cidade: "Diamantina",
  uf: "mg",
  telefone: "(38) 99999-1234",
  email: "pessoal@exemplo.invalid",
};

const comIdentificacao = (extra: Partial<identificacao.DadosIdentificacao> = {}) =>
  dados({
    envolvidos: [envolvido({ sou_eu: true, identificacao: { ...IDENT, ...extra } })],
    testemunhas: [
      {
        nome: "Testemunha Fictícia",
        vinculo: "ESTUDANTE",
        contato: "ramal 1234",
        endereco: { cep: "39100-111", logradouro: "Avenida das Testemunhas", numero: "10", complemento: null, bairro: "Centro", municipio: "Diamantina", uf: "MG", telefone: "38988880000" },
      },
    ],
  });

async function comunicar(extra: Partial<identificacao.DadosIdentificacao> = {}) {
  const { usuario } = await titular(db);
  const oc = await db.transaction((tx) => comunicacao.comunicar(tx, usuario, comIdentificacao(extra)));
  return { oc, usuario };
}

describe("conferir", () => {
  it("normaliza: só dígitos no CPF, CEP e telefone, UF em maiúsculas", () => {
    const c = identificacao.conferir(IDENT)!;
    expect(c).toMatchObject({ cpf: CPF_DIGITOS, cep: "39100000", telefone: "38999991234", uf: "MG", sexo: "FEMININO", data_nascimento: "1985-04-20" });
  });

  it("tudo vazio é nada: não grava linha", () => {
    expect(identificacao.conferir(identificacao.IDENTIFICACAO_VAZIA)).toBeNull();
  });

  it("CPF com verificador errado é recusado, e a mensagem não ecoa o número", () => {
    try {
      identificacao.conferir({ ...IDENT, cpf: "111.222.333-44" });
      expect.unreachable();
    } catch (erro) {
      expect(erro).toBeInstanceOf(identificacao.IdentificacaoRecusada);
      expect((erro as Error).message).not.toContain("111");
      expect((erro as identificacao.IdentificacaoRecusada).campo).toBe("o CPF");
    }
  });

  it("recusa telefone sem DDD, CEP curto, UF torta, e-mail ruim, sexo fora da lista e nascimento no futuro", () => {
    const recusa = (extra: Partial<identificacao.DadosIdentificacao>, campo: string) => {
      try {
        identificacao.conferir({ ...IDENT, ...extra });
        expect.unreachable(campo);
      } catch (erro) {
        expect((erro as identificacao.IdentificacaoRecusada).campo, campo).toBe(campo);
      }
    };
    recusa({ telefone: "99999-1234" }, "O telefone");
    recusa({ cep: "123" }, "O CEP");
    recusa({ uf: "MGX" }, "a UF");
    recusa({ email: "sem-arroba" }, "o e-mail");
    recusa({ sexo: "XYZ" }, "o sexo");
    recusa({ data_nascimento: somar_dias(hoje_iso(), 10) }, "a data de nascimento");
  });

  it("CPF solto em endereço ou complemento é recusado: o CPF só entra no campo próprio", () => {
    expect(() => identificacao.conferir({ ...IDENT, complemento: `ao lado, ${CPF}` })).toThrow(/formato de CPF/);
    expect(() => identificacao.conferir({ ...IDENT, logradouro: "52998224725" })).toThrow(/formato de CPF/);
  });
});

describe("a comunicação grava o bloco restrito", () => {
  it("grava a identificação e o contato da testemunha, e a trilha diz só o que foi informado", async () => {
    const { oc } = await comunicar();
    const [env] = await db.select().from(e.acidentado).where(eq(e.acidentado.ocorrencia_id, oc.id));
    const [linha] = await db.select().from(e.acidente_identificacao).where(eq(e.acidente_identificacao.acidentado_id, env!.id));
    expect(linha).toMatchObject({ cpf: CPF_DIGITOS, rg: RG, cep: "39100000", uf: "MG", telefone: "38999991234", sexo: "FEMININO" });
    const [t] = await db.select().from(e.acidente_testemunha).where(eq(e.acidente_testemunha.ocorrencia_id, oc.id));
    const [contato] = await db.select().from(e.acidente_testemunha_contato).where(eq(e.acidente_testemunha_contato.testemunha_id, t!.id));
    expect(contato).toMatchObject({ logradouro: "Avenida das Testemunhas", telefone: "38988880000", uf: "MG" });

    const eventos = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "ACIDENTE_IDENTIFICACAO_REGISTRADA"));
    expect(eventos).toHaveLength(2);
    expect(eventos.map((x) => x.descricao).join("\n")).toMatch(/sexo, CPF, RG, nascimento, endereço, telefone, e-mail/);
  });

  it("nenhum valor do bloco chega à trilha, ao contexto congelado, a pendência nem a e-mail", async () => {
    const { oc } = await comunicar();
    for (const t of ["historico_evento", "acidente_cat_sp", "acidente_ocorrencia", "acidentado", "acidente_testemunha", "pendencia", "email_saida"]) {
      const linhas = await db.execute<{ j: string }>(sql.raw(`SELECT row_to_json(x)::text AS j FROM ${t} x`));
      const tudo = linhas.map((l) => l.j).join("\n");
      for (const proibido of [CPF, CPF_DIGITOS, RG, RUA, "99999-1234", "38999991234", "1985-04-20", "Bairro Inventado", "pessoal@exemplo", "Avenida das Testemunhas", "39100000"]) {
        expect(tudo, `${t} vazou «${proibido}»`).not.toContain(proibido);
      }
    }
    expect(oc.restrita_sst).toBe(false);
  });

  it("acidentado menor na data do acidente, pela data de nascimento, deixa a ocorrência restrita à SST", async () => {
    const { oc } = await comunicar({ data_nascimento: somar_dias(hoje_iso(), -365 * 15) });
    expect(oc.restrita_sst).toBe(true);
    const [env] = await db.select().from(e.acidentado).where(eq(e.acidentado.ocorrencia_id, oc.id));
    expect(env!.menor_de_idade).toBe(true);
  });

  it("identificação inválida recusa a comunicação inteira, sem gravar nada", async () => {
    const { usuario } = await titular(db);
    await expect(db.transaction((tx) => comunicacao.comunicar(tx, usuario, comIdentificacao({ cpf: "000.000.000-00" })))).rejects.toThrow(/CPF inválido/);
    expect(await db.select().from(e.acidente_ocorrencia)).toHaveLength(0);
    expect(await db.select().from(e.acidente_identificacao)).toHaveLength(0);
  });

  it("sem nada preenchido não cria linha", async () => {
    const { usuario } = await titular(db);
    await db.transaction((tx) => comunicacao.comunicar(tx, usuario, dados()));
    expect(await db.select().from(e.acidente_identificacao)).toHaveLength(0);
    expect(await db.select().from(e.acidente_testemunha_contato)).toHaveLength(0);
  });
});

describe("ler", () => {
  async function aberta() {
    const c = await comunicar();
    const [env] = await db.select().from(e.acidentado).where(eq(e.acidentado.ocorrencia_id, c.oc.id));
    return { ...c, env: env! };
  }

  it("a equipe abre com a finalidade, o acesso fica registrado e o CPF volta mascarado", async () => {
    const { oc, env } = await aberta();
    const tecnico = await usuarioAtual(db, "tecnico_seguranca");
    const l = await db.transaction((tx) => identificacao.ler(tx, tecnico, oc, env.id, "CONTATAR_ENVOLVIDO"));
    expect(l.existe).toBe(true);
    expect(l.cpf_exibicao).toBe("***.***.***-**");
    expect(l.rg).toBe(RG);
    expect(l.telefone).toBe("(38) 99999-1234");
    expect(l.endereco).toMatchObject({ cep: "39100-000", cidade: "Diamantina", uf: "MG" });
    expect(l.testemunhas).toHaveLength(1);
    expect(l.testemunhas[0]!.contato).toMatchObject({ telefone: "(38) 98888-0000", cep: "39100-111" });
    expect(JSON.stringify(l)).not.toContain(CPF_DIGITOS);

    const acessos = await db.select().from(e.acesso_dado_sensivel).where(eq(e.acesso_dado_sensivel.campo, "acidente_identificacao"));
    expect(acessos).toHaveLength(1);
    expect(acessos[0]).toMatchObject({ usuario_id: tecnico.id, acidente_id: oc.id, acidentado_id: env.id, finalidade: "Contatar o envolvido ou a testemunha" });
  });

  it("sem finalidade ou com finalidade fora da lista não abre, e nada é registrado", async () => {
    const { oc, env } = await aberta();
    const tecnico = await usuarioAtual(db, "tecnico_seguranca");
    await expect(db.transaction((tx) => identificacao.ler(tx, tecnico, oc, env.id, null))).rejects.toThrow(/finalidade/);
    await expect(db.transaction((tx) => identificacao.ler(tx, tecnico, oc, env.id, "CURIOSIDADE"))).rejects.toThrow(/finalidade/);
    expect(await db.select().from(e.acesso_dado_sensivel).where(eq(e.acesso_dado_sensivel.campo, "acidente_identificacao"))).toHaveLength(0);
  });

  it("quem não tem a permissão é negado, mesmo com finalidade", async () => {
    const { oc, env } = await aberta();
    // o servidor comum de outra pessoa (sem relação com este acidentado)
    const outro = await usuarioAtual(db, "secretaria_csso");
    await expect(db.transaction((tx) => identificacao.ler(tx, outro, oc, env.id, "INVESTIGACAO"))).rejects.toBeInstanceOf(PermissaoNegada);
  });

  it("o próprio acidentado lê a sua sem finalidade e sem registro de acesso", async () => {
    const { oc, env, usuario } = await aberta();
    const l = await db.transaction((tx) => identificacao.ler(tx, usuario, oc, env.id, null));
    expect(l.titular).toBe(true);
    expect(l.existe).toBe(true);
    expect(await db.select().from(e.acesso_dado_sensivel).where(eq(e.acesso_dado_sensivel.campo, "acidente_identificacao"))).toHaveLength(0);
  });

  it("quem não conduz o caso deixa um evento na trilha, sem dado", async () => {
    const { oc, env } = await aberta();
    const tecnico = await usuarioAtual(db, "tecnico_seguranca");
    await db.transaction((tx) => identificacao.ler(tx, tecnico, oc, env.id, "INVESTIGACAO"));
    const [ev] = await db.select().from(e.historico_evento).where(eq(e.historico_evento.tipo_evento, "ACIDENTE_IDENTIFICACAO_FORA_RESPONSAVEL"));
    expect(ev!.descricao).toContain(oc.protocolo);
    expect(ev!.descricao).not.toMatch(/52998|Rua|Diamantina/);
  });
});

describe("a exportação em claro", () => {
  it("leva só as chaves das duas tabelas restritas", async () => {
    await comunicar();
    const dump = new Map<string, string>();
    for (const t of ["acidente_identificacao", "acidente_testemunha_contato"]) {
      const linhas = await db.execute(sql.raw(`SELECT row_to_json(x) AS j FROM ${t} x`));
      dump.set(t, JSON.stringify(linhas.map((l: any) => l.j)));
    }
    const saida = sem_credenciais(dump);
    const tudo = [...saida.values()].join("\n");
    for (const proibido of [CPF_DIGITOS, RG, RUA, "38999991234", "Avenida das Testemunhas", "pessoal@exemplo"]) expect(tudo).not.toContain(proibido);
    expect(JSON.parse(saida.get("acidente_identificacao")!)[0]).toMatchObject({ cpf: null, rg: null, acidentado_id: expect.any(Number) });
  });
});

describe("pela tela", () => {
  const formulario = (extra: Campos = {}): Campos => ({
    env_indice: "1",
    env_1_sou_eu: "1",
    env_1_vinculo: "SERVIDOR",
    env_1_condicao: "ACIDENTADO",
    env_1_houve_lesao: "SIM",
    env_1_sexo: "FEMININO",
    env_1_cpf: CPF,
    env_1_rg: RG,
    env_1_data_nascimento: "1985-04-20",
    env_1_logradouro: RUA,
    env_1_cep: "39100-000",
    env_1_cidade: "Diamantina",
    env_1_uf: "MG",
    env_1_telefone: "(38) 99999-1234",
    especie: "TIPICO",
    data_evento: somar_dias(hoje_iso(), -2),
    hora_evento: "10:15",
    jornada: "01:30",
    local_tipo: "LABORATORIO",
    local_especificacao: "Laboratório fictício, bancada 2",
    local_uf: "MG",
    descricao: "A bandeja escorregou da prateleira durante a arrumação.",
    test_1_nome: "Testemunha Fictícia",
    test_1_logradouro: "Avenida das Testemunhas",
    test_1_telefone: "(38) 98888-0000",
    declaracao: "1",
    ...extra,
  });

  async function comunicarPelaTela(extra: Campos = {}) {
    await titular(db);
    const cli = await entrar(novoCliente(), "servidor_consulta");
    const [sv] = await db.select().from(e.servidor);
    // o cadastro do servidor não tem cargo nem lotação: o formulário os traz
    const campus = (await db.select().from(e.campus))[0]!;
    return {
      cli,
      sv,
      r: await cli.post(
        "/acidentes/comunicar",
        formulario({ env_1_cargo_novo: "Técnico Fictício", env_1_lotacao_nova: "Setor Fictício", env_1_lotacao_campus_id: String(campus.id), ...extra }),
        { seguir: false },
      ),
    };
  }

  it("o formulário traz o bloco do Anexo III e o CPF digitado vira só dígitos no banco", async () => {
    const { cli, r } = await comunicarPelaTela();
    expect(r.status).toBe(303);
    const [linha] = await db.select().from(e.acidente_identificacao);
    expect(linha).toMatchObject({ cpf: CPF_DIGITOS, rg: RG, telefone: "38999991234" });
    // a ficha do titular não mostra o CPF por inteiro em lugar nenhum
    const ficha = await cli.get(r.location!);
    expect(ficha.text).not.toContain(CPF_DIGITOS);
    expect(ficha.text).not.toContain(CPF);
  });

  it("CPF inválido volta o formulário (422) sem devolver o número digitado", async () => {
    const { r } = await comunicarPelaTela({ env_1_cpf: "123.456.789-00" });
    expect(r.status).toBe(422);
    expect(r.text).toContain("CPF inválido");
    expect(r.text).not.toContain("123.456.789-00");
    expect(r.text).not.toContain("12345678900");
    expect(await db.select().from(e.acidente_ocorrencia)).toHaveLength(0);
  });

  it("a aba Identificação: a equipe abre com a finalidade (e o CPF sai mascarado); sem finalidade dá 422", async () => {
    const { r } = await comunicarPelaTela();
    const id = r.location!.match(/^\/acidentes\/(\d+)/)![1]!;
    const [env] = await db.select().from(e.acidentado);
    const tecnico = await entrar(novoCliente(), "tecnico_seguranca");
    const sem = await tecnico.get(`/acidentes/${id}/identificacao?acidentado=${env!.id}`, { seguir: false });
    expect(sem.status).toBe(422);
    expect(sem.text).toContain("finalidade");
    const ok = await tecnico.get(`/acidentes/${id}/identificacao?acidentado=${env!.id}&finalidade=INVESTIGACAO`, { seguir: false });
    expect(ok.status).toBe(200);
    expect(ok.text).toContain(RUA);
    expect(ok.text).toContain("***.***.***-**");
    expect(ok.text).not.toContain(CPF_DIGITOS);
    expect(ok.text).toContain("Avenida das Testemunhas");
  });

  it("a aba diz a quem não tem a permissão que o perfil dele não abre", async () => {
    const { r } = await comunicarPelaTela();
    const id = r.location!.match(/^\/acidentes\/(\d+)/)![1]!;
    const sec = await entrar(novoCliente(), "secretaria_csso");
    const aba = await sec.get(`/acidentes/${id}?aba=identificacao`, { seguir: false });
    expect(aba.status).toBe(200);
    expect(aba.text).toContain("Seu perfil não abre a identificação pessoal");
    expect(aba.text).not.toContain(RUA);
    const direto = await sec.get(`/acidentes/${id}/identificacao?acidentado=1&finalidade=INVESTIGACAO`, { seguir: false });
    expect(direto.status).toBe(403);
  });
});
