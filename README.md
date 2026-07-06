# Console de Mentoria em Oncologia Veterinária — App completo

Este projeto reúne, num só servidor:
- o **app web** (chat, upload de PDF, microfone) — pasta `public/`
- o **bot de WhatsApp**
- o **acervo de materiais** (`docs.json`), compartilhado pelos dois canais

Ou seja: um material adicionado no app web já fica disponível também para quem pergunta
pelo WhatsApp, e vice-versa.

## O que você precisa

1. Uma chave de API da Anthropic: [console.anthropic.com](https://console.anthropic.com/)
2. (Opcional, para o WhatsApp) Uma conta no [Meta for Developers](https://developers.facebook.com/)
3. Uma hospedagem para o servidor Node.js. Sugestão simples: **Render** (render.com) —
   tem plano gratuito para começar e paga poucos dólares/mês depois, quando a turma crescer.
4. Seu domínio `vetjoicefaria.com`, que você já tem.

## Passo a passo para colocar no ar

### 1. Subir o código para o GitHub
Crie um repositório (pode ser privado) e suba esta pasta. Se preferir, posso te ajudar
a fazer isso direto daqui.

### 2. Criar o serviço no Render (ou Railway/Fly.io — o processo é parecido)
- Crie uma conta, clique em "New Web Service" e conecte o repositório do GitHub.
- Build command: `npm install`
- Start command: `npm start`
- Em "Environment", cadastre as variáveis do `.env.example` preenchidas com os valores reais
  (a `ANTHROPIC_API_KEY`, e depois as do WhatsApp se for usar).
- Ao final, o Render te dá uma URL provisória, tipo `vetonc-app.onrender.com` — teste tudo
  nela antes de conectar seu domínio.

### 3. Conectar seu domínio (vetjoicefaria.com)
O ideal é usar um **subdomínio** dedicado ao app, por exemplo `mentoria.vetjoicefaria.com`,
para não mexer no site principal. No painel do Render (em "Custom Domains"):
- Adicione `mentoria.vetjoicefaria.com`
- O Render vai te dar um valor de **CNAME** para cadastrar.
- Entre no painel onde seu domínio está registrado (Registro.br, GoDaddy, etc.), vá em
  "DNS" ou "Gerenciar zona DNS", e crie um registro:
  - Tipo: `CNAME`
  - Nome/Host: `mentoria`
  - Valor/Aponta para: o endereço que o Render forneceu
- Leva de alguns minutos a algumas horas para propagar. Depois disso,
  `https://mentoria.vetjoicefaria.com` abre o app diretamente.

### 4. Configurar o WhatsApp (se for usar)
No painel do Meta, configure o webhook apontando para:
`https://mentoria.vetjoicefaria.com/webhook`
(mesmo verify token que você colocou nas variáveis de ambiente).

### 5. Área da mentora — gerenciar o acervo

Existe uma página separada, só para a mentora, em `/admin` (ex:
`https://mentoria.vetjoicefaria.com/admin`). Ela pede usuário e senha — configure isso
no Render em Environment Variables:
- `ADMIN_USER` (ex: `mentora`)
- `ADMIN_PASSWORD` (escolha uma senha forte)

Nessa página dá para arrastar PDFs/.txt ou colar texto direto, e remover materiais antigos.
Os alunos não enxergam essa página — a tela deles (`/`) só mostra a lista de fontes
disponíveis, sem opção de editar.

### 6. Login por e-mail, com "Primeiro acesso" (e recuperação simples de senha)

Em vez da mentora inventar uma senha para cada aluno, o fluxo agora é:

1. A mentora acessa `/admin`, seção **"Alunos"**, e **convida** um aluno só com **nome e e-mail**
   (sem senha nenhuma nessa etapa).
2. Ela avisa o aluno (por WhatsApp, e-mail, etc.) que o acesso está liberado.
3. O aluno acessa `https://mentoria.vetjoicefaria.com`, cai na tela de login, clica na aba
   **"Primeiro acesso"**, digita o mesmo e-mail cadastrado e **cria a própria senha**.
4. Daí em diante, ele usa "Entrar" normalmente com e-mail + a senha que ele mesmo escolheu.

**Se o aluno esquecer a senha:** como não há envio de e-mail configurado (isso exigiria
contratar um serviço de e-mail à parte), a recuperação é feita pela mentora:
- Em `/admin`, na lista de alunos, clique em **"resetar"** ao lado do nome do aluno.
- Isso apaga a senha antiga e volta o status dele para "aguardando primeiro acesso".
- O aluno faz "Primeiro acesso" de novo, com o mesmo e-mail, e cria uma senha nova.

Isso evita a complexidade (e o custo) de configurar um sistema de "esqueci minha senha" por
e-mail automático, mantendo o controle nas mãos da mentora — adequado para o tamanho de
um programa de mentoria. Se no futuro o número de alunos crescer muito e isso virar
trabalho demais para ela, dá para evoluir para recuperação por e-mail automática.

## Como o assistente decide onde buscar a resposta

O Agente Oncoway segue uma ordem de prioridade:

1. **Primeiro, tenta responder só com o acervo** (os materiais carregados pela mentora).
   Se conseguir, a resposta mostra um selo "Fonte consultada: ..." com o nome do material.
2. **Se o acervo não cobrir a pergunta**, ele complementa com conhecimento geral de
   veterinária e, se precisar, faz uma busca na internet (usando a ferramenta de busca
   nativa da Anthropic). Nesse caso, a resposta sempre mostra um aviso visível: "⚠ Fora do
   acervo oficial — conhecimento geral / busca na internet, confirme com a mentora".

Isso vale tanto para o app web quanto para o WhatsApp.

**Custo:** a busca na internet só é acionada quando o acervo não tem a resposta — ou seja,
não gera custo extra nas perguntas que o material do curso já cobre. Quando acionada, tem um
custo pequeno adicional por busca (cobrado pela Anthropic).

## Banco de dados (evita perder o acervo e os cadastros de alunos)

Por padrão, se a variável `DATABASE_URL` não estiver configurada, o app guarda tudo em
arquivos locais (`docs.json`, `students.json`) — o que funciona, mas corre risco de se
perder quando o Render reinicia o servidor (comum em planos gratuitos, que não têm disco
permanente).

**Recomendado:** configurar um banco de dados gratuito no Supabase, assim:

1. Crie uma conta em [supabase.com](https://supabase.com) (tem plano gratuito).
2. Crie um novo projeto (escolha uma senha forte para o banco — guarde ela).
3. No painel do projeto, vá em **Project Settings → Database → Connection string**.
4. Escolha a aba **"Transaction"** (modo pooler, recomendado para servidores como o Render)
   e copie a URL. Ela se parece com:
   `postgresql://postgres.xxxxx:[SUA-SENHA]@aws-0-regiao.pooler.supabase.com:6543/postgres`
5. Troque `[SUA-SENHA]` pela senha que você criou no passo 2.
6. No Render, vá em **Environment** e adicione:
   - `DATABASE_URL` → cole essa string completa
7. Redeploy o serviço.

**Não precisa criar tabelas manualmente** — o servidor cria sozinho (`docs`, `students`)
na primeira vez que roda, e ainda aproveita para copiar os 3 materiais de exemplo do
`docs.json` para dentro do banco, se ele estiver vazio.

A partir daí, tudo que a mentora cadastrar em `/admin` (materiais e alunos) fica guardado
no Supabase — sobrevive a reinícios, redeploys, e trocas de plano no Render.

## Testando localmente antes de hospedar (opcional)

```bash
npm install
cp .env.example .env   # preencha com os valores reais
npm start
```
Acesse `http://localhost:3000` no navegador.

## O que funciona em cada lugar

| Recurso | No protótipo do chat (Claude) | Hospedado no seu domínio |
|---|---|---|
| Chat com IA sobre o acervo | ✅ | ✅ |
| Upload de PDF | ✅ | ✅ |
| Microfone (ditar pergunta) | ⚠️ pode ser bloqueado pelo navegador | ✅ funciona normalmente |
| Acervo compartilhado entre alunos | ⚠️ simulado | ✅ de verdade |
| WhatsApp | ❌ | ✅ |
| Múltiplos alunos ao mesmo tempo | ❌ | ✅ |

## Próximos passos possíveis (quando fizer sentido)

- Trocar a busca por palavras-chave por um banco vetorial de verdade (melhor precisão
  conforme o acervo crescer).
- Um login simples para os alunos, se quiserem restringir o acesso.
- Um painel visual para sua esposa adicionar/remover materiais sem mexer em arquivos.
- Transcrição automática das aulas em vídeo/áudio (via API de transcrição).

Se preferir, eu posso preparar o repositório no GitHub e ir junto com você nesse primeiro
deploy — é mais rápido resolver problemas de configuração em conjunto na primeira vez.
