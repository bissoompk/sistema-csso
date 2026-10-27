ALTER TABLE "acidente_saude" ADD COLUMN "duracao_tratamento_dias" integer;--> statement-breakpoint
ALTER TABLE "acidente_saude" ADD COLUMN "deve_afastar" varchar(8);--> statement-breakpoint
ALTER TABLE "acidente_saude" ADD COLUMN "descricao_lesao" text;--> statement-breakpoint
ALTER TABLE "acidente_saude" ADD COLUMN "diagnostico_provavel" varchar(240);--> statement-breakpoint
ALTER TABLE "acidente_saude" ADD COLUMN "cid" varchar(8);--> statement-breakpoint
ALTER TABLE "acidente_saude" ADD COLUMN "observacoes_saude" text;--> statement-breakpoint
ALTER TABLE "acidente_saude" ADD CONSTRAINT "ck_acid_saude_deve_afastar" CHECK (deve_afastar IN ('SIM','NAO','NAO_SABE'));--> statement-breakpoint
ALTER TABLE "acidente_saude" ADD CONSTRAINT "ck_acid_saude_duracao" CHECK (COALESCE(duracao_tratamento_dias, 0) >= 0);--> statement-breakpoint
ALTER TABLE "acidente_saude" ADD CONSTRAINT "ck_acid_saude_cid" CHECK (cid IS NULL OR cid ~ '^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$');