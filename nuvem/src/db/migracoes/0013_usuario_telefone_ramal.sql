-- Minha conta (22/10/2026): telefone e ramal que a própria conta informa em
-- /minha-conta. Opcionais; usados só para a equipe do setor falar com a pessoa.
ALTER TABLE "usuario" ADD COLUMN "telefone" varchar(30);--> statement-breakpoint
ALTER TABLE "usuario" ADD COLUMN "ramal" varchar(12);