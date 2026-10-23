ALTER TABLE "usuario" ALTER COLUMN "login" SET DATA TYPE varchar(160);
-- NUVEM (escrito à mão, depois do drizzle-kit): o login passa a ser o e-mail
-- cadastrado (23/10/2026, DESVIOS.md "Login é o e-mail"), e o e-mail cabe em
-- 160 caracteres: a coluna acompanha. A conversão das contas que já existem
-- NÃO mora aqui: ela depende da marca de produção, pula conflitos e audita
-- cada conta — é o `ferramentas/converter-logins.ts`, que a publicação roda
-- depois do semeio.
