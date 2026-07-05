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
