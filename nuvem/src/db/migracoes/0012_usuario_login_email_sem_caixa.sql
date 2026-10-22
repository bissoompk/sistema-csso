-- NUVEM (escrito à mão, antes do que o drizzle-kit gerou): o banco que JÁ tem
-- duas contas com o mesmo login ou e-mail em caixas diferentes não aceitaria
-- o índice. A entrada já resolvia o empate pela conta de MENOR id
-- (`autenticacao.autenticar`); essa fica com a credencial, e a outra ganha um
-- sufixo que diz o que houve ("~dup<id>"). Nada se apaga: quem administra
-- corrige depois em /usuarios (Editar dados). Sem duplicata, não muda nada.
DO $$
DECLARE
  n_login integer;
  n_email integer;
BEGIN
  UPDATE "usuario" u SET "login" = left(u."login", 64 - length('~dup' || u."id")) || '~dup' || u."id"
   WHERE EXISTS (SELECT 1 FROM "usuario" o WHERE lower(o."login") = lower(u."login") AND o."id" < u."id");
  GET DIAGNOSTICS n_login = ROW_COUNT;
  UPDATE "usuario" u SET "email" = left(u."email", 160 - length('~dup' || u."id")) || '~dup' || u."id"
   WHERE EXISTS (SELECT 1 FROM "usuario" o WHERE lower(o."email") = lower(u."email") AND o."id" < u."id");
  GET DIAGNOSTICS n_email = ROW_COUNT;
  IF n_login + n_email > 0 THEN
    RAISE WARNING 'D12: % login(s) e % e-mail(s) repetidos sem caixa receberam o sufixo ~dup<id>; corrija em /usuarios.', n_login, n_email;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usuario_login_sem_caixa" ON "usuario" USING btree (lower("login"));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usuario_email_sem_caixa" ON "usuario" USING btree (lower("email"));