# HTTPS na rede do setor

Escrito na versão 1.43.0. Vale para a máquina que atende a rede da CSSO.

Sem HTTPS, a senha de quem entra e o cookie de sessão viajam **em claro** pela
rede: qualquer máquina no mesmo segmento que escute o tráfego lê os dois. O
ROPA §6 registra isso como risco aceito "enquanto não houver TLS". Este passo a
passo é o que tira essa frase de lá.

## Como funciona, em uma frase

A máquina do setor cria uma **autoridade certificadora (AC) própria**, que só
vale para o endereço do sistema. Cada estação instala a raiz dessa AC **uma
vez**. Daí em diante o navegador abre `https://…` com o cadeado, sem aviso.

A AC é **restrita por nome**: se a chave dela (`ca.key`) vazar, ela não serve
para forjar HTTPS de outro site nas estações. Só serve para o endereço do
sistema. O porquê e os testes que provam isso estão em `app/servicos/tls.py` e
`testes/unitarios/test_tls.py`.

---

## 1. Na máquina do setor: gerar o certificado

Na pasta do sistema, com o IP fixo da máquina (e o nome dela, se o TI tiver dado
um):

```bash
uv run python -m ferramentas.certificado_tls 10.0.73.198
```

Sai assim:

```
Certificado do servidor gerado para: 10.0.73.198
Vence em 24/10/2027. Para renovar, rode este mesmo comando.

AC NOVA criada. Instale a raiz em CADA estação que abre o sistema:
  arquivo: C:\Projetos\Sistema CSSO\dados\tls\ca.crt
  ...
No .env desta máquina (e reinicie o sistema):
  CSSO_TLS_CERTIFICADO=dados/tls/servidor.crt
  CSSO_TLS_CHAVE=dados/tls/servidor.key
```

Ponha as duas linhas no `.env` e reinicie (`PARAR.bat`, `INICIAR.bat`). A
janela passa a dizer `HTTPS: …` e `Abrindo https://10.0.73.198:8765/`.

**A partir daqui a porta só fala HTTPS.** Quem tiver `http://10.0.73.198:8765`
nos favoritos precisa trocar para `https://`.

## 2. Em cada estação: instalar a raiz

Copie **só o `ca.crt`** para a estação (pen drive, pasta de rede). **Nunca o
`ca.key`**: ele não sai da máquina do setor.

Num prompt **como administrador**, na pasta onde está o arquivo:

```
certutil -addstore -f Root ca.crt
```

Feche e reabra o navegador. Chrome e Edge usam o repositório do Windows e
passam a aceitar na hora. **O Firefox tem repositório próprio.** Nele, vá em
Configurações → Privacidade e Segurança → Certificados → Ver certificados →
Autoridades → Importar, e marque "Confiar nesta AC para identificar sites".

Se o TI da UFVJM puder distribuir por GPO (Configuração do Computador →
Políticas → Configurações do Windows → Configurações de Segurança → Políticas
de Chave Pública → Autoridades de Certificação Raiz Confiáveis), é o mesmo
arquivo e dispensa ir de máquina em máquina.

## 3. Conferir

Na estação, abra `https://10.0.73.198:8765/`. Tem de aparecer o cadeado **sem**
aviso nenhum. Se aparecer "Sua conexão não é particular":

| O que o navegador diz | Causa | Saída |
|---|---|---|
| `NET::ERR_CERT_AUTHORITY_INVALID` | A raiz não foi instalada nesta estação (ou foi, e o navegador não foi reaberto) | Passo 2 |
| `NET::ERR_CERT_COMMON_NAME_INVALID` | O endereço digitado não é o do certificado (outro IP, `localhost`, nome sem ter sido incluído) | Use o endereço impresso no passo 1, ou gere de novo incluindo o nome |
| `ERR_SSL_PROTOCOL_ERROR` ou página em branco | `http://` numa porta que só fala HTTPS | Troque para `https://` |
| `NET::ERR_CERT_DATE_INVALID` | O certificado venceu | Passo 4 |

**Não ensine ninguém a clicar em "Avançado → continuar".** O aviso só vale
alguma coisa se ninguém se acostumar a passar por ele.

## 4. Renovar (uma vez por ano)

O certificado do servidor dura 397 dias, o teto que os navegadores aceitam.
Trinta dias antes do vencimento, o `/saude`, a janela do servidor e a faixa no
alto de toda tela passam a avisar. Para renovar, rode o **mesmo comando** do
passo 1 e reinicie o sistema. A AC é reaproveitada, então **as estações não
precisam de nada**.

Para ver quando vence: `uv run python -m ferramentas.certificado_tls --ver`.

## 5. Mudou o IP ou o nome da máquina

A AC só vale para os endereços com que foi criada. Endereço novo pede AC nova:

```bash
uv run python -m ferramentas.certificado_tls 10.0.73.200 --nova-ac
```

Com AC nova, é preciso **reinstalar a raiz em todas as estações** (passo 2). É o
preço da restrição, e é o certo: mudar o endereço do sistema já é um evento que
todo mundo precisa saber.

## 6. Backup e cópia da pasta

`dados/tls/` fica fora do Git (tem a chave da AC). O `ca.key` merece o mesmo
cuidado da `CSSO_BACKUP_SENHA`: se a máquina do setor for trocada, leve a pasta
`dados/tls/` junto, pelo mesmo meio seguro dos dados. Sem ela, a máquina nova
precisa de AC nova e de reinstalação em todas as estações.

## 7. Depois de ligar: o que emendar

- **ROPA §6, item 2** ("A conexão não é criptografada"): passa a ser falso.
  Registre a data em que o HTTPS entrou e a versão do ROPA.
- **`PENDENCIAS.md`**: tire o HTTPS das lacunas técnicas.

No ambiente de teste, o `RECRIAR-TESTE.bat` apaga `dados-teste/`, inclusive o
`dados-teste/tls/`. Quem quiser o teste em HTTPS gera de novo com
`--pasta dados-teste/tls` e reinstala a raiz de teste.
