ALTER TABLE "unidade_uorg" ADD COLUMN "promove_treinamento" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- NUVEM (escrito à mão, depois do drizzle-kit): os setores da Sisa passam a ser
-- os promotores no banco que JÁ tem as unidades (produção). Roda uma vez, com a
-- migração: o que o setor desmarcar depois não volta. No banco novo a tabela
-- está vazia aqui e quem marca é a semente, ao criar a unidade (`sementes.ts`).
UPDATE "unidade_uorg" SET "promove_treinamento" = true WHERE "nome_oficial" IN (
  'SUPERINTENDENCIA INTEGRADA DE SAUDE',
  'COORDENADORIA DE SEGURANCA E SAUDE OCUPACIONAL',
  'SECRETARIA DA SISA',
  'COORDENADORIA DE SAUDE E QUALIDADE DE VIDA',
  'COORDENADORIA DE PERICIA OFICIAL EM SAUDE',
  'COORDENADORIA DE PROMOCAO E EDUCACAO EM SAUDE'
);
