# O porte do CSSO para a nuvem (Netlify + Supabase)

Este diretório é o Sistema CSSO reescrito em TypeScript para rodar em
**Netlify Functions** (uma função só, `netlify/functions/csso.mts`) com o banco
no **Supabase Postgres** e os arquivos no **Supabase Storage**. O sistema
Python da raiz do repositório continua existindo e continua sendo a
referência de regra: este porte **não reinventa regra nenhuma**, traduz.

> **Só dados de teste.** Esta instalação é homologação/demonstração. Dado real
> de servidor da UFVJM não entra aqui (`docs/SERVIDOR_LINUX.md`, ROPA,
> `POLITICA_RETENCAO.md` §5).

## Mapa: Python → TypeScript

| Python (`app/`) | TypeScript (`nuvem/`) |
|---|---|
| `modelos/*.py` (SQLAlchemy) | `src/db/esquema/*.ts` (Drizzle) + `src/db/relacoes` + `src/db/travas.sql` |
| constantes de `modelos/estados.py`, `dominios.py` | `src/dominio/*.ts` |
| `servicos/x.py` | `src/servicos/x.ts` (mesmo nome) |
| `rotas/x.py` | `src/rotas/x.ts` (mesmo nome), exporta `rotas: Hono<Ambiente>` |
| `repositorios/x.py` | `src/repositorios/x.ts` |
| `web.py` | `src/web.ts` |
| `dependencias.py` | `src/dependencias.ts` |
| `modulos.py` | `src/modulos.ts` |
| `principal.py` | `src/app.ts` |
| `templates/**` (Jinja2) | `templates/**` (Nunjucks) |
| `estaticos/**` | `public/estaticos/**` (servido pelo CDN do Netlify) |
| `testes/test_x.py` (pytest) | `testes/x.test.ts` (vitest) |

## Convenções (obrigatórias — vários agentes portam em paralelo)

1. **Nomes iguais aos do Python, em snake_case**: tabelas, colunas, propriedades
   TS dos registros, nomes de função exportada de serviço, constantes. Não
   "camelCase-ize". Isso permite portar templates e serviços mecanicamente e
   comparar lado a lado. (Exceção: helpers de infraestrutura novos em `web.ts`
   e `dependencias.ts`, que não existiam no Python.)
2. **Serviço recebe o executor primeiro**: `async function x(tx: Executor, ...)`.
   `Executor`/`Tx` vêm de `src/db/cliente.ts`. Nunca abra outra conexão/transação
   dentro de um serviço (o Python avisa o porquê em `banco.py`).
3. **Rota**: arquivo `src/rotas/x.ts` já existe como esqueleto e já está
   registrado em `src/rotas/index.ts` na ordem do `principal.py`. Padrão:

   ```ts
   rotas.get("/processos", async (c) => {
     const usuario = await usuarioCom(c, "processo.ver");   // dependencias.ts
     const tx = c.get("tx");                                // transação da requisição
     ...
     return pagina(c, "paginas/processos.html", usuario, { ... });  // web.ts
   });
   ```

   - `formulario(c)` lê o corpo (`texto`, `opcional`, `inteiro`, `todos`, `arquivo`).
   - Recusa que já escreveu: `desfazer(c)` antes de devolver (é o `s.rollback()`).
   - 404/403: `throw new ErroHttp(404, "...")`; permissão de serviço:
     `throw new PermissaoNegada(codigo)`; API: `throw new RecusaDaApi(status, erro, motivos)`.
   - Redirecionamento: `redirecionar(c, destino)` (303) e `comMensagem(destino, texto)`.
4. **Commit/rollback é do middleware** (`src/app.ts`): a requisição inteira é
   uma transação. Não chame commit.
5. **Templates**: Nunjucks é quase Jinja2. Diferenças a corrigir ao portar:
   - `dict.items()` → `dict | items` (filtro registrado) ou `for k, v in dict`.
   - `namespace()` não existe → reestruture (ou calcule no TS).
   - `{% with %}` não existe → `{% set %}`.
   - `loop.index`, `loop.first`, `loop.last`, `loop.length` existem.
   - Os testes `is none`, `is sameas`, `is in`, `is defined`, `is odd/even`,
     `is divisibleby`, `is string`, `is number` funcionam (os que faltavam foram
     registrados em `web.ts`).
   - Métodos Python dentro do template (`.strftime`, `.upper()`, `.startswith`,
     `.split`, `.get`, `.isoformat()`): troque por filtro (`|upper`) ou por
     método JS equivalente (`.toUpperCase()`, `.startsWith()`), ou calcule no TS.
   - `|tojson`, `|selectattr`, `|rejectattr`, `|map(attribute=)`, `|items`,
     `|max`, `|min`, `|unique`, `|format` foram registrados em `web.ts`.
   - Datas: colunas `date` chegam como string `AAAA-MM-DD`; `timestamptz` como `Date`.
     Use os filtros `data`, `data_extenso`, `momento` (registrados pelo porte de `datas_br`).
   - Funções globais que leem o contexto (`identificar`, `texto_livre`, `nonce`)
     recebem o contexto em `this.ctx` (Nunjucks chama globais com `this` = Context).
   - Nada de consulta preguiçosa: a rota carrega TUDO que o template lê
     (Drizzle `with: {...}` nas relações com o mesmo nome do SQLAlchemy).
6. **Datas**: colunas `date` são string `AAAA-MM-DD` (nunca converter fuso — RN-18).
   "Hoje" é o dia em `America/Sao_Paulo` (`hoje()` de `src/servicos/datas_br.ts`).
7. **Arquivos** (anexos, documentos gerados): nunca disco local — a função do
   Netlify não tem disco persistente. Use `src/servicos/armazenamento.ts`
   (Supabase Storage em produção, pasta local em desenvolvimento/teste).
8. **PDF**: não há LibreOffice na nuvem. Onde o Python convertia `.docx` em PDF,
   aqui sai o `.docx` com o aviso que o Python já dava quando o LibreOffice
   faltava (`pdf.disponivel() == false`).
9. **Limites do Netlify**: 60 s por requisição e 6 MB de corpo (≈4,5 MB de
   binário). Upload maior que isso tem de ser recusado com mensagem clara.
10. **Testes**: `vitest`, contra o Postgres local (`testes/ajuda.ts` cria um banco
    limpo). Porte os testes do Python do seu módulo — são eles que dizem que a
    regra continua de pé.
11. Comentários em português, explicando o **porquê**, como no original. Quando
    a nuvem obrigar a um desvio do comportamento Python, escreva o desvio no
    comentário e em `DESVIOS.md`.
