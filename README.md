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

## Triagem Oncoway (agente de catalogação do acervo)

Cada artigo/material do acervo agora pode ganhar uma "ficha catalográfica" gerada por IA:
tipo de neoplasia, tópicos clínicos, palavras-chave/sinônimos e um resumo — além de uma
lista separada com as doses/protocolos mencionados no texto. Isso melhora a busca porque
o sistema passa a comparar a pergunta do aluno contra esses campos estruturados, não só
contra o texto corrido — então "caroço na pele" consegue encontrar um artigo catalogado
como "mastocitoma cutâneo", mesmo sem essa palavra exata aparecer no texto.

**Isso exige banco de dados configurado** (`DATABASE_URL`, ver seção acima). Sem isso, essa
função fica desativada automaticamente (não quebra nada, só não cataloga).

Como usar, em `/admin`:
- **Materiais novos** são catalogados sozinhos, em segundo plano, assim que são cadastrados
  (não trava o upload).
- **Materiais que já estavam no acervo antes dessa função existir** aparecem como "pendentes"
  no painel "Triagem Oncoway". Clique em **"Catalogar pendentes"** — ele processa em lotes
  automaticamente até zerar a fila (pode levar alguns minutos para acervos grandes, com
  centenas de artigos; pode fechar a página e voltar depois, o progresso fica salvo).
- As doses extraídas ficam listadas em **"Ver doses/protocolos extraídos"**, onde a mentora
  pode revisar e remover qualquer item que não fizer sentido (é uma camada de curadoria
  humana — o sistema nunca usa uma dose catalogada sem que ela tenha vindo de um material
  que a mentora já aprovou ao colocar no acervo).

**Custo:** catalogar tem um custo pequeno de IA por artigo (é feito uma vez só, não a cada
pergunta de aluno) — para um acervo de centenas de artigos, a catalogação completa deve
custar poucos dólares no total.

## Conversas salvas (histórico persistente, como no Claude)

O app dos alunos agora tem uma barra lateral com as conversas anteriores — parecido com o
histórico do próprio Claude. Cada aluno vê só as conversas dele, pode reabrir qualquer uma,
apagar, ou começar uma nova a qualquer momento com o botão **"+ Nova conversa"**.

**Isso exige banco de dados configurado** (`DATABASE_URL`). Sem isso, o app volta ao
comportamento anterior automaticamente: a conversa fica só na memória da sessão do
navegador, sem lista para reabrir depois (nada quebra, só perde esse recurso).

Detalhes técnicos:
- Uma conversa só é criada de fato no banco quando o aluno manda a primeira mensagem —
  assim a lista não fica cheia de conversas vazias.
- O título da conversa é gerado automaticamente a partir da primeira pergunta.
- Apagar uma conversa remove as mensagens dela também (não afeta o acervo nem outras
  conversas).

## WhatsApp: controle de acesso e envio de exames

O bot de WhatsApp agora só responde a números de telefone **cadastrados** — qualquer outra
pessoa recebe uma mensagem automática dizendo que o acesso é restrito ao programa.

Para liberar um aluno pelo WhatsApp, em `/admin` → aba **Alunos**, clique no botão
**"whatsapp"** ao lado do nome dele e informe o número (com DDI e DDD, só números, ex:
`5511999998888` — sem espaços, parênteses ou o sinal de `+`). Isso pode ser feito na hora
do convite (campo opcional) ou depois, a qualquer momento.

O bot também já aceita:
- **Fotos de exame** enviadas direto no WhatsApp (a IA interpreta a imagem)
- **PDFs de exame** (o texto é extraído automaticamente; se for um PDF escaneado sem texto,
  o bot avisa e sugere enviar como foto)

**Limitação atual:** diferente do app web, o WhatsApp ainda não tem "conversas salvas" para
reabrir depois — a memória de cada conversa fica só na sessão em andamento (perdida se o
servidor reiniciar). Também não é possível anexar mais de um arquivo por mensagem (o
WhatsApp já limita isso nativamente, um arquivo por vez).

## Painel de Atividade (acompanhamento de acesso e uso)

Em `/admin`, na aba **"📊 Atividade"**, a mentora acompanha:

- **Uso nos últimos 14 dias** — gráfico de linha com o volume de perguntas por dia.
- **Acervo vs. conhecimento geral/internet** — mostra a proporção de respostas que vieram
  do acervo oficial versus as que precisaram cair para conhecimento geral (um sinal de onde
  o acervo ainda tem lacunas — retoma a ideia de identificar o que falta catalogar).
- **Assuntos mais procurados** — ranking dos temas (tipo de neoplasia/tópicos, vindos da
  ficha do Triagem Oncoway) que mais aparecem nas perguntas dos alunos.
- **Materiais mais consultados** — quais artigos/aulas do acervo são citados com mais
  frequência nas respostas.
- **Atividade por aluno** — quantas perguntas cada aluno já fez, quantas vezes já entrou, e
  quando foi o último acesso.

**Importante:** essa funcionalidade só ficou disponível a partir de agora (é aditiva) — ela
não altera nada de como os alunos fazem login, e os cadastros e senhas já existentes
continuam funcionando exatamente como antes. Também exige banco de dados configurado
(`DATABASE_URL`); sem isso, essa aba mostra um aviso e o resto do app segue funcionando
normalmente.

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

## Identidade e modo de busca (painel /admin → ⚙️ Configurações)

- **Identidade**: nome do app, frase, nome/título da mentora e "voz" (como ela explica). Valem para o app do aluno, o login e o prompt da IA.
- **Uso da internet**: `Só o acervo`, `Acervo primeiro` (padrão, até 2 buscas, sempre sinalizado) ou `Aberto`.
- Perguntas que o acervo não cobriu aparecem em **Atividade → Perguntas sem cobertura** (lista do que gravar/escrever a seguir).
- Tudo é aditivo: tabela nova `app_settings`, nenhum dado existente é alterado. Opcional: `ANTHROPIC_API_URL` para apontar a outro endpoint da API.

## Aparência (painel /admin → 🎨 Aparência)

- **Logotipo, logotipo branco e foto da mentora**: upload direto (PNG/JPG/WebP/SVG, até 1,5 MB; o painel reduz o tamanho automaticamente). Ficam no banco (`app_assets`) e são servidos em `/brand/<chave>`.
- **Cores**: principal e destaque, com sugestão automática a partir do logo. Também fonte dos títulos, cantos, cartões de entrada e links rápidos do menu.
- **Banners**: faixas de destaque no topo do app do aluno (título, texto, imagem, botão com link). Podem ser ocultados/excluídos; o aluno pode fechar cada um.
- Aditivo: duas tabelas novas (`app_assets`, `app_banners`), criadas sozinhas. Sem configuração, vale o visual anterior.

## Painel reorganizado (/admin)

- Menu lateral por áreas: Visão geral, Conteúdo (Acervo, Triagem e doses), Pessoas (Alunos), Desempenho (Atividade e lacunas), Marca e sistema (Aparência, Identidade e IA).
- **Visão geral**: números-chave e lista de pendências (convites sem senha, materiais sem catalogação, perguntas sem cobertura), com atalhos.
- **Acervo**: busca, ordenação e paginação (20 por página); o formulário de adicionar fica recolhido.
- **Alunos**: busca (nome, e-mail, WhatsApp), filtros (aguardando primeiro acesso, ativos, inativos 30+ dias, nunca entrou), último acesso e nº de logins, exportação CSV.
- Sem mudanças no banco; só leitura de colunas que já existiam.

## Planos, cotas e custo (painel /admin → 💳 Planos e custos)

- **Três planos**: Grátis, Assinante e Mentoria. Alunos já cadastrados ficam no plano **Mentoria** (nada muda para eles). Novos convites escolhem o plano; dá para trocar a qualquer momento na lista de alunos.
- **Cotas mensais** (renovam no dia 1º, horário de Brasília): perguntas de texto e interpretações de exame, por plano. Interpretar exame consome a cota de exames, não a de perguntas.
- **Gancho**: o plano Grátis tem N exames grátis, uma única vez (padrão 5).
- **Cota que avisa**: o app mostra o uso (barra, aviso a partir de 80%) e, no limite, um cartão com a data de renovação e o botão de assinar (link configurável).
- **Grátis**: histórico dos últimos 7 dias, menos trechos do acervo por resposta e sem WhatsApp. Tudo editável por plano.
- **Custo**: cada resposta registra tokens e buscas na tabela `usage_events`; o painel estima o custo em R$ por plano e por aluno. Ajuste os preços da API na mesma página.
- Aditivo: colunas novas em `students` (`plan`, `free_exams_used`) e a tabela `usage_events`, criadas sozinhas. Sem banco de dados, não há cotas.

## Cadastro aberto, confirmação de e-mail e recuperação de senha

- **Desligado por padrão.** Em /admin → Identidade e IA → "Cadastro aberto e termos", a mentora liga o cadastro. Quem se cadastra sozinho entra no plano **Grátis**, depois de confirmar o e-mail.
- **Alunos da mentoria**: continuam sendo convidados no painel (plano Mentoria) e usam "Primeiro acesso". Se alguém já tinha criado conta grátis e depois é convidado, a conta é **promovida** para Mentoria (nada se perde).
- **Esqueci minha senha** por e-mail, para todos. O reset feito pelo painel continua existindo.
- **Termos de uso e política de privacidade** editáveis no painel e publicados em `/termos` e `/privacidade`. Os textos iniciais são **modelos**: precisam de revisão jurídica.
- **Exclusão de conta** pelo próprio usuário (menu lateral do app), apagando conversas e uso.
- **Proteções**: respostas genéricas (não revelam e-mails cadastrados), limite de tentativas por IP e e-mail, campo isca para robôs, contas não confirmadas apagadas após 7 dias.
- **Envio de e-mail (Brevo ou Resend)**: variáveis `BREVO_API_KEY` (ou `RESEND_API_KEY`), `MAIL_FROM` (ex: `Oncoway <contato@vetjoicefaria.com>`) e `APP_URL` (ex: `https://vetoncoway.onrender.com`). O remetente precisa estar validado no provedor (no Brevo: Senders, domains & dedicated IPs). Sem essas variáveis o cadastro aberto não funciona, mesmo ligado.
- Aditivo: colunas novas em `students` (`email_verified`, `source`, `terms_accepted_at`) e tabela `auth_tokens`. Contas existentes ficam como confirmadas.

## App instalável (PWA)
- O site pode ser instalado no celular como app (Android: botão "Instalar o app" no menu; iPhone: Compartilhar → Adicionar à Tela de Início, com dica na tela).
- Ícone: admin → Aparência → "Ícone do app" (gerar a partir do logotipo, enviar PNG ou voltar ao padrão). Sem ícone enviado, usa `public/icons/default-*.png`.
- `/manifest.webmanifest` e `/sw.js` são gerados pelo servidor. O service worker não guarda dados (só mostra aviso offline), então nada fica desatualizado.
- Não substitui a publicação nas lojas (Apple/Google); serve para instalar direto pelo navegador.

## Segurança dos uploads de imagem
- Aceita PNG, JPG, WebP e SVG. O tipo é conferido pelo **conteúdo real** do arquivo (não pelo nome nem pelo tipo informado pelo navegador); se não bater, o envio é recusado.
- Limites: 1,5 MB para PNG/JPG/WebP (até 4096 px de lado) e 200 KB para SVG. Ícone do app: PNG quadrado, mínimo 144 px.
- SVG: é recusado (não "consertado") se tiver script, eventos (`onclick`...), `foreignObject`, animações, entidades, `@import` ou qualquer referência externa. Imagens PNG/JPG/WebP embutidas em base64 e referências internas (`#id`) são permitidas. SVGs exportados com entidades antigas (alguns do Illustrator) podem ser recusados: exporte como "SVG simples" ou envie PNG.
- A validação acontece antes de gravar: um arquivo inválido nunca substitui a imagem atual.
- As imagens já salvas não são alteradas nem revalidadas.

## Rascunho, publicação e reversão da aparência (infraestrutura, `appearance.js`)
Ainda sem tela própria (virá na etapa 4). Todas as rotas exigem o login de administrador e o banco (Supabase):
- `GET /api/admin/appearance`: estado (publicado, rascunho, alterações, versão anterior).
- `PUT /api/admin/appearance/draft`: salva cores/estilo/links no rascunho. `POST|DELETE /api/admin/appearance/draft/image/:key` (+ `/undo`): imagem nova, remoção ou desfazer no rascunho. Valem as mesmas regras de segurança dos uploads.
- `POST .../draft/restore-defaults` (`{"includeImages":true}` opcional) e `POST .../draft/discard`: só mexem no rascunho.
- `POST .../publish` e `POST .../revert` com `{"confirm":true}`: rodam numa única transação (tudo ou nada). Publicar guarda o que estava publicado como "versão anterior"; reverter troca as duas (dá para desfazer a reversão).
- O rascunho guarda só as diferenças; as imagens dele ficam no banco com chaves internas que `/brand` não serve. Banners continuam sendo editados direto (não passam pelo rascunho).
- O que já está publicado não é migrado nem alterado: o sistema só lê `app_settings` e `app_assets` como sempre.

## Tela Aparência (etapa 4)
- Quatro áreas: **Marca e imagens**, **Cores e estilo**, **Pré-visualização** (login, área dos alunos e painel; computador e celular) e **Banners e links rápidos**. Arquivos: `admin/aparencia.js` e `admin/aparencia.css` (servidos só ao administrador).
- Tudo passa pelo rascunho: **Salvar rascunho**, **Publicar alterações** (com confirmação), **Restaurar padrão** (só no rascunho), **Reverter publicação** (com confirmação) e **Descartar rascunho**. Os alunos só veem mudanças depois de publicar.
- Com banco de dados, as rotas antigas de escrita direta (`/api/admin/assets`, `/api/admin/banners` e as chaves visuais de `/api/admin/settings`) foram bloqueadas/ignoradas; nome, mentora, IA, planos e demais configurações continuam salvando como antes.
- Banners em rascunho ficam dentro do próprio registro do rascunho (sem tabelas novas) e entram na publicação/reversão junto com o resto.
- A proteção de contraste agora escurece em passos de 3% (preserva mais a cor escolhida) e o painel mostra a cor escolhida e a efetivamente aplicada.
- O painel passou a ter `viewport` para funcionar bem no celular.

## Controle de cadastros (aba Alunos)
- Resumo no topo: grátis, assinantes, mentoria, novos em 7 e 30 dias, grátis perto do limite (possíveis assinantes) e e-mails não confirmados, mais o gráfico de cadastros por semana.
- Filtros por período de cadastro, origem (cadastro próprio ou convite) e "grátis perto do limite" (80% da cota de perguntas ou exames grátis esgotados); ordenação por cadastro, uso no mês ou último acesso.
- Cada aluno mostra a data de cadastro e a origem. O CSV inclui cadastro, origem e uso do mês.
- A situação de pagamento (em dia, atrasado, cancelado) depende da integração com o Asaas (próxima etapa).

## Pagamentos (Asaas)

Módulo `billing.js` + página **Pagamentos** no admin. Muda o plano do aluno sozinho quando o Asaas avisa de um pagamento.

**Variáveis no Render (nunca no chat nem no código):**
- `ASAAS_WEBHOOK_TOKEN` — você inventa (32 a 255 caracteres) e cola o mesmo no cadastro do webhook no Asaas.
- `ASAAS_API_KEY` — chave da API do Asaas (usada só para descobrir o e-mail de quem pagou).
- `ASAAS_ENV` — `sandbox` para testes; remova (ou `production`) para valer.
- `ASAAS_API_URL` — opcional; só para testes automatizados.

**Webhook no Asaas:** `https://SEU-DOMINIO/webhook/asaas`, com o token acima; marque eventos de cobrança (pagamento confirmado/recebido/vencido/estornado/contestação) e de assinatura (inativada/removida).

**Regras (editáveis em Pagamentos):** aviso por e-mail após 3 dias de atraso; volta ao Grátis após 7; tolerância de 2 dias depois do período pago; cancelamento mantém o acesso até o fim do período pago. Verificação automática a cada hora (e botão "Verificar atrasos agora").

**Segurança e garantias:** token comparado em tempo constante; cada aviso é gravado uma vez (idempotente, tabela `billing_events`); se algo temporário falha, responde erro e o Asaas repete; mentoria e planos definidos à mão nunca são alterados; trocar o plano manualmente na lista de alunos desliga a cobrança automática daquele aluno.

**Pagamento sem conta:** se alguém paga com e-mail sem cadastro, o evento fica guardado e o plano é aplicado quando a pessoa se cadastrar; se usou outro e-mail, vincule em Pagamentos.

**Banco (aditivo):** tabela `billing_events`; colunas em `students`: `plan_until`, `billing_status`, `asaas_customer_id`, `billing_overdue_since`, `billing_warned_at`.

**Trocar o link de pagamento:** campo "Link do botão Assinar" (`upgradeUrl`) em Planos e custos. Não exige alteração de código.

## Aba Planos e modalidades

- Admin → Planos e custos → **Modalidades do plano Assinante**: mensal, trimestral, semestral e anual (nome, preço exibido, link do Asaas, ativo, destaque) e links opcionais da mentoria e da capacitação. Tudo editável a qualquer momento (setting `planOffers`, `mentoriaUrl`, `capacitacaoUrl`).
- Aluno: o botão "Conhecer o plano Assinante" / "Ver planos" (lateral e aviso de limite) abre uma janela com os ciclos, valor por mês e economia. Quem é da Mentoria não vê o botão. Se nenhuma modalidade estiver ativa, usa o link antigo (`upgradeUrl`).
- O valor cobrado é o do link do Asaas: ao mudar um preço, mude nos dois lugares.
- Endpoint: `GET /api/offers` (exige login de aluno).

## Acesso por CRMV ou atestado (cadastro espontâneo)

- Cadastro próprio (`/api/signup`): o perfil é obrigatório. **Com CRMV**: informa número e UF, e o acesso é liberado após confirmar o e-mail. **Estudante / sem CRMV**: anexa o atestado de matrícula (PDF/JPG/PNG/WebP, até 5 MB, conferido pelo conteúdo do arquivo) e só acessa o agente depois da aprovação.
- Quem está pendente ou recusado entra no app, mas vê uma tela de "Cadastro em análise" (com reenvio do atestado); `/api/ask`, conversas, acervo e ofertas respondem 403 `access_pending`, e o WhatsApp também é bloqueado.
- Admin → Alunos: filtro "Aguardando aprovação", selo na lateral, botões **Ver atestado / Aprovar / Recusar** (com motivo, enviado por e-mail). O arquivo é apagado na decisão. A mentora é avisada por e-mail (`supportEmail`) quando o aluno confirma o e-mail.
- O número do CRMV **não é validado automaticamente**: confira por amostragem no site do conselho regional.
- Convidados e alunos de mentoria não são afetados. Contas de cadastro próprio criadas antes desta regra continuam liberadas.
- Banco (aditivo): colunas `crmv`, `crmv_uf`, `access_status`, `access_note`, `access_reviewed_at` em `students`; tabela `student_proofs`.
- Os termos de uso e a política padrão ganharam a cláusula "Quem pode usar". Se você já salvou textos próprios em Aparência/Termos, inclua essa cláusula neles.
