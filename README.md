# TaskSchool — Gerenciador de Tarefas e Estudos

Aplicação web progressiva (PWA) para alunos organizarem tarefas de estudo por
**disciplina** e **prazo**, com cadastro por **nome + turma**.

- **Back-end:** Node.js + Express + SQLite (módulo nativo `node:sqlite`)
- **Front-end:** HTML, CSS e JavaScript puro (Vanilla JS), sem frameworks
- **Visual:** tema **dark** fixo, com a cor verde `#218a31` como destaque
- **PWA:** manifesto, ícones, Service Worker com cache e funcionamento offline
- **Zero dependência nativa:** o `npm install` nunca precisa de compilador

> **Nota:** o campo *prioridade* foi removido do modelo de dados. Bancos criados
> por versões anteriores são migrados automaticamente na inicialização
> (a coluna `priority` é descartada e as tarefas são preservadas).

---

## 📁 Estrutura do projeto

```
TaskSchool/
├── package.json          # dependências e scripts
├── server.js             # servidor Express + API REST + inicialização do SQLite
├── iniciar.bat           # inicialização com um clique (Windows)
├── render.yaml           # configuração de deploy no Render
├── .gitignore
├── data/                 # (criado automaticamente) banco taskschool.db
├── public/
│   ├── index.html        # interface (mobile-first)
│   ├── style.css         # estilos (tema dark + verde #218a31), Grid/Flexbox
│   ├── app.js            # consumo da API, filtros, edição, exclusão e modo offline
│   ├── manifest.json     # manifesto PWA (standalone)
│   ├── sw.js             # Service Worker (cache + offline)
│   └── icons/            # ícones 192/512, maskable e favicon
└── tools/                # utilitários de desenvolvimento
    ├── generate-icons.js # gera os ícones PNG (sem dependências)
    ├── e2e-test.js       # teste end-to-end do front-end (Chrome DevTools Protocol)
    └── responsive-test.js# verificação de overflow em vários breakpoints
```

---

## 📱 Versão mobile

O mesmo app tem uma **interface de celular** própria (abaixo de 768px), com o
visual de um aplicativo nativo:

| Recurso | Detalhe |
| ------- | ------- |
| **Navegação inferior** | Tarefas · Lembretes · Aluno, fixa no rodapé |
| **Botão flutuante (FAB)** | "+" no canto inferior direito para nova tarefa |
| **Telas separadas** | Lista, Nova tarefa, Lembretes e Minha conta |
| **Cabeçalho compacto** | Resumo (pendentes/concluídas/atrasadas) + avatar |
| **Botão Voltar** | Volta para a lista em qualquer tela |
| **Alvos de toque grandes** | 58px na barra e 56px no FAB (mínimo recomendado: 44px) |
| **Safe area** | Respeita a "ilha"/barra do iPhone |

No desktop (≥768px) continua o layout de duas colunas, com o formulário e os
lembretes na barra lateral.

A tela **Minha conta** mostra o aluno logado, a turma, o botão de trocar de
aluno e o de instalar o app.

### Testes

```bash
npm run test:mobile     # 30 verificações do shell mobile (iPhone, Android e tablet)
```

---

## 🔔 Lembretes diários (notificações)

Cada aluno pode ativar um **aviso diário** sobre as tarefas da turma. O painel
ficam na coluna lateral, abaixo do formulário.

| Recurso | Detalhe |
| ------- | ------- |
| Interruptor | Liga/desliga o lembrete diário |
| Horário | Configurável (padrão 18:00) |
| Botão "Enviar aviso de teste" | Dispara na hora, para conferir |
| Ações na notificação | "Ver tarefas" e "Dispensar" |

### O que o aviso diz

| Situação | Notificação |
| -------- | ----------- |
| Tarefas vencidas ou para hoje | "Você tem N tarefas para entregar" + lista (marca as vencidas) |
| Nada para hoje, mas há prazo próximo | "Nenhuma tarefa para hoje" + próxima tarefa |
| Só tarefas sem prazo | "Nenhuma tarefa com prazo para hoje" + quantas faltam |
| Nada pendente | "Tudo em dia!" |

### Como o agendamento funciona

1. **App aberto:** um timer agenda o aviso para o horário escolhido e se
   reagenda a cada rodada. Ao reabrir o app depois do horário, o aviso que
   faltou dispara automaticamente (uma vez por dia).
2. **App fechado:** o Service Worker registra uma *Periodic Background Sync* com
   intervalo de **1 dia** — é o navegador que decide a hora exata (recurso
   exclusivo do Chrome/Edge e que depende das permissões do sistema).

> **Requisito:** notificações só funcionam em **HTTPS ou localhost**, porque
> dependem do Service Worker. No celular, publique no Render para ter HTTPS.

A lógica de montar o aviso está em `public/reminder.js`, **compartilhada**
entre a página e o Service Worker (`importScripts`) — assim os dois lados
mostram sempre a mesma mensagem.

---

## 👥 Cadastro por nome e turma

Na primeira abertura, o aluno se cadastra com **nome + série + turma**. Não há
senha: a turma identifica a lista de tarefas.

### Séries e turmas disponíveis

| Série                | Turmas              |
| -------------------- | ------------------- |
| 6º ano               | A, B, C             |
| 7º ano               | A, B, C             |
| 8º ano               | A, B, C             |
| 9º ano               | A, B, C             |
| 1º ano do EM         | A, B, C, **DSB**, **ADM** |
| 2º ano do EM         | A, B, C             |
| 3º ano do EM         | A, B, C             |

### Como funciona

- O **select de turma se ajusta** à série escolhida (DSB e ADM só aparecem no 1º EM).
- Se já houver alunos na turma, eles aparecem como **atalhos** — é só clicar no
  nome para entrar sem digitar de novo.
- Cadastrar o **mesmo nome na mesma turma** não duplica o aluno: ele simply
  entra novamente (a sessão fica salva no `localStorage`).
- O botão no canto superior direito (com o nome e as iniciais) permite
  **trocar de aluno** — ideal quando o celular é compartilhado na sala.
- As tarefas são **compartilhadas por turma**: o que a Maria cria no 1º EM - DSB
  aparece para o João também, com o nome do autor. Tarefas de outras turmas
  nunca aparecem.

---

## 📲 Instalando o app

O TaskSchool é uma **PWA instalável**: vira um ícone na tela inicial, abre em
tela cheia (sem barra do navegador) e **funciona offline**.

### No celular (Android — Chrome/Edge)

1. Abra o endereço do app no navegador
2. Toque no botão **Instalar** que aparece no topo da tela
   (ou menu **⋮ → "Instalar aplicativo"**)
3. Confirme em "Instalar"

### No celular (iPhone/iPad — Safari)

1. Abra o endereço do app no **Safari** (não funciona no Chrome iOS)
2. Toque em **Compartilhar** (⬆️)
3. Escolha **"Adicionar à Tela de Início"** → **Adicionar**

### No computador (Chrome/Edge)

1. Abra o endereço do app
2. Clique no ícone de **instalar** (⊕ ou um monitor) na barra de endereço
   — ou menu **⋮ → "Instalar TaskSchool"**
3. O app abre em janela própria, como um programa normal

### ⚠️ Requisito importante: HTTPS

O Service Worker (responsável pelo modo offline e pela instalação) só funciona em
**contexto seguro**:

| Onde você abre                       | Instala? | Offline? |
| ------------------------------------ | -------- | -------- |
| `http://localhost:3000` (no seu PC)  | ✅       | ✅       |
| `https://seu-app.onrender.com`       | ✅       | ✅       |
| `http://192.168.x.x:3000` (Wi-Fi)    | ❌       | ❌       |

Para usar no celular da escola, **publique no Render** (o Render já fornece
HTTPS gratuito) e instale a partir do endereço `onrender.com`. Para testar
rápido pela rede local no Android, use um túnel como `cloudflared tunnel --url
http://localhost:3000` ou `ngrok http 3000`.

### Como verificar se está instalável

```bash
npm run test:install
```

O teste confere todos os requisitos do Chrome: manifesto sem erro, ícones
192/512, `display: standalone`, Service Worker registrado e controlando a
página, e o disparo do evento `beforeinstallprompt`.

---

## 🐙 Publicando no GitHub

O `.gitignore` já deixa fora do repositório o que não deve subir:
`node_modules/`, o banco `data/` e os logs.

### Pela linha de comando

```bash
# 1. (só na primeira vez) define seu nome e e-mail neste repositório
git config user.name "Seu Nome"
git config user.email "seu-email@exemplo.com"

# 2. Cria o repositório e o primeiro commit
git init -b main
git add .
git commit -m "TaskSchool: gerenciador de tarefas por turma (PWA)"

# 3. Liga ao repositório vazio que você criou no GitHub
git remote add origin https://github.com/SEU-USUARIO/TaskSchool.git

# 4. Envia
git push -u origin main
```

### Pela interface do GitHub (sem terminal)

1. Crie um repositório vazio no GitHub (sem README, sem .gitignore)
2. Abra a pasta do projeto no Explorador de Arquivos
3. Clique em **Upload files** e arraste todo o conteúdo
4. Escreva o commit e confirme

> Depois do `git push`, para atualizar o app no Render basta fazer um novo
> push: o Render detecta o commit e faz o deploy sozinho.

---

## 🚀 Rodando localmente

Requisitos: **Node.js 22.5 ou superior** (https://nodejs.org). O projeto usa o
módulo nativo `node:sqlite`, então **não é preciso compilar nada**.

> No Node 22 o módulo é experimental: os scripts já passam a flag
> `--experimental-sqlite`. Se rodar o arquivo direto, use
> `node --experimental-sqlite server.js`. No Node 24 basta `node server.js`.

**Opção 1 — um clique (Windows):** dê dois cliques em `iniciar.bat`.
Ele instala as dependências se preciso, sobe o servidor e abre o navegador.

**Opção 2 — pelo terminal:**

```bash
# 1. Instalar as dependências
npm install

# 2. Subir o servidor (http://localhost:3000)
npm start
```

Para desenvolvimento com recarregamento automático:

```bash
npm run dev        # node --watch server.js
```

O banco SQLite é **criado automaticamente** em `data/taskschool.db` na primeira
execução, junto com a tabela `tasks` e algumas tarefas de exemplo.

### Variáveis de ambiente (opcionais)

| Variável       | Padrão                      | Descrição                                  |
| -------------- | --------------------------- | ------------------------------------------ |
| `PORT`         | `3000`                      | Porta do servidor                          |
| `DATABASE_PATH`| `./data/taskschool.db`      | Caminho do arquivo SQLite                  |
| `SEED_DEMO`    | `true` (só na 1ª criação)   | `true` popula tarefas de exemplo            |

```bash
PORT=8080 DATABASE_PATH=./data/prod.db npm start
```

---

## 🔌 API REST

Base: `http://localhost:3000/api`

| Método   | Rota            | Descrição                                    |
| -------- | --------------- | -------------------------------------------- |
| `GET`    | `/health`       | Status do servidor                           |
| `GET`    | `/grades`       | Séries e turmas disponíveis                   |
| `GET`    | `/classes`      | Turmas que já têm alunos                     |
| `POST`   | `/students`     | Cadastra um aluno (ou devolve o existente)   |
| `GET`    | `/students`     | Lista os alunos de uma turma (`?classKey=`)  |
| `GET`    | `/students/:id` | Dados de um aluno                            |
| `GET`    | `/tasks`        | Lista as tarefas (`?classKey=` filtra a turma)|
| `GET`    | `/tasks/:id`    | Busca uma tarefa pelo id                     |
| `POST`   | `/tasks`        | Cria uma tarefa (informe `studentId`)        |
| `PUT`    | `/tasks/:id`    | Atualiza (parcial ou completa) uma tarefa    |
| `PATCH`  | `/tasks/:id`    | Marca/desmarca como concluída                |
| `DELETE` | `/tasks/:id`    | Exclui uma tarefa                            |
| `GET`    | `/stats`        | Totais (pendentes, concluídas, atrasadas)     |
| `GET`    | `/subjects`     | Lista de disciplinas cadastradas             |

### Filtros de `GET /tasks`

| Parâmetro | Valores                          | Exemplo                       |
| --------- | -------------------------------- | ----------------------------- |
| `classKey` | turma (ex.: `1em-DSB`)           | `/api/tasks?classKey=1em-DSB`  |
| `status`  | `all`, `pending`, `completed`    | `/api/tasks?status=pending`   |
| `subject` | disciplina exata                 | `/api/tasks?subject=Biologia` |
| `search`  | busca por título, disciplina ou autor | `/api/tasks?search=revisar` |

### Exemplos

```bash
# Ver séries e turmas
curl http://localhost:3000/api/grades

# Cadastrar aluno
curl -X POST http://localhost:3000/api/students \
  -H "Content-Type: application/json" \
  -d '{"name":"Maria Silva","grade":"1em","className":"DSB"}'

# Alunos da turma
curl "http://localhost:3000/api/students?classKey=1em-DSB"

# Criar tarefa (studentId = id do aluno)
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Revisar Álgebra","subject":"Matemática","dueDate":"2026-12-01","studentId":2}'

# Listar só a minha turma
curl "http://localhost:3000/api/tasks?classKey=1em-DSB"

# Concluir
curl -X PATCH http://localhost:3000/api/tasks/1 \
  -H "Content-Type: application/json" \
  -d '{"completed":true}'

# Atualizar
curl -X PUT http://localhost:3000/api/tasks/1 \
  -H "Content-Type: application/json" \
  -d '{"title":"Revisar Álgebra - Cap. 3"}'

# Excluir
curl -X DELETE http://localhost:3000/api/tasks/1
```

### Formato da tarefa

```json
{
  "id": 1,
  "title": "Revisar Álgebra",
  "subject": "Matemática",
  "dueDate": "2026-12-01",
  "completed": 0,
  "studentId": 2,
  "authorName": "Maria Silva",
  "authorGrade": "1em",
  "authorClass": "DSB"
}
```

Erros retornam sempre o mesmo formato:

```json
{ "error": { "message": "O campo \"title\" é obrigatório." } }
```

---

## 🚀 Publicando no Render.com

1. **Suba o código para o GitHub** (repositório pode ser privado).
2. No Render, escolha **New → Web Service** e conecte o repositório.
3. Configure:

   | Campo            | Valor                  |
   | ---------------- | ---------------------- |
   | Runtime          | Node                   |
   | Node version     | 24 (ou 22.5+)          |
   | Build Command    | `npm ci`               |
   | Start Command    | `npm start`            |
   | Health Check Path| `/api/health`          |

   O arquivo `render.yaml` já contém essa configuração — basta usar
   **New → Blueprint** e apontar para o repositório.
4. O Render define a variável `PORT` automaticamente; o `server.js` já a utiliza.
5. Após o primeiro deploy, o banco é criado em `data/taskschool.db`.

> **Sem dependência nativa:** o projeto usa o `node:sqlite` do próprio Node,
> então o build no Render não compila nada — `npm ci` leva ~2 segundos e
> funciona em qualquer runner.

> **Nota sobre persistência:** o disco do Render é **efêmero**. Em um plano
> gratuito, o banco é recriado a cada novo deploy. Para persistir de verdade,
> use um disco montado em `/var/data` e aponte `DATABASE_PATH` para lá
> (`/var/data/taskschool.db`), ou migre para um PostgreSQL gerenciado.

---

## 📱 PWA (instalação e offline)

- `manifest.json` define nome, ícones, `display: standalone` e atalho.
- `sw.js` aplica *network-first* para a API e *stale-while-revalidate* nos
  arquivos estáticos; o `index.html` é cacheado para abrir o app sem rede.
- O `app.js` mantém uma **fila de sincronização** em `localStorage`: tarefas
  criadas/editadas/excluídas offline são aplicadas na interface e enviadas ao
  servidor assim que a conexão voltar.
- No Chrome/Edge: ícone de instalar na barra de endereço (ou menu ⋮ → "Instalar").
  No iOS: Compartilhar → "Adicionar à Tela de Início".

---

## ✅ Testes

```bash
npm start                 # em um terminal
npm run test:e2e          # 46 verificações de interface + cadastro + offline
npm run test:notifications # 22 verificações dos lembretes diários
npm run test:mobile       # 30 verificações do shell mobile
npm run test:responsive   # overflow horizontal de 320px a 1440px
npm run test:cache        # alteração de CSS chega ao browser em 1 F5
npm run test:install      # requisitos de instalação do PWA
npm run clean             # remove os dados criados pelos testes
```

> **Atualização na tela:** os arquivos estáticos são servidos com
> `Cache-Control: no-cache` (revalidação por ETag) e o Service Worker usa
> *network-first* com fallback para o cache. Assim, qualquer alteração de
> CSS/JS aparece no primeiro F5 — sem precisar limpar o cache do navegador.

O `e2e-test.js` dirige o Chrome via DevTools Protocol (sem dependências extras)
e cobre: tela de cadastro, séries/turmas, sessão, compartilhamento por turma,
isolamento entre turmas, autor da tarefa, CRUD completo, busca, filtros,
Service Worker, manifesto, modo offline e sincronização.

O `notification-test.js` verifica o painel de lembretes de ponta a ponta:
permissão, agendamento, horário configurável, o texto de cada cenário
(urgente / próxima / tudo em dia) e as ações da notificação.

---

## 📄 Licença

MIT
