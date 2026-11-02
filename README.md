# Sistema SISA — CSSO/UFVJM

**O sistema oficial é o que está em [`nuvem/`](nuvem/)** (Hono + Postgres/Supabase, no Netlify).
É o que atende as pessoas, e é o único que recebe correção e novidade.

- Como colocar no ar, operar, fazer backup e responder a incidente: [`nuvem/PRODUCAO.md`](nuvem/PRODUCAO.md).
- Privacidade (LGPD): [`nuvem/docs/ROPA_NUVEM.md`](nuvem/docs/ROPA_NUVEM.md),
  [`nuvem/docs/PLANO_INCIDENTE.md`](nuvem/docs/PLANO_INCIDENTE.md) e
  [`nuvem/docs/PROCEDIMENTO_TITULAR.md`](nuvem/docs/PROCEDIMENTO_TITULAR.md).
- O que mudou: [`nuvem/CHANGELOG.md`](nuvem/CHANGELOG.md).

## O resto da raiz é o sistema antigo (Python)

`app/`, `alembic/`, `testes/`, `frontend/`, os arquivos `.bat`, o `LEIA-ME.txt` e o
`CHANGELOG.md` da raiz são do **sistema anterior**, que rodava num computador do setor
(Módulo Adicional Ocupacional, 1.43). Ficam aqui como histórico e como fonte da migração dos
dados (`nuvem/PORTE.md`). **Não os use para operar o sistema** e não ponha dado novo neles.
