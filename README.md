# Prompt Fixer v2

Aplicação que reescreve prompts em linguagem natural para ficarem mais
claros, objetivos e econômicos em tokens — agora com **backend em Python
(FastAPI)**, **aplicação web completa** e **extensão de Chrome**, os dois
consumindo a mesma API.

## v2.5 — Lote, nota pessoal, cURL e preenchimento guiado

- **Otimização em lote**: cole vários prompts (um por linha, até 20) e
  otimize todos de uma vez, no mesmo modo. Cada um é tratado
  independentemente — se um falhar, os outros continuam normalmente. No
  máximo 3 rodam ao mesmo tempo, pra não estourar limite de taxa dos
  provedores.
- **Nota pessoal no histórico**: adicione uma anotação livre a qualquer
  registro (ex: "usei no projeto X"), visível como um pequeno indicador
  📝 na tabela.
- **Copiar como cURL**: tanto no resultado da otimização quanto no
  histórico, gera um comando pronto pra reproduzir aquela chamada via
  terminal.
- **Preenchimento guiado de templates**: templates com placeholders
  `[assim]` ganham um botão "Preencher campos" que abre um formulário
  com um campo por placeholder, em vez de editar o texto corrido.

## v2.4 — Múltiplos provedores de IA e mais funcionalidades

- **Suporte a múltiplos provedores de IA**, todos com planos gratuitos:
  **Groq**, **Cerebras** e **OpenRouter**. Configure quantos quiser na
  tela de Configurações — se o primeiro da lista de prioridade falhar
  ou não tiver chave, o app tenta o próximo automaticamente, sem
  quebrar a otimização. Cada resultado mostra qual provedor realmente
  atendeu.
- **Escolha de modelo por provedor**: dá pra trocar o modelo padrão de
  cada um (ex: usar um modelo mais rápido ou um mais robusto) direto na
  tela de Configurações.
- **Segunda opinião da IA**: além da nota heurística instantânea, dá
  pra pedir uma avaliação mais profunda feita pela própria IA (pontos
  fortes, pontos fracos e uma sugestão), sob demanda — não roda
  automaticamente pra não gastar chamadas de API à toa.
- **Backup e restauração completos**: exporta todo o histórico e os
  templates pessoais num único JSON, e importa de volta (sempre
  adicionando, nunca substituindo o que já existe).
- **Ações em lote no histórico**: selecione vários registros de uma vez
  e favorite, mova pra lixeira, restaure ou exclua definitivamente
  todos juntos.
- **Busca com FTS5**: a busca do histórico agora usa o índice full-text
  do SQLite em vez de `LIKE`, com relevância melhor. Cai para `LIKE`
  automaticamente se a build do SQLite não tiver suporte a FTS5.
- **Acessibilidade**: `aria-label`/`aria-current` na navegação e nos
  botões só-ícone, e atalho de teclado `/` pra focar a busca do
  histórico de qualquer tela (como no GitHub/Slack).

## v2.3 — Cache, lixeira, comparar modos, configurações e extensão

- **Cache de respostas repetidas**: o mesmo prompt + mesmo modo já
  otimizado antes é reaproveitado (tabela `response_cache`) em vez de
  chamar a Groq de novo — mais rápido e não gasta chamada de API. A
  resposta indica `from_cache: true` quando isso acontece.
- **Lixeira (soft-delete)**: excluir um item do histórico agora move
  para a lixeira em vez de apagar de vez. Dá pra restaurar, excluir
  definitivamente um item, ou esvaziar a lixeira inteira.
- **Comparar modos**: nova tela que roda o mesmo prompt em dois modos
  diferentes ao mesmo tempo e mostra os resultados lado a lado, com
  botão pra usar o que ficou melhor.
- **Configurações na própria interface**: tela para colar, testar e
  salvar a chave da API da Groq sem precisar editar o `.env` na mão —
  além de um aviso amigável na tela de otimizar quando a chave ainda
  não foi configurada.
- **Exportar/importar templates pessoais** em JSON, pra levar entre
  máquinas ou fazer backup.
- **CORS restrito**: em vez de `allow_origins=["*"]`, agora libera só o
  próprio app web (localhost) e qualquer extensão de Chrome instalada.
- **Extensão sincronizada**: o popup agora tem acesso aos mesmos
  templates (prontos e pessoais) do app web, num menu rápido. O modo
  escuro não foi replicado ali de propósito — o popup já é
  intencionalmente escuro sempre, não tem alternância de tema.
- Corrigido: o dashboard estava contando itens já excluídos do
  histórico nas estatísticas.

## v2.2 — Tokens reais, confiabilidade e templates pessoais

- **Contagem real de tokens**: `tokens_after` agora vem direto de
  `usage.completion_tokens` da resposta da Groq (tokenizador exato do
  modelo). `tokens_before` é calculado subtraindo o "peso" fixo do system
  prompt (medido uma vez por modo e cacheado) do `usage.prompt_tokens`
  total — muito mais preciso que a estimativa por contagem de palavras.
  Quando a contagem real não está disponível (ex: campo `usage` ausente),
  cai automaticamente para a estimativa local, e a interface avisa qual
  das duas foi usada.
- **Retry automático** com backoff para falhas temporárias da Groq
  (timeout, conexão caiu, erro 429/5xx) — erros de chave inválida ou
  requisição malformada não são tentados de novo, pois não adiantaria.
- **Limite de tamanho de prompt** (6.000 caracteres), com contador visual
  na tela de otimizar.
- **Templates pessoais**: salve qualquer prompt (com o modo escolhido)
  como um template reutilizável, direto da tela de otimizar. Aparecem
  numa seção própria em "Templates", com opção de excluir.
- **Encadear modos**: depois de otimizar, aplique mais um modo em cima do
  resultado (ex: enriquecer e depois otimizar) sem sair da tela — a
  interface mostra a cadeia de modos aplicados.

## v2.1 — Reforma de interface e novas funcionalidades

A aplicação web passou por uma reformulação completa:

- **Novo shell de aplicativo**: sidebar de navegação fixa (Otimizar,
  Templates, Histórico, Dashboard, API) no lugar das abas horizontais
- **Modo escuro** completo, com alternância salva localmente
- **Indicador de saúde do backend** na sidebar (mostra se a `GROQ_API_KEY`
  está configurada e qual modelo está em uso)
- **Gauge circular de qualidade** (antes/depois) no lugar dos badges simples
- **Biblioteca de templates de prompt** prontos (bug fix, e-mail, resumo,
  tradução, plano de estudos, brainstorm) — usáveis direto na tela de
  otimizar ou numa galeria dedicada
- **Histórico com busca, filtro por modo e favoritos**, exclusão de
  registros, paginação e **exportação para CSV**
- **Atalho de teclado** `Ctrl+Enter` para otimizar
- **Estados vazios e de carregamento (skeleton)** em vez de telas em branco
- Correção de bug: os 3 gráficos do dashboard (Chart.js) não apareciam
  porque faltavam os elementos `<canvas>` no HTML — agora funcionam
- Remoção de `dashboard.html`, `history.html`, `dashboard.js` e
  `history.js`, que eram versões antigas e não usava mais nenhuma rota

## Novidades desta versão

- **Backend em Python (FastAPI)**, com documentação automática em `/docs`
- **Aplicação web** de página única (SPA), com sidebar de navegação entre
  Otimizar, Templates, Histórico, Dashboard e API
- **5 modos de otimização**: Otimizar, Enriquecer, Resumir, Traduzir,
  Formatar para código
- **Comparação de tokens** (antes x depois) em cada otimização
- **Nota de qualidade do prompt (0-100)**: análise heurística instantânea
  que avalia clareza, tamanho e especificidade — mostra o "antes x depois"
  e explica o porquê da nota
- **Diff visual**: destaca exatamente o que foi removido (vermelho) e
  adicionado (verde) entre o prompt original e o otimizado
- **Entrada por voz**: dita o prompt em vez de digitar (Web Speech API,
  nativo do navegador)
- **Estimativa de economia em dólar**: projeta o custo evitado em escala,
  com base em preço ilustrativo de mercado
- **Conquistas/gamificação** no dashboard (badges por marcos de uso)
- **Exportação de relatório em PDF** direto do dashboard (via impressão do navegador)
- **Histórico persistente** em SQLite
- **Dashboard com gráficos** (Chart.js): uso por modo e tokens economizados por dia
- Extensão de Chrome atualizada com modos, voz e nota de qualidade
- **Widget flutuante direto nas páginas de IA** (Claude, ChatGPT, Gemini):
  aparece uma caixinha "⚡" no canto da tela — escreva o prompt nela e a
  extensão já otimiza **e envia** para a IA no campo de texto da própria
  página, sem precisar copiar e colar
- **Economia de tokens acumulada por conversa**: o widget mostra o total
  de tokens (e o custo estimado) economizados naquela conversa específica

## Arquitetura

```
prompt-fixer-v2/
├── backend/
│   ├── app/
│   │   ├── main.py           → rotas da API e das páginas web
│   │   ├── database.py       → SQLite (histórico)
│   │   ├── schemas.py        → validação com Pydantic
│   │   └── services/
│   │       └── optimizer.py  → chama a Groq + tokens reais (com fallback)
│   ├── templates/            → páginas HTML (Jinja2)
│   ├── static/                → CSS e JS do site
│   └── requirements.txt
└── extension/                 → extensão de Chrome (Manifest V3)
    ├── popup.html/js/css      → popup clássico (clicar no ícone da extensão)
    ├── background.js         → service worker: fala com o backend por trás
    └── content.js             → injeta o widget flutuante nas páginas de IA
```

Extensão e site web são só "interfaces" diferentes para a mesma API — por
isso o mesmo backend serve os dois, sem duplicar lógica de otimização.

## Como rodar

### 1. Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

- Site: http://localhost:8000
- Histórico: http://localhost:8000/historico
- Dashboard: http://localhost:8000/dashboard
- Documentação interativa da API (ótimo para mostrar ao professor):
  http://localhost:8000/docs

O `.env` já vem com uma `GROQ_API_KEY`. Pra adicionar chaves de outros
provedores (Cerebras, OpenRouter) ou trocar de chave depois, use a tela
**Configurações** (⚙️) dentro do próprio app — não precisa editar o
`.env` na mão.

### 2. Extensão

1. `chrome://extensions` → ativar "Modo do desenvolvedor"
2. "Carregar sem compactação" → selecionar a pasta `extension/`
3. Nas configurações da extensão (⚙️), confirme a URL:
   `http://localhost:8000/api/optimize`
4. Abra **claude.ai**, **chatgpt.com** ou **gemini.google.com** — vai
   aparecer um botão flutuante "⚡" no canto inferior direito da página

## Como funciona o widget flutuante

O `content.js` roda dentro da página da IA e injeta a caixinha usando
Shadow DOM (isolado do CSS do site, pra não quebrar nada). Ao clicar em
"Otimizar e enviar":

1. O prompt digitado no widget é mandado para o `background.js`
   (o service worker da extensão), que chama `/api/optimize` — a chamada
   sai daí, e não da própria página, porque algumas páginas de IA têm uma
   política de segurança (CSP) que bloquearia um `fetch` feito de dentro
   delas.
2. O texto otimizado é inserido no campo de texto nativo da IA (usando o
   "setter" nativo do React para `<textarea>`, ou `execCommand('insertText')`
   para editores `contenteditable` como o do Claude e do Gemini).
3. A extensão tenta clicar automaticamente no botão de enviar da própria
   IA; se não encontrar, simula a tecla Enter. Como o seletor de cada botão
   pode mudar quando essas empresas atualizam o layout, o **fallback**
   sempre garante que o prompt otimizado pelo menos fica pronto no campo,
   faltando só apertar Enter.
4. A economia de tokens (`tokens_saved` que a API já devolve) é somada e
   guardada em `chrome.storage.local`, com uma chave baseada na
   URL da conversa (`hostname + pathname`) — por isso o contador é por
   conversa: ele soma enquanto você estiver na mesma conversa e reinicia
   (do zero, mas preservado se você voltar) numa conversa diferente.

Se quiser desativar o widget e usar só o popup clássico, dá pra desligar
em ⚙️ → "Mostrar widget flutuante...".

## Endpoints da API

| Método | Rota                          | Descrição                                                         |
|--------|-------------------------------|--------------------------------------------------------------------|
| POST   | `/api/optimize`               | Recebe `{prompt, mode}`, devolve o texto otimizado + contagem de tokens (usa cache se já foi otimizado antes; tenta os provedores em ordem de prioridade) |
| POST   | `/api/simulate`                | Gera uma prévia simulada da resposta da IA para o prompt otimizado |
| POST   | `/api/quality-review`          | Segunda opinião da IA sobre a qualidade de um prompt (score + pontos fortes/fracos + sugestão) |
| GET    | `/api/history`                | Lista paginada do histórico (`q` via FTS5, `mode`, `favorite_only`, `limit`, `offset`) |
| GET    | `/api/history/trash`          | Lista os itens na lixeira                                          |
| DELETE | `/api/history/{id}`           | Move um registro para a lixeira                                    |
| POST   | `/api/history/{id}/restore`   | Restaura um registro da lixeira                                    |
| DELETE | `/api/history/{id}/permanent` | Exclui definitivamente (só funciona se já estiver na lixeira)      |
| DELETE | `/api/history/trash/empty`    | Esvazia a lixeira inteira                                          |
| POST   | `/api/history/bulk`           | Aplica uma ação (favoritar, lixeira, restaurar, excluir) a vários registros de uma vez |
| PATCH  | `/api/history/{id}/favorite`  | Alterna o favorito de um registro                                  |
| PATCH  | `/api/history/{id}/note`      | Salva uma nota pessoal num registro                                |
| POST   | `/api/optimize/batch`          | Otimiza até 20 prompts de uma vez (cada um tratado independentemente) |
| GET    | `/api/history/export`         | Exporta o histórico filtrado em CSV                                |
| GET    | `/api/templates`               | Lista os templates de prompt prontos                               |
| GET    | `/api/custom-templates`         | Lista os templates salvos pelo usuário                             |
| POST   | `/api/custom-templates`         | Salva o prompt atual como template pessoal                         |
| DELETE | `/api/custom-templates/{id}`    | Remove um template pessoal                                         |
| GET    | `/api/custom-templates/export`  | Exporta os templates pessoais em JSON                              |
| POST   | `/api/custom-templates/import`  | Importa templates a partir de um JSON                              |
| GET    | `/api/backup/export`           | Exporta um backup completo (histórico + templates) em JSON         |
| POST   | `/api/backup/import`           | Restaura um backup (adiciona aos dados atuais, não substitui)      |
| GET    | `/api/stats`                   | Estatísticas agregadas para o dashboard (exclui itens na lixeira)  |
| GET    | `/api/health`                   | Status do backend (algum provedor configurado, qual está ativo)    |
| GET    | `/api/settings`                 | Status de cada provedor (chave mascarada, modelo, configurado ou não) e a ordem de prioridade |
| POST   | `/api/settings/test`            | Testa a chave de um provedor sem salvar                            |
| POST   | `/api/settings/provider-key`    | Testa e salva a chave de um provedor no `.env`                     |
| POST   | `/api/settings/provider-order`  | Salva a ordem de prioridade entre provedores                       |
| POST   | `/api/settings/provider-model`  | Salva o modelo escolhido para um provedor                          |

## Roteiro sugerido para a apresentação (5-7 min)

1. **Contexto** (30s): "Prompts mal escritos gastam mais tokens e dão
   respostas piores. Esse software resolve isso automaticamente."
2. **Demo ao vivo** (2-3 min): abra a aplicação web, dite ou escreva um
   prompt bagunçado (ex: "tipo, queria uma coisa ai que explicasse sei lá,
   photosynthesis"), otimize e mostre: nota de qualidade subindo, diff
   colorido, tokens economizados.
3. **Dashboard** (1 min): mostre os gráficos, a economia estimada em USD
   e as conquistas.
4. **Extensão de Chrome** (1 min): mesma funcionalidade, só que como
   extensão — mostra que a mesma API atende dois "produtos" diferentes.
5. **Arquitetura** (1 min): abra `/docs` e mostre a API documentada
   automaticamente — reforça que o backend é reaproveitável e escalável.
6. **Fechamento**: cite 2-3 ideias de evolução futura (seção abaixo) pra
   mostrar visão de produto.

## Sobre a entrada por voz

Usa a Web Speech API nativa do Chrome (`webkitSpeechRecognition`), então
não depende de nenhuma API paga. Funciona muito bem na **aplicação web**.
Na **extensão**, popups de Chrome às vezes fecham ao perder o foco durante
a permissão de microfone na primeira vez — se isso acontecer na sua
máquina, teste de novo (a permissão fica salva) ou use a versão web para
essa demonstração específica.

## Sobre a contagem de tokens

Desde a v2.2, a contagem usada é a **real**, vinda do tokenizador exato
do modelo (via `usage.completion_tokens`/`usage.prompt_tokens` da
resposta da Groq) sempre que possível — veja a seção "v2.2" acima para
o detalhe de como isso é calculado. Só cai para a estimativa local
(baseada em número de palavras/pontuação) quando a Groq não devolve essa
informação por algum motivo (rede instável, etc.). A interface mostra
qual das duas foi usada em cada otimização.

## Ideias para evoluir ainda mais (se quiser ir além)

- **Testes automatizados** com `pytest` (dá pontos extras em avaliação de
  disciplina de Engenharia de Software)
- **Dockerfile / docker-compose** para rodar com um comando só
- Autenticação de usuários (cada um com seu próprio histórico)
- Deploy do backend em nuvem (Render, Railway) + extensão publicada na
  Chrome Web Store
