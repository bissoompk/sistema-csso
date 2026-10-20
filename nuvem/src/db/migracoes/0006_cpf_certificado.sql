ALTER TABLE "assinatura_instrutor" ADD COLUMN "cpf" varchar(11);--> statement-breakpoint
ALTER TABLE "participante" ADD COLUMN "cpf" varchar(11);--> statement-breakpoint
ALTER TABLE "assinatura_instrutor" ADD CONSTRAINT "ck_assinatura_cpf" CHECK (cpf ~ '^(?:[0-9]{11})$');--> statement-breakpoint
ALTER TABLE "participante" ADD CONSTRAINT "ck_participante_cpf" CHECK (cpf ~ '^(?:[0-9]{11})$');