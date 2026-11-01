ALTER TABLE "acidente_ocorrencia" ADD COLUMN "token_envio" varchar(40);--> statement-breakpoint
ALTER TABLE "acidente_ocorrencia" ADD CONSTRAINT "uq_acid_oc_token_envio" UNIQUE("token_envio");