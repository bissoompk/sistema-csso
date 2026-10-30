# Manual do Coordenador: CISSP e PGR (Sistema SISA)

## Para quem é

Para quem responde pelos módulos CISSP e PGR: decide quem acessa, configura o que for preciso, acompanha pendências e cuida de prazos e registros.

**Aviso importante:** hoje o CISSP e o PGR **ainda não existem como módulos funcionais** no Sistema SISA. Este manual diz o que aparece na tela, o que está previsto, o que já dá para usar (o processo SEI do tipo "PGR", só para acompanhar o protocolo) e o que você precisa continuar fazendo fora do sistema.

## Antes de começar

- **Acesso:** os dois cartões aparecem em "Módulos" para todos os perfis logados. Não há tela para abrir.
- **Perfil necessário:** nenhum. Não existem permissões de CISSP nem de PGR. Por isso **não há nada para conceder ou retirar** na tela "Usuários", e não existe a figura de "membro da comissão" ou de "responsável pelo PGR" no cadastro de perfis.
- **Para o processo SEI do tipo PGR** (capítulo 3), o que decide é a permissão de Processos SEI do perfil:

| Perfil | Ver | Criar e mover de estado |
|---|---|---|
| Coordenador, superintendente, engenheiro de segurança, técnico de segurança, médico do trabalho, secretaria da CSSO | Sim | Sim |
| Consulta PROGEP e auditor interno | Sim | Não |
| Servidor de consulta, almoxarife, administrador de TI | Não ("403 — acesso negado", "Permissão necessária: processo.ver") | Não |

  Atenção: o médico do trabalho **tem** acesso ao módulo e cria processos. A tela "Usuários" exige a permissão de criar contas, que o coordenador não tem (testado: aparece "403"); o ajuste de perfil é pedido ao administrador de TI.

## Sumário

1. Onde CISSP e PGR aparecem hoje
2. O que está previsto para cada módulo
3. Acompanhar o protocolo do PGR como processo SEI
4. Rotina de acompanhamento enquanto os módulos não existem
5. Mensagens e situações comuns
6. Glossário
7. Limites conhecidos
8. Decisões que dependem de você

## 1. Onde CISSP e PGR aparecem hoje

1. **Menu "Módulos"**: dois cartões com a etiqueta "ainda não desenvolvido" e o bloco "O que ele vai precisar ter".
2. **Visão geral**, seção "Outros módulos (em desenvolvimento)": os mesmos dois. Quem só tem o "Meu espaço" (servidor de consulta) vai direto para a página inicial e não vê esta seção, mas vê os cartões em "Módulos".
3. Os cartões **não são clicáveis**: não há botão "Acessar".
4. Digitar endereços como `/cissp` ou `/pgr` leva à tela "404 — não encontrado". É o esperado.

## 2. O que está previsto

**CISSP** (Comissão Interna de Saúde e Segurança do Servidor Público: composição, mandato, reuniões e o que ficou deliberado):
- Composição e mandato dos membros
- Pauta, ata e deliberação de cada reunião
- Acompanhamento das recomendações até o fecho

**PGR** (Programa de Gerenciamento de Riscos: inventário de riscos por posto e plano de ação com prazo e responsável):
- Inventário de riscos por posto de trabalho
- Avaliação de severidade e probabilidade
- Plano de ação com prazo, responsável e evidência
- Reaproveitamento do que o laudo técnico já mediu

Nada disso pode ser usado ainda. Não há data de entrega informada no sistema.

## 3. Acompanhar o protocolo do PGR como processo SEI

Isto **não é o inventário de riscos**. O processo do tipo "PGR" serve só para rastrear o número do protocolo no SEI (o sistema não integra com o SEI: o número é digitado). Não guarda riscos, avaliação nem plano de ação.

### Abrir

1. No menu "Processos SEI", entre em "Processos" e clique em "Novo processo".
2. Preencha o **NUP**. Cole o número do SEI: pontuação, espaço e traço são acertados sozinhos. Se o dígito verificador divergir e você tiver conferido o número no SEI, marque a caixa "dígito verificador diverge, mas confirmei o número no SEI" (fica registrado na auditoria, com seu nome e o número dispensado).
3. Em "Tipo", escolha **"PGR"**. Atenção: o tipo que vem preenchido é "Adicional Ocupacional" e existe também o "PGD", parecido no nome.
4. Informe a "Data de autuação" (não pode ser futura).
5. Opcionalmente informe "Servidor" (busca por nome ou SIAPE), "Unidade / UORG" e "Observações" (sem dado de saúde).
6. Clique em **Criar**. O processo abre com a situação "Recebido", quem criou fica como "Responsável", e as abas são Dados, Parecer, Anexos, Checklist e Histórico.

### Mover

1. Abra o processo e use "Mover de estado".
2. Em "Próximo passo" aparecem só as opções permitidas a partir da situação atual, entre "Em triagem", "Pendente de documento", "Concluído", "Arquivado" e "Sobrestar".
3. Comentário é opcional e fica na auditoria.
4. O sistema confirma com a mensagem "Processo movido para “Em triagem”." (com o nome do novo estado; para "Sobrestar" aparece “Sobrestado”).
5. A aba "Histórico" registra "Estado alterado — X → Y" com data, hora e nome de quem moveu.

Quem pode mover: todos os perfis da primeira linha da tabela de "Antes de começar", não só o coordenador.

### Situações

| Situação | O que significa | Kanban |
|---|---|---|
| Recebido | Processo acabou de ser cadastrado. | A fazer |
| Em triagem | Em andamento. | Em andamento |
| Pendente de documento | Aguardando algo de terceiros. | Aguardando |
| Sobrestado | Parado por decisão. Pode voltar para "Em triagem". | Aguardando |
| Concluído | Terminou. Pode ser reaberto, só para "Em triagem". | Concluído |
| Arquivado | Encerrado e guardado. **Sem volta pela tela** (aparece "— nenhum passo manual agora —"). | Concluído |

O PGR segue o fluxo curto (chegou, está sendo feito, terminou), sem exigir portaria, laudo ou parecer. De "Recebido" já dá para ir a "Concluído" ou "Arquivado". No "Kanban" o cartão oferece "Mover para…" e dá para filtrar por tipo "PGR".

### Guardar material no processo

- **Anexos > Enviar anexo:** arquivo (PDF, imagem, Word, Excel, texto, zip) com categoria (Parecer assinado, Laudo, Portaria de localização, Despacho, Formulário, Relatório de campo, Foto, Outro) e "Nº do documento SEI" opcional. Para atas e planos use "Outro" ou "Relatório de campo". A coluna "Acesso" mostra "publico": não anexe dado de saúde nem sigilo.
- **Checklist > Criar checklist avulso:** itens um por linha, para provar que uma instrução foi seguida (por exemplo, "Pauta enviada", "Ata assinada").
- **Comentar** e **Salvar link do SEI** (endereço começando em `https://sei.`) também estão na página.

Isto ajuda a organizar a prova, mas não é ata nem inventário.

## 4. Rotina de acompanhamento enquanto os módulos não existem

O sistema não cobra nem alerta nada sobre CISSP e PGR. Para manter o programa saudável, a responsabilidade continua sua, fora do sistema:

- **Semanal:** na lista "Processos", filtrar por Tipo "PGR" e Estado "Pendente de documento" ou "Sobrestado" e cobrar os parados.
- **Mensal:** conferir se os processos concluídos têm o resultado guardado no local oficial (SEI ou arquivo da unidade) ou anexado ao processo.
- **Sempre que houver reunião da comissão:** registrar pauta, ata e deliberações fora do sistema (SEI ou arquivo da comissão), pois o SISA não tem onde guardá-las como ata.
- **Ao analisar acidentes:** o item "Consultar o PGR (inventário de riscos do posto)" do checklist da investigação (etapa 5) deve ser feito consultando o inventário que a instituição mantém fora do sistema.
- **Ao decidir EPI:** o catálogo de EPI não restringe por risco do posto, pois isso depende do inventário do PGR. Até lá a restrição é humana, na análise.
- **Mandatos:** controlar fora do sistema datas de posse e de término dos membros da comissão.

## 5. Mensagens e situações comuns

| O que aparece | O que fazer |
|---|---|
| "404 — não encontrado" ao digitar /cissp ou /pgr | Normal: não existe tela. Use o capítulo 3 ou o registro externo. |
| Cartão de CISSP/PGR sem botão | Normal: ainda não desenvolvido. |
| Aba "Parecer" e botão "Novo parecer" num processo PGR | Não use. O botão funciona, mas cria um rascunho de parecer técnico de adicional ocupacional (com registro no histórico) que não serve ao PGR. |
| Erro no NUP | Confira o número no SEI; se estiver certo, marque a caixa de dígito verificador. |
| "403 — acesso negado" ao abrir processo | Esperado para servidor de consulta, almoxarife e administrador de TI. Peça a um perfil autorizado ou peça ao administrador de TI para ajustar o perfil. |
| Processo arquivado por engano | Não há botão para reabrir. Abra um novo processo e cite o anterior nas observações. |

## 6. Glossário

- **CISSP:** Comissão Interna de Saúde e Segurança do Servidor Público.
- **PGR:** Programa de Gerenciamento de Riscos.
- **Inventário de riscos:** lista dos riscos de cada posto de trabalho. Ainda não existe no sistema.
- **NUP:** número único de protocolo do processo no SEI.
- **Posto de trabalho, Agente nocivo, Tipo de risco:** catálogos que já existem no sistema (menu Catálogos) e que o PGR futuro deve reaproveitar.

## 7. Limites conhecidos

- CISSP e PGR não existem como módulos: sem ata, sem mandato, sem inventário de riscos e sem plano de ação no sistema.
- O processo SEI "PGR" só rastreia o protocolo, sem inventário.
- Num processo "PGR" aparecem a aba "Parecer" e o botão "Novo parecer", que cria um rascunho de parecer sem uso nesse tipo.
- Os cartões em "Módulos" e na Visão geral não têm link, data prevista nem orientação de onde registrar enquanto isso.
- O catálogo de EPI e o checklist de Análise de Acidentes citam um PGR que ainda não existe.
- Não há e-mails, permissões nem perfis próprios de CISSP e PGR.

## 8. Decisões que dependem de você

- **Onde a unidade registra atas e o inventário** até os módulos existirem (SEI, pasta da comissão ou anexos do processo PGR). Combine e avise a equipe.
- **Quem controla os mandatos** da comissão e como.
- **Se aceita usar o processo tipo PGR** como pasta de guarda de material, sabendo que não é inventário e que o anexo fica com acesso "publico".
- **Pedir a data de entrega** dos módulos à equipe de desenvolvimento, pois o sistema não informa.
