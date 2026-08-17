# HQs Victor

Leitor de HQs mobile que lê pastas do Google Drive em tempo real, com rolagem
vertical contínua (estilo webtoon), capas automáticas, busca e retomada de
leitura de onde você parou.

## Como usar

1. Abra o site publicado (ou `index.html` localmente).
2. Na primeira vez, cole uma chave de API do Google Drive (veja abaixo como
   gerar). Ela fica salva só no seu navegador (`localStorage`), nunca é
   enviada a nenhum servidor além do Google.
3. Navegue pelas pastas/arcos do Drive. Pastas que só contêm imagens abrem
   direto no modo leitura.

## Gerar sua chave de API do Google Drive (gratuito, ~2 min)

1. Acesse [console.cloud.google.com](https://console.cloud.google.com/) e
   crie um projeto (qualquer nome, ex. `leitor-hq`).
2. Vá em **APIs e Serviços → Biblioteca**, busque **Google Drive API** e
   clique em **Ativar**.
3. Vá em **APIs e Serviços → Credenciais → Criar credenciais → Chave de
   API**.
4. (Recomendado) Clique na chave criada:
   - Em **Restrições de API**, selecione apenas **Google Drive API**.
   - Em **Restrições de aplicativo**, escolha **Sites** e adicione o domínio
     onde o site está publicado (ex. `https://SEU_USUARIO.github.io/*`).
5. Copie a chave e cole no site.

As pastas do Drive lidas precisam estar compartilhadas como "Qualquer
pessoa com o link" (modo leitor), já que a chave de API não faz login na
sua conta — ela só lê o que é público.

## Adicionar mais coleções

Edite `js/app.js`, no topo do arquivo, o array `ROOT_FOLDERS`:

```js
const ROOT_FOLDERS = [
  { id: "1-KhC8KECOzbYfO6v8yTaX6xn0RAGbwR6", name: "X-Men" },
  // { id: "OUTRO_ID_DA_PASTA", name: "Outra coleção" },
];
```

O `id` é o trecho depois de `/folders/` no link do Drive.

## Rodar localmente

Qualquer servidor estático funciona, por exemplo:

```bash
python -m http.server 8934
```

Depois abra `http://localhost:8934`.

## Publicar no GitHub Pages

O repositório já vem pronto para Pages a partir da branch `main`, pasta
raiz. Basta habilitar em **Settings → Pages** (ou já estará habilitado se
publicado via `gh`).

## Estrutura

- `index.html` — telas (onboarding, navegador de pastas, leitor)
- `css/style.css` — visual mobile-first, tema escuro
- `js/app.js` — toda a lógica: chamadas à Drive API v3, cache em
  `sessionStorage`, progresso de leitura em `localStorage`, renderização
