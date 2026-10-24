ALTER TABLE "pedido_conta" DROP CONSTRAINT "ck_pedido_conta_situacao";--> statement-breakpoint
ALTER TABLE "pedido_conta" ALTER COLUMN "situacao" SET DATA TYPE varchar(16);--> statement-breakpoint
ALTER TABLE "pedido_conta" ALTER COLUMN "situacao" SET DEFAULT 'PENDENTE';--> statement-breakpoint
ALTER TABLE "ativacao_acesso" ADD COLUMN "senha_hash" text;--> statement-breakpoint
ALTER TABLE "pedido_conta" ADD COLUMN "senha_hash" text;--> statement-breakpoint
ALTER TABLE "pedido_conta" ADD COLUMN "token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "pedido_conta" ADD COLUMN "token_expira_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pedido_conta" ADD COLUMN "email_confirmado_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pedido_conta" ADD CONSTRAINT "uq_pedido_conta_token" UNIQUE("token_hash");--> statement-breakpoint
ALTER TABLE "pedido_conta" ADD CONSTRAINT "ck_pedido_conta_situacao" CHECK (situacao IN ('AGUARDANDO_EMAIL','PENDENTE','APROVADO','RECUSADO','DESCARTADO'));