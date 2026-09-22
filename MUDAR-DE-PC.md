# Continuar o desenvolvimento em outro computador

Escrito na versão 1.39.1. Vale para levar a pasta inteira para outra máquina —
seja para desenvolver, seja para trocar a máquina que atende o setor.

**Copiar a pasta não basta**, e o motivo não é o código: o código atravessa
inteiro. O que não atravessa são as quatro coisas que apontam para *esta*
máquina — o endereço de rede, o ambiente Python, o caminho do LibreOffice e a
senha do backup. Três delas falham com mensagem enganosa, e uma falha em
silêncio anos depois. Este arquivo é a ordem que evita as quatro.

---

## Antes de tudo: qual máquina manda?

A pergunta não é burocrática. `dados/csso.db` é um arquivo, e agora existem
**duas cópias dele**. Se as duas forem usadas para trabalhar, elas divergem — e
não há como juntar depois:

- a numeração de parecer é sequencial por lei de negócio (RN-03, nunca `MAX+1`).
  As duas máquinas emitiriam o **mesmo número** para pareceres diferentes;
- a trilha de auditoria é encadeada por SHA-256. Duas cadeias que partem do mesmo
  ponto não se fundem: uma delas teria de ser descartada inteira;
- anexos e documentos gerados ficam no disco de quem os gerou.

Decida agora, e anote aqui embaixo:

```
Máquina que vale (produção): a de origem, na rede do setor (10.0.73.198)
Máquina de desenvolvimento:  Desktop_Ryzen (usuário bisso) — só dados-teste/, porta 8766
Decidido em: 05/09/2026
```

Na máquina de desenvolvimento, **não trabalhe com dado real**. O caminho pronto
para isso é o `RECRIAR-TESTE.bat` (passo 8) — banco separado, gente inventada,
porta 8766.

---

## 1. Apague o que não atravessa

Na **pasta da máquina nova**, antes de qualquer coisa:

```bash
cd "C:\Projetos\Sistema CSSO"; Remove-Item -Recurse -Force .venv,.pytest_cache,csso.egg-info,.coverage,dados-teste,dados-teste2 -ErrorAction SilentlyContinue; Get-ChildItem -Recurse -Force -Directory -Filter __pycache__ | Remove-Item -Recurse -Force
```

A segunda metade existe porque `__pycache__` não é uma pasta só: há uma dentro de
`app\`, de `app\rotas\`, de `app\servicos\`, de cada pasta de `testes\`.

Por quê cada um:

| O que | Por que não atravessa |
|---|---|
| `.venv\` | O `pyvenv.cfg` guarda o caminho absoluto do Python **desta conta de usuário** (`C:\Users\Usuário\AppData\...`). Na máquina nova esse caminho não existe. São 127 MB que o `uv sync` refaz em minutos. |
| `__pycache__\`, `.pytest_cache\`, `.coverage` | Cache com caminho absoluto embutido. Confunde o pytest e não serve para nada. |
| `csso.egg-info\` | Refeito na instalação. |
| `dados-teste\`, `dados-teste2\` | Ambiente descartável, refeito pelo `RECRIAR-TESTE.bat`. |

O que **precisa** ter vindo: `app\`, `alembic\`, `testes\`, `ferramentas\`,
`docs\`, `entrada\`, `dados\`, os `.bat`, `pyproject.toml`, **`uv.lock`** (é ele
que garante as mesmas versões de biblioteca) e **`.env`**.

Desde a 1.42.0 existe também `frontend\` (o app compilado). Dele viaja o código
e o bundle já construído em `app\estaticos\app\`; **`frontend\node_modules\`
não viaja** (é o `.venv` do Node — refaz-se com `npm install`, e só quem
desenvolve o front precisa). Sem o Node a máquina roda o sistema inteiro,
inclusive `/app`, porque o bundle já está montado.

---

## 2. O `.env` — o passo que não dá para errar

### 2.1 Não deixe criar um novo

O `INICIAR.bat` cria um `.env` sozinho quando não encontra nenhum, com
**`CSSO_BACKUP_SENHA` nova e aleatória**. Se isso acontecer, os backups cifrados
que vieram junto (inclusive `dados\backups_preservados\csso-20260812-115750.db.enc`,
18 MB, o que tem os 640 processos) ficam **impossíveis de abrir para sempre**.
Não há recuperação: a senha é a chave.

Confira que o arquivo chegou **antes** de rodar qualquer `.bat`:

```bash
Test-Path "C:\Projetos\Sistema CSSO\.env"
```

Se voltar `False`, pare e copie o `.env` da máquina de origem.

### 2.2 Corrija `CSSO_HOST`

Nesta máquina o `.env` está com `CSSO_HOST=10.0.73.198` — o IP **desta**
máquina, posto ali quando o sistema foi aberto para a rede do setor. Na máquina
nova esse endereço não existe, e o sintoma é cruel: a janela preta fecha com
`WinError 10049 - o endereço solicitado não é válido no contexto`, sem dizer em
lugar nenhum que o problema é uma linha do `.env`.

Abra o `.env` no Bloco de Notas e deixe:

```
CSSO_HOST=127.0.0.1
```

`127.0.0.1` é o certo para desenvolver: só a própria máquina alcança. Se esta
nova máquina for a que atende o setor, aí sim ponha o IP **dela** (descubra com
`ipconfig`) — e leia antes `entrada/implantacao/01_REDE_DO_SETOR.md`, porque
abrir a porta sem a regra de firewall não é "abrir para o setor".

### 2.3 Enquanto o arquivo está aberto

- **`CSSO_TRELLO_KEY` e `CSSO_TRELLO_TOKEN`**: a migração do Trello acabou. Estas
  duas linhas são credencial viva de uma conta sua, e agora existem em duas
  máquinas. Revogue em <https://trello.com/power-ups/admin> e apague as linhas —
  nos dois computadores.
- **`CSSO_SOFFICE`** está vazio, e o sistema procura o LibreOffice sozinho nos
  caminhos padrão. Só preencha se o LibreOffice estiver instalado fora do
  `C:\Program Files\LibreOffice`.
- **`CSSO_CHAVE_SECRETA`**: mantenha a mesma se as sessões abertas devem
  continuar valendo; troque se esta cópia for para um ambiente separado. Trocar
  derruba todo mundo que estiver logado — é para isso que ela serve.
- **`.env.antes-da-rede`**: apague. É uma cópia velha do `.env`, com senha de
  backup e chave secreta dentro, sem função nenhuma.

---

## 3. Confira antes de subir

```bash
cd "C:\Projetos\Sistema CSSO"; .\CONFERIR-MUDANCA.bat
```

Ele instala o `uv`, refaz o ambiente (`uv sync --extra dev`, primeira vez demora),
e então confere **as cinco coisas que a suíte de testes não alcança, porque
nenhuma delas está no código**:

1. o endereço de `CSSO_HOST` pertence a esta máquina (liga na porta 0, então roda
   com o sistema no ar sem disputar a 8765);
2. o `.env` existe e não é o de exemplo;
3. o banco abre, passa no `integrity_check`, está na migração que o código
   espera, e o `-wal` não ficou com escrita pendente;
4. as pastas de dados existem e não estão em nuvem;
5. o LibreOffice foi encontrado.

Depois ele roda a suíte inteira. **Verde é `2238 passed`, sem skip** (na 1.42.2, com o LibreOffice instalado). Sem o LibreOffice é `2237 passed, 1 skipped`: o que pula é o teste-ouro do PDF.

### Compare os números

O `CONFERIR-MUDANCA.bat` imprime a contagem de linhas. Estes são os números
**desta máquina em 05/09/2026** — se lá der diferente, algo ficou para trás:

| tabela | linhas |
|---|---|
| processo | 0 |
| parecer_tecnico | 0 |
| laudo_tecnico | 0 |
| adicional_vigencia | 0 |
| servidor | 1 |
| anexo | 0 |
| demanda | 0 |
| epi_requisicao | 0 |
| epi_item | 0 |
| turma | 0 |
| participante | 0 |
| certificado | 0 |
| usuario | 1 |
| historico_evento | 4 |
| **TOTAL (74 tabelas)** | **392** |

**Repare no que estes números dizem:** o banco de trabalho está praticamente
vazio. As 392 linhas são quase todas tabela de apoio — perfis, permissões,
campus, tipos. **Os 640 processos não estão em `dados\csso.db`**; estão dentro
do backup cifrado de 12/08, que nunca foi restaurado. Aquela decisão pendente
viaja junto com a pasta, e continua pendente. Está em `PENDENCIAS.md`.

---

## 4. LibreOffice

Se o passo 3 avisou que não achou: instale o LibreOffice na máquina nova. Sem
ele a emissão **não falha** — entrega o `.docx` com o aviso "PDF indisponível" —
mas o PDF para de sair sozinho, e quem não souber disso vai achar que quebrou.

---

## 5. Prove que a senha do backup atravessou

Este é o passo que quase todo mundo pula, e é o único que descobre **hoje** um
estrago que só apareceria no dia em que o backup fosse necessário. Restaure o
backup preservado num destino descartável — ele **não toca** em `dados\`:

```bash
cd "C:\Projetos\Sistema CSSO"; New-Item -ItemType Directory -Force "$HOME\prova-backup" | Out-Null; uv run python -m ferramentas.backup_cli restaurar "dados\backups_preservados\csso-20260812-115750.db.enc" "$HOME\prova-backup\banco.db"
```

- **Funcionou** (`Banco restaurado em ...`): a senha atravessou.
- **Falhou**: o `.env` que está aí **não é** o da máquina de origem. Volte ao
  passo 2.1 antes de gerar qualquer backup novo.

Apague a pasta assim que ler o resultado — ela tem o banco **em claro**, com os
dados pessoais todos, fora de `dados\`:

```bash
Remove-Item -Recurse -Force "$HOME\prova-backup"
```

Esta prova foi feita em 05/09/2026 na máquina de origem, e o backup abriu: **640
processos, 14 pareceres, 5 laudos, 78 linhas de anexo e 7.634 eventos de
auditoria**, na migração `9305283613f3` — bem atrás do código de hoje
(`a7c4e91d0f52`). É o material da decisão pendente do passo 3, e agora se sabe
que ele está inteiro e legível. O que restaurar exige está detalhado em
`PENDENCIAS.md`, seção "O banco vivo está vazio" — inclusive que **os arquivos
dos anexos não estão dentro deste backup** (ele é do formato antigo, anterior à
correção da 1.31.0): as 78 linhas apontariam para arquivos que precisam ser
repostos a partir de `entrada\anexos_trello\`, conferindo pelo `sha256`.

---

## 6. Suba e entre

```bash
cd "C:\Projetos\Sistema CSSO"; .\INICIAR.bat
```

Abre em <http://127.0.0.1:8765/>. **A conta é a mesma** — usuário e senha viajam
dentro do banco, não da máquina. Para ver quais contas vieram:

```bash
cd "C:\Projetos\Sistema CSSO"; uv run python -m ferramentas.senha_cli --listar
```

E se a senha se perdeu (o sistema não manda e-mail; não há recuperação pela
tela). Ela é digitada no terminal, nunca passada por argumento:

```bash
cd "C:\Projetos\Sistema CSSO"; uv run python -m ferramentas.senha_cli Bisso
```

---

## 7. Confira a trilha de auditoria

```bash
cd "C:\Projetos\Sistema CSSO"; uv run python -m ferramentas.conferir_cadeia
```

Tem de dizer **"Cadeia íntegra"**. Se disser "CADEIA ROMPIDA", o arquivo do
banco chegou corrompido na cópia: preserve o arquivo como está e volte ao
original. Não conserte pela tela.

Enquanto estiver nisso, vale refazer as três tarefas agendadas na máquina nova
(elas **não** viajam na pasta): o backup diário, a conferência da cadeia às
3h30 e a varredura de pendências de EPI às 3h45. Os comandos `schtasks` estão
nos cabeçalhos de [ferramentas/conferir_cadeia.py](ferramentas/conferir_cadeia.py)
e [ferramentas/varrer_pendencias.py](ferramentas/varrer_pendencias.py).

---

## 8. Ambiente de teste (para desenvolver sem tocar em dado real)

```bash
cd "C:\Projetos\Sistema CSSO"; .\RECRIAR-TESTE.bat
```

Banco separado em `dados-teste\`, 8 contas inventadas, senha `teste2026`, porta
8766. É aqui que você mexe quando a máquina nova for a de desenvolvimento.

---

## 9. Para o Claude Code continuar sabendo do projeto

O histórico das conversas e a memória do projeto **não estão na pasta do
sistema** — ficam no seu perfil de usuário:

```
C:\Users\<seu-usuário>\.claude\projects\C--Projetos-Sistema-CSSO\
```

Duas coisas, se quiser continuar de onde parou:

1. copie essa pasta para o mesmo lugar no perfil da máquina nova;
2. **mantenha o projeto em `C:\Projetos\Sistema CSSO`**. O nome daquela pasta é o
   caminho do projeto com as barras trocadas por traços — mudar o caminho do
   projeto faz o Claude Code procurar em outro lugar e não achar nada.

O `.claude\settings.local.json` e o `.claude\launch.json` da própria pasta do
projeto já viajaram com ela.

---

## Dados pessoais: como a cópia foi feita importa

`dados\`, `entrada\` e os backups têm nome, SIAPE, lotação e parecer de
servidores reais da UFVJM. O sistema é o mesmo, a base legal é a mesma — mas o
**meio** pelo qual a pasta viajou é tratamento de dado pessoal por conta própria:

- **pen drive ou HD externo pessoal**: apague com formatação depois de conferir a
  cópia, e não deixe a pasta lá "por garantia";
- **OneDrive, Google Drive, Dropbox, WeTransfer, e-mail, WhatsApp**: é
  compartilhamento com operador não contratado — LGPD arts. 33 a 36, 39 e 46.
  Apague da nuvem (**e da lixeira dela**) e registre o que houve. Não há
  autorização de nuvem para este sistema, e o `LEIA-ME.txt` diz isso por escrito;
- **rede institucional da UFVJM ou cabo direto**: é o caminho certo.

E o de sempre: a pasta `dados\` **não pode ficar** dentro de pasta sincronizada
na máquina nova. Além da LGPD, a sincronização corrompe SQLite. O passo 3 avisa
se você deixar.

Se a máquina antiga deixar de ser usada, `docs/POLITICA_RETENCAO.md` vale para
ela: o disco tem banco, anexos, documentos, logs de acesso e backups.

---

## Quando a suíte falha na máquina nova

| Sintoma | O que é |
|---|---|
| Erro logo na coleta, antes de qualquer teste | Falta `.env`, ou ele veio com BOM. O arquivo tem de ser UTF-8 **sem BOM** — o Bloco de Notas do Windows salva com BOM se você escolher "UTF-8 com BOM". |
| `No space left on device` | Sucata de execuções antigas do pytest na pasta temporária. Já chegou a 11,7 GB nesta máquina. Apague `$env:TEMP\pytest-*`. |
| Testes de PDF pulados | Normal **sem** LibreOffice: é o `1 skipped`. Com ele instalado, a suíte roda sem skip nenhum. |
| Acentuação errada em mensagens (`Ã§`, `Ã£`) | Alguém editou arquivo `.py` com PowerShell (`Set-Content`/`Out-File`). Não faça isso: o PowerShell 5.1 grava em cp1252 e destrói o arquivo. |
| `Cannot assign requested address` / `WinError 10049` | `CSSO_HOST` — passo 2.2. |

---

## Resumo

```
1. apagar .venv, caches, dados-teste
2. .env: confirmar que veio, corrigir CSSO_HOST, apagar chaves do Trello
3. CONFERIR-MUDANCA.bat   -> sem ERRO + 2150 passed
4. instalar LibreOffice
5. provar a senha do backup
6. INICIAR.bat
7. conferir_cadeia        -> "Cadeia íntegra"
8. RECRIAR-TESTE.bat
9. copiar a memória do Claude Code
```
