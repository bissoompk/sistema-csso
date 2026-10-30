# Manual do usuário: CISSP e PGR (Sistema SISA)

## Para quem é

Para qualquer pessoa que use o SISA no dia a dia (técnico, engenheiro, médico, secretaria, servidor) e queira saber o que já funciona em **CISSP** e **PGR**.

**Resposta curta:** hoje CISSP e PGR **ainda não existem como módulos**. O sistema só mostra um aviso de que eles estão previstos. Não há telas para cadastrar membros, registrar atas, montar inventário de riscos ou plano de ação. A única coisa que funciona é abrir um **processo SEI do tipo "PGR"**, que serve apenas para acompanhar o número do protocolo, guardar arquivos e anotar o andamento (ver capítulo 3).

## Antes de começar

- Acesse o SISA com seu login e senha.
- Os cartões de CISSP e PGR aparecem em "Módulos" para todos os perfis logados.
- O capítulo 3 exige acesso ao módulo "Processos SEI". Veja quem pode o quê:

| Perfil | Ver processos e o Kanban | Abrir ("Criar") e mover de estado |
|---|---|---|
| Coordenador, superintendente, engenheiro de segurança, técnico de segurança, médico do trabalho, secretaria da CSSO | Sim | Sim |
| Consulta PROGEP e auditor interno | Sim | Não (só leitura) |
| Servidor de consulta, almoxarife, administrador de TI | Não: aparece "403 — acesso negado" com a frase "Permissão necessária: processo.ver" | Não |

Quem não tem acesso deve pedir a um perfil autorizado ou ao coordenador. Não é só o coordenador que cria e move: qualquer perfil da primeira linha da tabela faz isso.

## Sumário

1. Onde CISSP e PGR aparecem no sistema
2. O que está previsto
3. Abrir e acompanhar um processo SEI do tipo "PGR"
4. Situações do processo
5. Erros e avisos comuns
6. Glossário
7. Limites conhecidos

## 1. Onde CISSP e PGR aparecem no sistema

**No menu "Módulos":** há um cartão para CISSP e outro para PGR, cada um com a etiqueta "ainda não desenvolvido" e o bloco "O que ele vai precisar ter".

**Na "Visão geral":** a seção "Outros módulos (em desenvolvimento)" mostra os dois. Quem só tem o "Meu espaço" (servidor de consulta) é levado direto para a página inicial e não vê essa seção, mas vê os cartões em "Módulos".

Os cartões **não são clicáveis**: não existe botão "Acessar". Se você digitar um endereço de CISSP ou PGR na barra do navegador (por exemplo `/cissp` ou `/pgr`), aparecerá a tela "404 — não encontrado". Isso é esperado.

## 2. O que está previsto

Conforme os cartões do sistema:

**CISSP** (Comissão Interna de Saúde e Segurança do Servidor Público: composição, mandato, reuniões e o que ficou deliberado):
- Composição e mandato dos membros
- Pauta, ata e deliberação de cada reunião
- Acompanhamento das recomendações até o fecho

**PGR** (Programa de Gerenciamento de Riscos: inventário de riscos por posto e plano de ação com prazo e responsável):
- Inventário de riscos por posto de trabalho
- Avaliação de severidade e probabilidade
- Plano de ação com prazo, responsável e evidência
- Reaproveitamento do que o laudo técnico já mediu

**O que fazer enquanto isso:** o sistema não indica onde registrar nem informa data de entrega. Reuniões, atas e o inventário de riscos continuam sendo feitos **fora do SISA**, pelos meios que a sua unidade já usa. Uma alternativa de guarda é anexar o arquivo ao processo SEI do tipo "PGR" (item 3.5), sem que isso o transforme em inventário. Em caso de dúvida, consulte o coordenador.

## 3. Abrir e acompanhar um processo SEI do tipo "PGR"

Atenção: isso apenas **rastreia o número do protocolo no SEI**. A tela diz: "O número do processo é digitado — a v1 não integra com o SEI". Não guarda inventário, riscos nem plano de ação.

### 3.1 Abrir o processo

1. No menu lateral, entre em "Processos SEI" e depois em "Processos".
2. Clique em "Novo processo".
3. Preencha:
   - **NUP** (obrigatório): cole o número do SEI. Pontuação, espaço e traço são acertados sozinhos.
   - Caixa "dígito verificador diverge, mas confirmei o número no SEI": marque somente se o sistema reclamar do dígito e você já tiver conferido o número no SEI. A dispensa fica registrada na auditoria com o seu nome. O formato do número continua obrigatório.
   - **Tipo**: escolha "PGR". O padrão da tela é "Adicional Ocupacional", então troque. (Existem também PGD, RITS, Parecer Técnico e outros: confira que escolheu "PGR", e não "PGD".)
   - **Data de autuação**: não pode ser data futura.
   - **Servidor** (opcional): busque por nome ou SIAPE no campo "Buscar servidor" e escolha na lista.
   - **Unidade / UORG** (opcional).
   - **Observações** (opcional): não escreva estado de saúde, diagnóstico ou gestação; CPF e CID nunca.
4. Clique em **Criar**.

**O que acontece depois:** o sistema abre a página do processo com a situação "Recebido" e "0d" (zero dias). Quem criou fica como **Responsável**. Há as abas Dados, Parecer, Anexos, Checklist e Histórico.

### 3.2 Mudar a situação

1. Abra o processo e use o botão "Mover de estado".
2. Em "Próximo passo", escolha a nova situação: "Em triagem", "Pendente de documento", "Concluído", "Arquivado" ou "Sobrestar". Só aparecem as situações permitidas a partir da atual.
3. Se quiser, escreva um "Comentário" (fica na auditoria; sem dado de saúde).
4. Clique em "Mover". Aparece a mensagem "Processo movido para “Em triagem”." (com o nome da situação escolhida; para "Sobrestar" a mensagem diz “Sobrestado”).

Regras que o sistema aplica (testadas): de "Recebido" dá para ir direto a "Concluído" ou "Arquivado"; um processo "Concluído" só pode voltar para "Em triagem" (reabrir); um processo **"Arquivado" não tem volta**: a tela mostra "— nenhum passo manual agora —". Pense antes de arquivar. Qualquer perfil da primeira linha da tabela de "Antes de começar" pode mover, não apenas o coordenador.

### 3.3 Conferir o histórico

Na aba "Histórico" aparece cada mudança como "Estado alterado — X → Y", com data, hora e nome de quem fez, mais a criação do processo, a dispensa do dígito verificador e os comentários.

### 3.4 Ver no quadro Kanban

Em "Kanban", o processo aparece conforme a situação:

| Situação | Coluna do Kanban |
|---|---|
| Recebido | A fazer |
| Em triagem | Em andamento |
| Pendente de documento e Sobrestado | Aguardando |
| Concluído e Arquivado | Concluído |

O cartão tem a opção "Mover para…" (A fazer, Em andamento, Aguardando, Concluído, conforme o ponto de partida). Há também o filtro por tipo: escolha "PGR" para ver só estes.

### 3.5 Outras coisas que a página do processo permite

- **Anexos > Enviar anexo:** guarda um arquivo (PDF, imagem, Word, Excel, texto, zip etc.) com "Categoria" (Parecer assinado, Laudo, Portaria de localização, Despacho, Formulário, Relatório de campo, Foto ou Outro) e, se quiser, o "Nº do documento SEI". Para material de PGR, use "Outro" ou "Relatório de campo". O arquivo é conferido por SHA-256 e duplicata é reaproveitada. Atenção: a coluna "Acesso" mostra "publico" para o anexo enviado; não anexe nada sigiloso nem dado de saúde.
- **Checklist > Criar checklist avulso:** dê um nome e liste os itens, um por linha. Serve para registrar que uma instrução foi seguida (por exemplo, "Pauta enviada", "Ata assinada"). Ele não substitui ata nem inventário.
- **Comentar:** deixa uma linha na aba "Histórico".
- **Salvar link do SEI:** grava o endereço permanente do processo no SEI (começa com `https://sei.`). Vazio, o link é removido.
- **Corrigir dados:** altera servidor, unidade e outros campos do cadastro.
- Na lista "Processos" há filtros por Estado, Tipo, Responsável e Unidade.

## 4. Situações do processo

| Situação | O que significa |
|---|---|
| Recebido | Processo cadastrado, ainda sem andamento. |
| Em triagem | Em andamento (no PGR, é o "está sendo feito"). |
| Pendente de documento | Aguardando algum documento. |
| Sobrestado | Parado por decisão (o botão se chama "Sobrestar"). Pode voltar para "Em triagem". |
| Concluído | Terminou. Pode ser reaberto, só para "Em triagem". |
| Arquivado | Encerrado e guardado. Não há como reabrir pela tela. |

O PGR segue um fluxo curto (chegou, está sendo feito, terminou), sem portaria, laudo ou parecer obrigatórios.

## 5. Erros e avisos comuns

| O que aparece | Por quê | O que fazer |
|---|---|---|
| "404 — não encontrado" ao tentar abrir CISSP ou PGR | O módulo não existe ainda | Nada. Use os meios atuais da unidade. |
| Dígito verificador do NUP não confere | Número digitado ou colado com erro | Confira no SEI. Se estiver certo, marque a caixa de dispensa. |
| Data de autuação recusada | Data futura | Informe a data real. |
| "403 — acesso negado", "Permissão necessária: processo.ver" | Perfil sem acesso a "Processos SEI" (servidor de consulta, almoxarife, administrador de TI) | Peça a um perfil autorizado. |
| Falta o botão "Novo processo" ou "Mover" | Perfil só de leitura (consulta PROGEP, auditor) | Peça a um perfil autorizado. |
| Aba "Parecer" e botão "Novo parecer" num processo PGR | São do fluxo de adicional ocupacional. **O botão funciona** e cria um rascunho de parecer técnico (modelo de parecer) ligado ao processo, com registro no histórico | **Não clique.** Não faz parte do PGR e o rascunho fica no processo. |

## 6. Glossário

- **CISSP**: Comissão Interna de Saúde e Segurança do Servidor Público.
- **PGR**: Programa de Gerenciamento de Riscos.
- **NUP**: número único de protocolo do processo no SEI.
- **SEI**: sistema de processos eletrônicos usado pela universidade.
- **Inventário de riscos**: lista dos riscos de cada posto de trabalho (previsto, não existe no sistema).

## 7. Limites conhecidos

- CISSP e PGR não existem como módulos: não há ata, mandato, membros, calendário de reuniões, inventário de riscos nem plano de ação no sistema.
- O processo SEI tipo "PGR" é só rastreio do protocolo, sem inventário. O sistema não integra com o SEI.
- Nos processos PGR aparecem a aba "Parecer" e o botão "Novo parecer", que criam um rascunho de parecer de adicional e não têm uso para esse tipo.
- Os cartões de CISSP e PGR não têm link, data prevista nem indicação de onde registrar enquanto isso.
- Outras telas citam o PGR como algo futuro: o catálogo de EPI (a restrição por risco do posto fica na análise humana até lá) e o checklist da Análise de Acidentes, etapa 5 ("Consultar o PGR (inventário de riscos do posto)"), que hoje precisa ser consultado fora do sistema.
- Nenhum perfil tem papel em CISSP ou PGR; não há o que conceder na tela de usuários.
- Processo arquivado não reabre pela tela.
