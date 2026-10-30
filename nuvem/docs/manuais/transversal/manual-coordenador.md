# Sistema SISA: Acesso, conta e administração (Manual do Coordenador)

## Para quem é este manual

Para quem responde pelo funcionamento do sistema no dia a dia: acompanha pendências e indicadores, cuida de catálogos, prazos, auditoria e privacidade, e orienta quem precisa de acesso. Cobre as telas que não pertencem a um módulo só: entrada no sistema, conta, usuários e perfis, servidores, busca, pendências, relatórios, configuração, auditoria, importação, limpeza de dados e uso no celular.

Os nomes de pessoas, e-mails e números usados nos exemplos são inventados.

## Antes de começar

- Você entra com o seu e-mail e a sua senha em "Entrar".
- O que você pode fazer depende do perfil. Resumo para o perfil de **coordenador**:

| Você pode | Você não pode |
|---|---|
| Ver a Auditoria e conferir a cadeia de eventos | Abrir a tela Usuários nem Contas do Cadastre-se (aparece erro de permissão 403) |
| Editar os catálogos | Conceder ou encerrar perfis e o acesso por módulo |
| Ver nome e SIAPE de servidores (sem a máscara SRV-xxxx) | Gerar backup cifrado (é do admin de TI, do superintendente e do administrador do sistema) |
| Exportar tudo (.zip) | Usar "Limpar dados" (só o administrador do sistema) |
| Exportar o CSV de processos | Criar conta ou redefinir senha |
| Ajustar os prazos (SLA) na Configuração | Atestar habilitação técnica |
| Importar dados legados (planilha de pareceres e Trello) | |
| Juntar cadastros duplicados de participantes (Certificados e Treinamentos) | |
| Consultar a matriz de perfis (/perfis) e os níveis de acesso (/perfis/niveis), só para leitura | |

- Quem concede e encerra perfis e o acesso por módulo: **superintendente** e **administrador do sistema**. Quem cria contas e redefine senhas: **superintendente**, **administrador do sistema** e **admin de TI** (o admin de TI não anexa perfil nem servidor à conta). Atestar habilitação: **superintendente** e **administrador do sistema**. O administrador do sistema tem todas as permissões, menos assinar parecer e registrar laudo.
- Veem a Auditoria, além de você: superintendente, administrador do sistema, admin de TI e auditor interno.
- Na prática, quando alguém precisa de acesso, você pede a uma dessas pessoas. Combine com a sua equipe quem é o contato.

## Sumário

1. Entrar e sair
2. Visão geral e mapa de módulos
3. Pedido de conta e ativação de acesso
4. Minha conta
5. Usuários e perfis (o que você precisa saber, mesmo sem acesso)
6. Servidores e fichas
7. Setores e aparência
8. Busca global
9. Pendências e sino
10. Relatórios
11. Configuração
12. Auditoria
13. Duplicados, importação e limpeza de dados
14. Direitos do titular (LGPD)
15. Uso no celular
16. Rotina de acompanhamento
17. Erros e mensagens comuns
18. Glossário
19. Limites conhecidos

---

## 1. Entrar e sair

1. Abra o endereço do sistema.
2. Digite o seu e-mail e a senha e entre.
3. Se a senha for provisória, o sistema pede que você a troque antes de continuar (campos "Senha atual", "Nova senha" e "Confirme a nova senha"; botão "Salvar"). A senha nova precisa ter no mínimo 6 caracteres, com pelo menos 5 diferentes entre si, e não pode ser uma senha trivial nem igual à atual. As outras sessões abertas da conta são encerradas.
4. Para sair, use "sair" no topo. O sistema mostra a tela "Sair do sistema"; clique em "Sair" para encerrar.

A sessão parada é encerrada sozinha depois de 60 minutos sem uso, com aviso pouco antes (informação da tela Minha conta).

Avisos que aparecem na tela de entrada: sessão encerrada, inatividade, conta ativada, senha redefinida.

**Bloqueio.** Após 5 tentativas erradas a conta é bloqueada com a mensagem "Conta bloqueada até (hora)...". O bloqueio é temporário (15 minutos na configuração padrão) e termina sozinho; quem tem pressa pede a quem gerencia Usuários que use o botão "Desbloquear".

**Esqueci minha senha.** Na tela de entrada, use "Esqueci minha senha". O link recebido por e-mail vale 1 hora (30 minutos para contas de administração) e só pode ser usado uma vez. A resposta da tela é a mesma exista ou não conta com o e-mail.

Observação: a tela de primeiro acesso (criação do primeiro administrador) só existe enquanto o sistema não tem usuário nenhum; depois disso ela leva ao login. Este fluxo não foi verificado no teste que originou este manual.

## 2. Visão geral e mapa de módulos

- "Visão geral" (/inicio) mostra um cartão por módulo conforme o seu perfil e o seu acesso por módulo, com o que espera por você ("4 pendências suas", "2 pedidos a analisar"). "Ver todas as telas" abre o mapa.
- O mapa de módulos (/modulos) lista os módulos em uso (Processos SEI, Gestão de EPI, Certificados e Treinamentos, Análise de Acidentes, Ocorrências de Urgência e Emergência e Demandas) e a base compartilhada. CISSP e PGR aparecem em "Outros módulos (em desenvolvimento)", como "ainda não disponível".
- Quando o acesso a um módulo está como "sem acesso", o cartão some, mas continuam aparecendo as áreas que são da própria pessoa (como "Meu espaço" e "Minha atividade").
- Se alguém lhe disser que não vê nada e o mapa de módulos mostra "Nenhuma tela da base abre para você", a conta está sem perfil. Atenção: a mensagem diz que o acesso "se concede em Usuários", mas quem lê não consegue abrir essa tela. Encaminhe o caso a quem concede perfis.

## 3. Pedido de conta e ativação de acesso

Quem não é servidor entra pelo "Cadastre-se":

1. Em "Cadastre-se" a pessoa escolhe o vínculo: Servidor, Terceirizado ou Discente.
2. **Terceirizado e discente** preenchem e-mail, nome completo, senha e a caixa "Tenho 18 anos ou mais" e recebem por e-mail um link de confirmação, válido por 24 horas e de uso único. Ao clicar no botão de confirmação que o link abre, a conta é liberada automaticamente. O formulário não pergunta empresa nem curso.
3. O discente precisa de e-mail terminado em `@ufvjm.edu.br`.
4. A tela de resposta é a mesma, exista ou não conta com aquele e-mail. Isso é proposital. Há um teto de pedidos por hora por endereço de rede (5 para terceirizado e discente, 8 para servidor); passando dele, nada é enviado e a tela não avisa.
5. **Servidor** informa SIAPE (7 dígitos), e-mail institucional, nome completo e escolhe a senha na própria tela; recebe um link que só confirma o e-mail, válido por 24 horas e de uso único. Se o SIAPE não está no cadastro, o pedido cria o servidor (o sistema não confere o SIAPE). Se já está, o link só sai se o e-mail digitado for o da ficha; do contrário, ou se a ficha não tem e-mail, nada acontece e a pessoa não é avisada. Quem relata "não chegou nada" costuma estar nesse caso.

Para acompanhar as contas de terceirizados e discentes, quem gerencia Usuários tem a tela "Contas do Cadastre-se", com as ações "Bloquear", "Desbloquear" e "Excluir". Excluir apaga só a conta sem registros; a que já tem histórico é bloqueada no lugar. "Aprovar" e "Recusar" só aparecem para pedidos antigos, anteriores à liberação automática. Você, como coordenador, não abre essa tela (403); se perceber conta suspeita, avise quem a gerencia.

Servidor que já tem e-mail na ficha ganha uma conta automática, no perfil de consulta de servidor, e só precisa ativar o acesso.

## 4. Minha conta

Em "Minha conta" cada pessoa pode:

O título da tela é "Meu perfil"; abre-se pelo seu nome no menu ("Minha conta"). Cada pessoa pode:

- "Salvar dados" (nome, telefone e ramal; os dois últimos opcionais);
- "Trocar e-mail" (pede a senha atual; errar conta como tentativa de entrada);
- "Trocar senha";
- "Ligar minha conta" à ficha de servidor, quando for servidor: SIAPE, nome completo, cargo e lotação. O cadastro é criado e ligado na hora, sem conferir o SIAPE; se o SIAPE já existe com outro e-mail, é preciso procurar a equipe. Depois de ligada, o servidor corrige o próprio cargo, função e lotação ("Corrigir cargo, função ou lotação"), com efeito a partir de hoje;
- ver os "Perfis de acesso" da própria conta (somente leitura) e a seção "Privacidade (LGPD)".

Aviso: o selo "Conta de equipe" aparece também para terceirizado e discente. Não significa que a pessoa seja da equipe.

## 5. Usuários e perfis

A tela Usuários (/usuarios) é de quem concede perfis; você não a abre. Mesmo assim, como coordenador, convém entender como funciona, porque é para lá que vão os seus pedidos.

- **Criar conta** ("Cadastrar conta"): informa vínculo (Equipe, Servidor, Terceirizado ou Discente), nome, e-mail e, se tiver permissão, perfil de equipe, campus e ato normativo (para servidor, o SIAPE). A senha provisória é mostrada **uma única vez**, na faixa verde do topo; quem criou deve repassá-la com segurança. No primeiro acesso a pessoa é obrigada a trocá-la.
- **Conceder perfil**: informa usuário, perfil, campus (escopo), início e fim da vigência. O perfil nasce com o "ato normativo pendente" se o ato ainda não saiu; ele pode ser informado depois ("Salvar ato"). Regras: ninguém concede perfil a si mesmo; não se concede um perfil que a pessoa já tem (é preciso encerrar o anterior); só o administrador do sistema concede o perfil de administrador do sistema; não se concede mais do que o concedente possui.
- **Encerrar perfil**: também cancela uma concessão futura. O último concedente do sistema não pode ser encerrado.
- **Acesso por módulo** ("Salvar acesso por módulo"): quatro níveis, "Padrão do perfil", "Sem acesso", "Consulta" e "Operação", definidos por perfil e, como exceção, por pessoa (só para quem tem perfil de equipe). Quem tem vários perfis fica com a soma. Ninguém altera o próprio acesso.
- **Setores** ("Salvar setores"; em Certificados e Treinamentos a conta só vê e gere as turmas dos seus setores) e **vínculo com servidor** ("Salvar vínculo").
- "Desbloquear", "Inativar a conta", "Reativar conta" e "Resetar a senha" (nova provisória, mostrada uma vez, que derruba as sessões abertas).
- **Não há "Excluir" na tela Usuários.** Excluir existe só em "Contas do Cadastre-se", para terceirizado e discente: conta com registros é bloqueada, não apagada.
- **Habilitação** (atestar, ligar conta, corrigir, encerrar): atestam o superintendente e o administrador do sistema.

A matriz dos perfis (/perfis) e os níveis de acesso por perfil (/perfis/niveis) podem ser consultados por você, só para leitura.

**O que o coordenador pede e confere:** ao pedir um acesso, informe o e-mail da pessoa, o perfil, o módulo e o motivo. Depois de concedido, peça à pessoa que entre e confirme que enxerga os cartões esperados na Visão geral.

## 6. Servidores e fichas

A tela Servidores (/servidores) tem busca ("Buscar por nome ou SIAPE"), "Cadastrar servidor", "Importar servidores" (arquivo .csv ou .xlsx, com "Ver prévia" e "Confirmar importação"), e, na ficha, "Editar identificação" (nome, SIAPE, situação e e-mail), "Registrar mudança" (lotação, cargo, função e postos) e "Imprimir". A situação pode ser Ativo, Aposentado, Exonerado ou Cedido. A chave é o SIAPE; não existe campo de CPF.

- **Lotação** ("Registrar mudança"): informe "A partir de", a unidade e o "Documento que sustenta a mudança". A nova lotação precisa começar na data da atual ou depois dela, e o período anterior fecha na véspera.
- **Corrigir lotação** altera apenas documento e observação, não a data nem o setor.
- O próprio servidor também corrige cargo, função e lotação em Minha conta, a partir de hoje.
- Não existe excluir nem mesclar servidor.
- Quem tem o perfil de secretaria vê o servidor com código SRV-xxxx (sem nome), busca só por SIAPE, cadastra servidor novo, mas não corrige nome nem SIAPE. Você, coordenador, vê nome e SIAPE.
- Servidor cadastrado com e-mail recebe conta automática no perfil de consulta, mesmo que o e-mail não seja institucional. Confira o e-mail antes de gravar.

**Cuidado com a data da lotação.** Se você digitar uma data futura errada, a tela não deixa desfazer. Confira a data antes de confirmar. Se errar, peça apoio técnico.

## 7. Setores e aparência

Cada setor tem uma cor (de uma paleta fechada do sistema; cor fora da paleta é recusada com "Cor fora da paleta do sistema") e um ícone. Servem para reconhecer o setor nos cartões e nas listas. No seletor de unidade, algumas siglas aparecem repetidas, como "(IECT) (IECT)": é só aparência.

**Catálogos** (/catalogos) são com você: 13 catálogos (campi, unidades/UORG, postos de trabalho, cargos, agentes nocivos, tipos de risco, fundamentações legais, percentuais, textos padrão, portarias de localização, checklists modelo, autoridades destinatárias e setores emissores). Só você, o superintendente e o administrador do sistema editam; outros perfis com acesso apenas leem. Editar um catálogo não muda parecer já emitido (o parecer congela o conteúdo na emissão); textos padrão são versionados a cada mudança. Os setores emissores e as autoridades destinatárias aparecem na Configuração, mas se cadastram em Catálogos.

## 8. Busca global

1. Digite na caixa de busca do topo ("Buscar em todo o sistema"; atalho Ctrl+K). Procura nome, SIAPE, NUP, laudo, protocolo do pedido de EPI, turma e certificado, só no que a sua conta abre.
2. Aceita o NUP completo, com pontuação (`23086.100009/2026-60`) ou sem (17 dígitos), e a forma curta, como `100009/2026`.
3. A busca recusa qualquer número de 11 dígitos, que parece CPF, com a mensagem "A busca não aceita CPF...". Isso pega também um pedaço do NUP, como "23086.100008" ou "23086100008". Digite o NUP completo ou a forma curta.
4. Você vê nomes de servidores e pode buscar por nome; a secretaria, que vê SRV-xxxx, busca só por SIAPE.

## 9. Pendências e sino

- O sino mostra quantas pendências são suas; a contagem bate com os cartões.
- "Pendências" (/pendencias) lista tudo; os links "Todas" e "Só as minhas" alternam o filtro (`minhas=1`). A tela informa quantas passaram do prazo e traz "Concluídas recentemente".
- Pendência não se cria à mão: nasce de regra do sistema (parecer assinado a incluir no SEI, troca de EPI vencida, comprovante a anexar, CA de lote a vencer). "Tarefa" diz o que fazer; "Onde" leva à tela.
- Cada pendência tem o botão "concluir"; a conclusão fica na Auditoria com quem fechou.
- Não há como reabrir nem passar a pendência para outra pessoa.
- O sistema deixa concluir a pendência mesmo sem o item de que ela depende (por exemplo, o número SEI de um parecer). Confira antes de concluir.
- O admin de TI não tem sino nem acessa Pendências.

## 10. Relatórios

A tela "Relatórios" (/relatorios) cobre só o módulo Processos SEI: por exercício, processos por unidade, pareceres por tipo de risco, lacunas de numeração, laudos nunca conferidos ou com mais de 24 meses e adicionais vigentes por laudo. O botão "Exportar processos (CSV)" (disponível a coordenador, superintendente, engenheiro, médico, técnico, consulta PROGEP, auditor interno e administrador do sistema; secretaria e almoxarife recebem recusa) traz nome e SIAPE para quem pode lê-los. Trate o arquivo como dado pessoal: guarde em local protegido e apague quando não precisar mais. Esse download não deixa registro na Auditoria.

## 11. Configuração

A Configuração abre pela engrenagem ao lado do seu nome. Para o coordenador mostra: setor emissor e autoridade destinatária (só leitura; cadastro em Catálogos), SLA, integração com o SEI, retirada de EPI e "Backup e exportação".

- **SLA** ("Editar os prazos", "Salvar SLA"): prazo em dias por coluna (Não iniciado, A fazer, Em andamento, Aguardando, Concluído), de 0 a 3650; 0 desliga o alerta. O contador mede quanto tempo o processo está parado naquela coluna. Mensagens: "SLA atualizado." ou "Nada mudou: os prazos já eram esses."
- **Backup**: gerado por admin de TI, superintendente ou administrador do sistema ("Fazer backup cifrado agora"; resposta "Backup cifrado gerado: backups/csso-....enc"). Você não vê esse botão nem o bloco de envio de e-mail.
- **Exportar tudo (.zip)** ("Exportar tudo agora"): para você, o superintendente e o administrador do sistema. Sai **em claro, sem senha**, com o banco inteiro, CSVs com nome e SIAPE e todos os anexos (inclusive comprovantes de EPI assinados), sem os hashes de senha; uma cópia fica guardada na instalação e não é apagada sozinha. O evento fica na Auditoria. Nunca copie para nuvem pessoal ou de terceiros.
- **Retirada de EPI**: se aparecer "Não informado", peça à TI que preencha o local de retirada (variável `CSSO_EPI_LOCAL_RETIRADA`), senão a ficha do pedido diz que o local não está registrado.
- O texto "A v1 não integra com o SEI" está desatualizado (a versão da instalação aparece como v2.0.0): continua valendo que o sistema não integra com o SEI; o NUP é digitado e validado localmente.

## 12. Auditoria

A trilha registra quem fez o quê e quando, em eventos encadeados.

1. Abra "Auditoria".
2. Filtre por "Quem agiu", "Conta afetada", "Entidade" ou "Tipo de evento" e clique em "Filtrar" ("Limpar" volta ao todo). A lista mostra 50 eventos por página, com "próxima »".
3. Use "Conferir a cadeia inteira" para verificar que nada foi alterado. Resultado esperado, por exemplo: "Cadeia conferida em (data) — 262 evento(s), encadeamento íntegro".
4. Mais abaixo, "Acessos a dado sensível" registra, com a finalidade, cada leitura nominal (25 por página).

Se a conferência acusar quebra, pare e acione a TI e o superintendente. Alguns eventos de alteração de dados (campo alterado, usuário alterado, e-mail alterado, usuário excluído) trazem valores pessoais; trate a tela como confidencial.

## 13. Duplicados, importação e limpeza de dados

- **Juntar cadastros duplicados** (/treinamentos/participantes, no módulo Certificados e Treinamentos): lista possíveis cadastros repetidos de participantes. Você pode abrir e juntar; técnico, secretaria e admin de TI recebem recusa. A fusão real não foi verificada.
- **Importar dados legados** (menu "Importar", módulo Processos SEI; você pode): "Planilha de pareceres" (.xlsx) e "Quadro do Trello" (JSON completo). Por padrão apenas **simula**; só grava se a caixa "aplicar de verdade" for marcada. O que não entra aparece em "Rejeitados", com o motivo. Mensagens possíveis: sem arquivo, arquivo inválido, "não parece um export do Trello". Não há tela para escolher a correspondência das listas do Trello.
- **Importar servidores** (dentro de /servidores; você pode): colunas SIAPE; Nome; Cargo; UORG; E-mail e Campus opcionais. Mostra uma prévia ("Ver prévia") e só grava em "Confirmar importação". Cuidado: completa com zeros à esquerda SIAPEs curtos, atualiza o nome de servidores já existentes, cria cargos que não existem e cria contas sem senha. Leia a prévia com atenção.
- **Limpar dados** (/config/limpar-dados): só o administrador do sistema. Primeiro "Simular"; depois "Fazer o backup e apagar", digitando a frase exata "APAGAR DADOS DE TESTE", a identidade do banco e a senha. Existe ainda a caixa de apagar também as contas. Serve para ambiente de teste. O texto na tela fala em quatro módulos, mas são cinco.

Você não executa a limpeza, mas deve saber que ela existe e pedir só o necessário.

## 14. Direitos do titular (LGPD)

Em "Minha conta" há a seção "Privacidade (LGPD)", que lista os direitos do art. 18 da lei (confirmar o tratamento, acessar, corrigir, saber com quem se compartilha) e apenas orienta falar com o encarregado, sem informar o contato. Não há no sistema uma tela para pedidos de titulares. Como coordenador, tenha à mão o contato do encarregado da UFVJM para repassar. Cuidados práticos:

- mostre nome e SIAPE só a quem precisa;
- trate CSV e .zip exportados como dados pessoais;
- prefira identificadores (NUP, SRV) a nomes em e-mails e mensagens.

## 15. Uso no celular

"Celular" (/celular) traz atalhos de trabalho: "Balcão de EPI" (para quem entrega EPI, como o almoxarife; botões "Registrar entrega" e "Registrar outra entrega") e "Chamada" (para quem avalia turmas: você, engenheiro, médico, técnico e secretaria; o almoxarife não vê). O servidor vê "Meus treinamentos", "Meus certificados", "Comprovante de treinamentos" e "Minha ficha de EPI". Perfis sem tarefa de campo, como o admin de TI, veem "Esta tela ainda não tem trabalho para você." Sem conexão, a tela abre mas nada se consulta nem se grava. O sistema pode ser adicionado à tela inicial do aparelho.

## 16. Rotina de acompanhamento

**Todo dia**
- Olhar o sino e as pendências do seu módulo.
- Atender pedidos de acesso: se alguém não consegue entrar, verifique se é senha, bloqueio ou conta sem perfil, e encaminhe.

**Toda semana**
- Pendências atrasadas na lista, com os responsáveis.
- Pedidos de conta aguardando decisão (avise quem os gerencia).

**Todo mês**
- "Conferir a cadeia inteira" na Auditoria.
- Rever, junto com o superintendente, quem tem perfil e acesso a quê, e pedir o encerramento do que não for mais necessário.
- Conferir os prazos (SLA) na Configuração.
- Verificar se há backup recente com a TI.

**Sinais de que o módulo está saudável**
- A cadeia da Auditoria está íntegra.
- A contagem do sino bate com as pendências.
- Ninguém está com perfil que não usa.
- Não há pendências antigas sem responsável.

## 17. Erros e mensagens comuns

| Mensagem | O que significa | O que fazer |
|---|---|---|
| "Usuário ou senha inválidos." | Dados incorretos | Conferir o e-mail; usar "Esqueci minha senha" |
| "Conta bloqueada até (hora)..." | 5 erros seguidos; o bloqueio dura 15 minutos | Esperar ou pedir desbloqueio a quem gerencia Usuários |
| "Senha atual incorreta. Restam N tentativas..." | Troca de senha com senha atual errada | Digitar de novo com cuidado |
| "Senha fraca: ..." | Não atende às regras | Escolher outra, mais longa e variada |
| "A confirmação não confere." | As duas senhas novas diferem | Redigitar |
| "A senha nova é igual à atual: escolha outra." | | Escolher outra |
| Erro 403 | Seu perfil não tem a permissão | Pedir ao superintendente, se for necessária |
| "A busca não aceita CPF..." | Número com 11 dígitos | Digitar o NUP completo ou `100008/2026` |
| "Cor fora da paleta do sistema" | Cor inválida | Escolher da paleta |
| "a nova lotação precisa começar em ou depois do início da atual (2027-01-01)" | A data fica antes da lotação atual (a data aparece como ano-mês-dia) | Informar data posterior |
| "Perfil e servidor pedem a permissão perfil.conceder: crie a conta sem eles." | Admin de TI tentou anexar perfil ou servidor | Pedir a quem concede perfil |
| Link de e-mail "expirado" | Passou de 24 h (confirmação do cadastro, inclusive do servidor), 1 h (recuperação de senha; 30 min em conta de administração) ou 72 h (pedido aprovado pela equipe) | Refazer o pedido |
| "Digite o SIAPE com 7 dígitos." / "Use o seu e-mail institucional (@ufvjm.edu.br)." | Dados do Cadastre-se de servidor fora do formato | Corrigir e enviar de novo |
| "A conta de ... já tem registros no sistema ... foi bloqueada no lugar" | Exclusão de conta com histórico em Contas do Cadastre-se | Esperado: a conta fica bloqueada, não apagada |

## 18. Glossário

- **NUP**: número único do processo.
- **SIAPE**: matrícula do servidor.
- **SRV-xxxx**: código que substitui o nome do servidor para perfis sem direito de vê-lo.
- **SLA**: prazo, em dias.
- **Perfil**: conjunto de permissões de uma pessoa (coordenador, técnico, secretaria etc.).
- **Acesso por módulo**: padrão, sem acesso, consulta ou operação.
- **Ato normativo**: documento que formaliza a concessão do perfil.
- **Trilha de auditoria**: registro encadeado de quem fez o quê.
- **LGPD**: lei de proteção de dados pessoais.

## 19. Limites conhecidos

Pontos do sistema que afetam o uso e como contorná-los:

- **Lista de usuários**: não tem busca, filtro nem paginação e fica pesada com muitas contas. Quem a usa precisa rolar e localizar manualmente.
- **Lotação futura errada** não pode ser desfeita pela tela. Confira a data.
- **Autocadastro de servidor**: o sistema não confere o SIAPE informado. Para a gestão de acessos, desconfie de pedidos sem origem conhecida.
- **Conta automática**: criada para qualquer e-mail informado na ficha do servidor, mesmo não institucional. Confira o e-mail.
- **Pendência**: concluída sem checar pré-requisitos; sem reabrir e sem reatribuir.
- **Auditoria**: alguns eventos trazem valores pessoais; sem rastro do download do CSV de processos.
- **Privacidade**: sem canal nem registro de pedidos do titular dentro do sistema.
- **Busca**: confunde o começo de um NUP com CPF; NUP sem pontuação não acha.
- **Secretaria**: cadastra servidor mas não consegue conferir nem corrigir.
- **Gestão de contas**: concentrada em poucas pessoas (superintendente e administrador do sistema concedem; esses mais o admin de TI criam conta). Mantenha mais de uma pessoa habilitada para concessões.
- **Cadastre-se de servidor**: quando o SIAPE já existe e o e-mail digitado não é o da ficha (ou a ficha não tem e-mail), nada é enviado e a pessoa não é avisada; o relato típico é "não chegou o e-mail".
- Textos desatualizados ou imprecisos: Limpar dados (quatro módulos, mas são cinco), selo "Conta de equipe", orientação para conta sem perfil, versão na Configuração, coluna "Empresa ou curso" sempre vazia, sigla duplicada no seletor de unidade.
- **Mensagens de recusa** às vezes mostram códigos de permissão ou frases cortadas; erros de data e de nível podem aparecer em formato técnico cru. Anote o que apareceu e avise a TI.
- **Importação**: sem tela de mapeamento do Trello; CSV de servidores altera dados existentes sem alerta.
- **Não verificados** no teste: tela de primeiro acesso, desconexão por 60 min de inatividade (anunciada na tela Minha conta, mas não cronometrada), envio real de e-mail (nos testes o envio estava desligado e as mensagens ficaram na fila de saída), execução de Limpar dados, planilhas .xlsx, fusão de duplicados, teto de pedidos por hora do Cadastre-se e interface de integração (/api/v1).
