(() => {
  "use strict";

  // ---------- Config ----------
  // Adicione mais coleções aqui (id da pasta do Drive + nome de exibição).
  const ROOT_FOLDERS = [
    { id: "1nBM1Niolm_1avHpch9Ssk0jo7bF9BCC3", name: "HQs" }
  ];

  const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
  const FOLDER_MIME = "application/vnd.google-apps.folder";
  const PDF_MIME = "application/pdf";
  const CACHE_TTL = 10 * 60 * 1000; // 10 min
  const LS_API_KEY = "hq_api_key";
  const LS_PROGRESS_PREFIX = "hq_progress_";
  const LS_LAST_READ = "hq_last_read";

  const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });

  // ---------- State ----------
  const state = {
    apiKey: localStorage.getItem(LS_API_KEY) || "",
    pathStack: [], // {id, name}
    currentItems: [],
    reader: { items: [], folderId: null, io: null, currentIndex: 0, path: [] }
  };

  // ---------- DOM refs ----------
  const $ = (sel) => document.querySelector(sel);
  const els = {
    header: $("#app-header"),
    btnBack: $("#btn-back"),
    btnSettings: $("#btn-settings"),
    headerTitle: $("#header-title"),
    headerBreadcrumb: $("#header-breadcrumb"),
    searchBar: $("#search-bar"),
    searchInput: $("#search-input"),
    viewOnboarding: $("#view-onboarding"),
    viewBrowser: $("#view-browser"),
    viewReader: $("#view-reader"),
    apiKeyInput: $("#api-key-input"),
    btnSaveKey: $("#btn-save-key"),
    onboardingError: $("#onboarding-error"),
    continueReading: $("#continue-reading"),
    searchStatus: $("#search-status"),
    browserGrid: $("#browser-grid"),
    browserEmpty: $("#browser-empty"),
    browserLoading: $("#browser-loading"),
    browserError: $("#browser-error"),
    readerPages: $("#reader-pages"),
    readerLoading: $("#reader-loading"),
    readerEnd: $("#reader-end"),
    lightbox: $("#lightbox"),
    lightboxImg: $("#lightbox-img"),
    lightboxClose: $("#lightbox-close")
  };

  // ---------- Helpers ----------
  class DriveError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  function friendlyError(err) {
    if (err instanceof DriveError) {
      switch (err.status) {
        case 400: return "Chave de API inválida. Verifique se copiou a chave corretamente.";
        case 403: return "Acesso negado pela API. Confirme que a Google Drive API está ativada e que as restrições da chave permitem este site.";
        case 404: return "Pasta não encontrada — pode não ser mais pública.";
        case 429: return "Muitas requisições ao Google Drive agora. Aguarde um instante e tente de novo.";
        default: return `Erro do Google Drive (${err.status}): ${err.message}`;
      }
    }
    return "Não foi possível carregar. Verifique sua conexão e tente novamente.";
  }

  function thumbUrl(fileId, width) {
    return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${width}`;
  }

  function isImage(mimeType) {
    return typeof mimeType === "string" && mimeType.startsWith("image/");
  }

  function sortItems(items) {
    return items.slice().sort((a, b) => {
      const af = a.mimeType === FOLDER_MIME;
      const bf = b.mimeType === FOLDER_MIME;
      if (af !== bf) return af ? -1 : 1;
      return collator.compare(a.name, b.name);
    });
  }

  async function listChildren(folderId) {
    const cacheKey = "hq_cache_v2_" + folderId;
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.t < CACHE_TTL) return parsed.items;
      } catch (e) { /* ignore */ }
    }
    let items = [];
    let pageToken;
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, imageMediaMetadata(width,height))",
        orderBy: "folder,name_natural",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        key: state.apiKey
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await fetch(`${DRIVE_FILES_URL}?${params.toString()}`);
      if (!res.ok) {
        let msg = res.statusText;
        try { const j = await res.json(); msg = j?.error?.message || msg; } catch (e) { /* ignore */ }
        throw new DriveError(res.status, msg);
      }
      const data = await res.json();
      items = items.concat(data.files || []);
      pageToken = data.nextPageToken;
    } while (pageToken);
    const sorted = sortItems(items);
    sessionStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), items: sorted }));
    return sorted;
  }

  function partition(items) {
    const folders = items.filter((i) => i.mimeType === FOLDER_MIME);
    const images = items.filter((i) => isImage(i.mimeType));
    const pdfs = items.filter((i) => i.mimeType === PDF_MIME);
    return { folders, images, pdfs };
  }

  // ---------- Progress / last-read ----------
  function saveProgress(folderId, path, index, total) {
    const entry = { pageIndex: index, total, path, updatedAt: Date.now() };
    localStorage.setItem(LS_PROGRESS_PREFIX + folderId, JSON.stringify(entry));
    localStorage.setItem(LS_LAST_READ, JSON.stringify({ folderId, ...entry }));
  }

  function loadProgress(folderId) {
    try {
      const raw = localStorage.getItem(LS_PROGRESS_PREFIX + folderId);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function loadLastRead() {
    try {
      const raw = localStorage.getItem(LS_LAST_READ);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  // ---------- Navigation / history ----------
  function pushHistory() {
    const ids = state.pathStack.map((p) => p.id).join(",");
    history.pushState({ pathIds: state.pathStack.map((p) => p.id) }, "", "#" + encodeURIComponent(ids));
  }

  window.addEventListener("popstate", (e) => {
    const ids = (e.state && e.state.pathIds) || [];
    if (ids.length < state.pathStack.length) {
      state.pathStack = state.pathStack.slice(0, ids.length);
      renderCurrent(false);
    } else if (ids.length === 0) {
      state.pathStack = [];
      renderCurrent(false);
    }
  });

  function goBack() {
    history.back();
  }

  function navigateInto(id, name) {
    state.pathStack.push({ id, name });
    pushHistory();
    renderCurrent(true);
  }

  function goHome() {
    state.pathStack = [];
    history.pushState({ pathIds: [] }, "", "#");
    renderCurrent(true);
  }

  // ---------- Header ----------
  function updateHeader() {
    const atRoot = state.pathStack.length === 0;
    els.btnBack.classList.toggle("hidden", atRoot);
    if (atRoot) {
      els.headerTitle.textContent = "HQs Victor";
      els.headerBreadcrumb.textContent = "";
    } else {
      const last = state.pathStack[state.pathStack.length - 1];
      els.headerTitle.textContent = last.name;
      els.headerBreadcrumb.textContent = state.pathStack.map((p) => p.name).join(" / ");
    }
  }

  // ---------- Rendering: cards ----------
  const coverObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      coverObserver.unobserve(el);
      loadFolderCover(el);
    });
  }, { rootMargin: "200px" });

  async function loadFolderCover(cardEl) {
    const folderId = cardEl.dataset.folderId;
    const cacheKey = "hq_cover_v2_" + folderId;
    let coverId = sessionStorage.getItem(cacheKey);
    if (coverId === "none") return;
    if (!coverId) {
      try {
        const children = await listChildren(folderId);
        const { images, folders } = partition(children);
        let found = images[0];
        if (!found && folders.length) {
          // procura uma imagem uma sub-pasta abaixo (ex: pasta -> pasta -> páginas)
          for (const f of folders.slice(0, 3)) {
            try {
              const sub = await listChildren(f.id);
              const subImg = sub.find((i) => isImage(i.mimeType));
              if (subImg) { found = subImg; break; }
            } catch (e) { /* ignore */ }
          }
        }
        coverId = found ? found.id : "none";
        sessionStorage.setItem(cacheKey, coverId);
      } catch (e) {
        return;
      }
    }
    if (coverId && coverId !== "none") {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = "";
      img.src = thumbUrl(coverId, 300);
      const coverBox = cardEl.querySelector(".card-cover");
      coverBox.querySelector(".fallback-icon")?.remove();
      coverBox.appendChild(img);
    }
  }

  function folderIconSvg() {
    return `<svg class="fallback-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z"/></svg>`;
  }
  function pdfIconSvg() {
    return `<svg class="fallback-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2zm8 1.5V8h4.5"/></svg>`;
  }

  function makeCard(item, pathLabel, onClick) {
    const card = document.createElement("div");
    card.className = "card";
    const isFolder = item.mimeType === FOLDER_MIME;
    const isPdf = item.mimeType === PDF_MIME;
    const isImg = isImage(item.mimeType);

    const cover = document.createElement("div");
    cover.className = "card-cover";

    if (isFolder) {
      cover.innerHTML = folderIconSvg();
      card.dataset.folderId = item.id;
      coverObserver.observe(card);
    } else if (isPdf) {
      cover.innerHTML = pdfIconSvg();
      const badge = document.createElement("div");
      badge.className = "card-badge";
      badge.textContent = "PDF";
      cover.appendChild(badge);
    } else if (isImg) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = "";
      img.src = thumbUrl(item.id, 300);
      cover.appendChild(img);
    }
    card.appendChild(cover);

    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = item.name.replace(/\.[a-zA-Z0-9]{2,4}$/, "");
    card.appendChild(title);

    if (pathLabel) {
      const pathEl = document.createElement("div");
      pathEl.className = "card-path";
      pathEl.textContent = pathLabel;
      card.appendChild(pathEl);
    }

    if (isFolder) {
      const prog = loadProgress(item.id);
      if (prog && prog.total > 1) {
        const bar = document.createElement("div");
        bar.className = "card-progress";
        const fill = document.createElement("div");
        fill.className = "card-progress-fill";
        fill.style.width = Math.min(100, Math.round(((prog.pageIndex + 1) / prog.total) * 100)) + "%";
        bar.appendChild(fill);
        card.appendChild(bar);
      }
    }

    card.addEventListener("click", () => (onClick ? onClick(item) : onItemClick(item)));
    return card;
  }

  function onItemClick(item) {
    if (item.mimeType === FOLDER_MIME) {
      navigateInto(item.id, item.name);
    } else if (item.mimeType === PDF_MIME) {
      openPdfReader(item);
    } else if (isImage(item.mimeType)) {
      // imagem solta: lê todas as imagens irmãs do nível atual
      const { images } = partition(state.currentItems);
      openImageReader(images, item.id, state.pathStack[state.pathStack.length - 1]?.id, item.name);
    }
  }

  // ---------- Continue reading banner ----------
  function renderContinueReading() {
    const last = loadLastRead();
    const el = els.continueReading;
    if (!last || !last.path || !last.path.length) {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }
    const finalNode = last.path[last.path.length - 1];
    el.innerHTML = `
      <div class="cr-thumb"><img loading="lazy" alt=""></div>
      <div class="cr-info">
        <div class="cr-label">Continuar lendo</div>
        <div class="cr-title">${escapeHtml(finalNode.name)}</div>
        <div class="cr-sub">Página ${last.pageIndex + 1} de ${last.total}</div>
      </div>`;
    el.classList.remove("hidden");
    el.onclick = () => {
      state.pathStack = last.path.slice(0, -1);
      pushHistory();
      openFolderAsReader(last.folderId, last.path);
    };
    // thumb: tenta usar a capa em cache
    const cacheKey = "hq_cover_v2_" + last.folderId;
    const coverId = sessionStorage.getItem(cacheKey);
    const img = el.querySelector(".cr-thumb img");
    if (coverId && coverId !== "none") {
      img.src = thumbUrl(coverId, 200);
    } else {
      listChildren(last.folderId).then((children) => {
        const { images } = partition(children);
        if (images[0]) img.src = thumbUrl(images[0].id, 200);
      }).catch(() => {});
    }
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // ---------- Browser view ----------
  async function renderBrowser(pushToHistoryIgnored) {
    showView("browser");
    els.searchBar.classList.remove("hidden");
    els.searchInput.value = "";
    els.browserGrid.innerHTML = "";
    els.browserEmpty.classList.add("hidden");
    els.browserError.classList.add("hidden");
    els.browserLoading.classList.remove("hidden");

    if (state.pathStack.length === 0) {
      renderContinueReading();
      els.browserLoading.classList.add("hidden");
      state.currentItems = ROOT_FOLDERS.map((r) => ({ id: r.id, name: r.name, mimeType: FOLDER_MIME }));
      renderGrid(state.currentItems);
      return;
    }

    els.continueReading.classList.add("hidden");
    const current = state.pathStack[state.pathStack.length - 1];
    try {
      const children = await listChildren(current.id);
      const { folders, images, pdfs } = partition(children);

      // Pasta só com imagens (nenhuma subpasta) => é uma edição: abre leitor direto
      if (folders.length === 0 && images.length > 0) {
        openImageReader(images, images[0].id, current.id, current.name);
        return;
      }

      els.browserLoading.classList.add("hidden");
      const displayItems = [...folders, ...pdfs, ...images];
      state.currentItems = displayItems;
      if (displayItems.length === 0) {
        els.browserEmpty.classList.remove("hidden");
      } else {
        renderGrid(displayItems);
      }
    } catch (err) {
      console.error(err);
      els.browserLoading.classList.add("hidden");
      els.browserError.textContent = friendlyError(err);
      els.browserError.classList.remove("hidden");
    }
  }

  function renderGrid(items) {
    els.browserGrid.innerHTML = "";
    const frag = document.createDocumentFragment();
    items.forEach((item) => frag.appendChild(makeCard(item)));
    els.browserGrid.appendChild(frag);
  }

  // ---------- Busca global (percorre toda a árvore de pastas) ----------
  const SEARCH_MAX_FOLDERS = 500;
  let searchToken = 0;
  let searchDebounce = null;

  async function searchAll(query, token) {
    const q = query.toLowerCase();
    const results = [];
    const queue = ROOT_FOLDERS.map((r) => ({ id: r.id, name: r.name, path: [] }));
    let visited = 0;
    while (queue.length && visited < SEARCH_MAX_FOLDERS) {
      if (token !== searchToken) return results; // busca cancelada (usuário digitou algo novo)
      const node = queue.shift();
      visited++;
      let children;
      try {
        children = await listChildren(node.id);
      } catch (e) {
        continue;
      }
      for (const item of children) {
        if (item.name.toLowerCase().includes(q)) {
          results.push({ item, path: node.path.concat([{ id: node.id, name: node.name }]) });
        }
        if (item.mimeType === FOLDER_MIME) {
          queue.push({ id: item.id, name: item.name, path: node.path.concat([{ id: node.id, name: node.name }]) });
        }
      }
    }
    return results;
  }

  function makeSearchCard(result) {
    const pathLabel = result.path.map((p) => p.name).join(" / ");
    return makeCard(result.item, pathLabel, (item) => onSearchResultClick(item, result.path));
  }

  async function onSearchResultClick(item, ancestorPath) {
    exitSearchMode();
    if (item.mimeType === FOLDER_MIME) {
      state.pathStack = [...ancestorPath, { id: item.id, name: item.name }];
      pushHistory();
      renderCurrent();
      return;
    }
    const parent = ancestorPath[ancestorPath.length - 1];
    state.pathStack = [...ancestorPath];
    pushHistory();
    updateHeader();
    if (item.mimeType === PDF_MIME) {
      openPdfReader(item);
    } else if (isImage(item.mimeType)) {
      try {
        const siblings = await listChildren(parent.id);
        const { images } = partition(siblings);
        openImageReader(images, item.id, parent.id, parent.name);
      } catch (e) {
        openImageReader([item], item.id, parent.id, parent.name);
      }
    }
  }

  function exitSearchMode() {
    els.searchInput.value = "";
    els.searchStatus.classList.add("hidden");
  }

  async function runSearch(query) {
    const token = ++searchToken;
    els.continueReading.classList.add("hidden");
    els.browserEmpty.classList.add("hidden");
    els.browserError.classList.add("hidden");
    els.browserLoading.classList.add("hidden");
    els.searchStatus.textContent = `Buscando "${query}"...`;
    els.searchStatus.classList.remove("hidden");
    els.browserGrid.innerHTML = "";

    const results = await searchAll(query, token);
    if (token !== searchToken) return; // uma busca mais nova já está em andamento

    if (results.length === 0) {
      els.searchStatus.textContent = `Nenhum resultado para "${query}".`;
    } else {
      els.searchStatus.textContent = `${results.length} resultado${results.length > 1 ? "s" : ""} para "${query}"`;
      const frag = document.createDocumentFragment();
      results
        .sort((a, b) => collator.compare(a.item.name, b.item.name))
        .forEach((r) => frag.appendChild(makeSearchCard(r)));
      els.browserGrid.appendChild(frag);
    }
  }

  els.searchInput.addEventListener("input", () => {
    const q = els.searchInput.value.trim();
    clearTimeout(searchDebounce);
    if (!q) {
      searchToken++; // cancela qualquer busca em andamento
      els.searchStatus.classList.add("hidden");
      renderCurrent();
      return;
    }
    searchDebounce = setTimeout(() => runSearch(q), 400);
  });

  // ---------- Reader: helper to open a folder directly (from "continue reading") ----------
  async function openFolderAsReader(folderId, fullPath) {
    showView("browser");
    els.browserLoading.classList.remove("hidden");
    els.browserGrid.innerHTML = "";
    els.continueReading.classList.add("hidden");
    try {
      const children = await listChildren(folderId);
      const { images } = partition(children);
      els.browserLoading.classList.add("hidden");
      if (images.length) {
        state.pathStack = fullPath.slice(0, -1);
        openImageReader(images, images[0].id, folderId, fullPath[fullPath.length - 1].name);
      }
    } catch (err) {
      els.browserLoading.classList.add("hidden");
      els.browserError.textContent = friendlyError(err);
      els.browserError.classList.remove("hidden");
    }
  }

  // ---------- Image reader (rolagem vertical contínua) ----------
  function openImageReader(images, startId, folderId, folderName) {
    showView("reader");
    els.searchBar.classList.add("hidden");
    els.readerPages.innerHTML = "";
    els.readerEnd.classList.add("hidden");

    els.headerTitle.textContent = folderName || "Leitura";
    els.headerBreadcrumb.textContent = state.pathStack.map((p) => p.name).join(" / ");
    els.btnBack.classList.remove("hidden");

    const fullPath = [...state.pathStack];
    if (!fullPath.length || fullPath[fullPath.length - 1].id !== folderId) {
      fullPath.push({ id: folderId, name: folderName });
    }

    if (state.reader.io) state.reader.io.disconnect();
    state.reader = { items: images, folderId, io: null, currentIndex: 0, path: fullPath };

    const frag = document.createDocumentFragment();
    images.forEach((img, idx) => {
      const wrap = document.createElement("div");
      wrap.className = "reader-page";
      wrap.dataset.index = idx;
      if (img.imageMediaMetadata && img.imageMediaMetadata.width && img.imageMediaMetadata.height) {
        wrap.style.aspectRatio = `${img.imageMediaMetadata.width} / ${img.imageMediaMetadata.height}`;
      }
      const el = document.createElement("img");
      el.loading = idx < 2 ? "eager" : "lazy";
      el.alt = `Página ${idx + 1}`;
      el.src = thumbUrl(img.id, 1600);
      el.addEventListener("click", () => openLightbox(img.id));
      wrap.appendChild(el);
      frag.appendChild(wrap);
    });
    els.readerPages.appendChild(frag);

    const endMsg = document.getElementById("reader-end");
    endMsg.classList.remove("hidden");
    els.readerPages.parentElement.appendChild(endMsg);

    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
          const idx = Number(entry.target.dataset.index);
          state.reader.currentIndex = idx;
          saveProgress(folderId, fullPath, idx, images.length);
        }
      });
    }, { threshold: [0.5] });
    document.querySelectorAll(".reader-page").forEach((el) => io.observe(el));
    state.reader.io = io;

    const prog = loadProgress(folderId);
    if (prog && prog.pageIndex > 0 && prog.pageIndex < images.length) {
      requestAnimationFrame(() => {
        const target = document.querySelector(`.reader-page[data-index="${prog.pageIndex}"]`);
        if (target) target.scrollIntoView({ block: "start" });
      });
    } else {
      window.scrollTo(0, 0);
    }
  }

  function openPdfReader(item) {
    showView("reader");
    els.searchBar.classList.add("hidden");
    if (state.reader.io) { state.reader.io.disconnect(); state.reader.io = null; }
    els.headerTitle.textContent = item.name;
    els.headerBreadcrumb.textContent = state.pathStack.map((p) => p.name).join(" / ");
    els.btnBack.classList.remove("hidden");
    els.readerPages.innerHTML = `<div class="reader-pdf-wrap"><iframe src="https://drive.google.com/file/d/${item.id}/preview" allow="autoplay"></iframe></div>`;
    els.readerEnd.classList.add("hidden");
  }

  function openLightbox(fileId) {
    els.lightboxImg.src = thumbUrl(fileId, 2400);
    els.lightbox.classList.remove("hidden");
  }
  els.lightboxClose.addEventListener("click", () => els.lightbox.classList.add("hidden"));
  els.lightbox.addEventListener("click", (e) => {
    if (e.target === els.lightbox) els.lightbox.classList.add("hidden");
  });

  // ---------- View switching ----------
  function showView(name) {
    els.viewOnboarding.classList.toggle("hidden", name !== "onboarding");
    els.viewBrowser.classList.toggle("hidden", name !== "browser");
    els.viewReader.classList.toggle("hidden", name !== "reader");
    window.scrollTo(0, 0);
  }

  function renderCurrent() {
    updateHeader();
    renderBrowser();
  }

  // ---------- Onboarding ----------
  function showOnboarding(prefillError) {
    showView("onboarding");
    els.searchBar.classList.add("hidden");
    els.btnBack.classList.add("hidden");
    els.headerTitle.textContent = "HQs Victor";
    els.headerBreadcrumb.textContent = "";
    if (state.apiKey) els.apiKeyInput.value = state.apiKey;
    if (prefillError) {
      els.onboardingError.textContent = prefillError;
      els.onboardingError.classList.remove("hidden");
    } else {
      els.onboardingError.classList.add("hidden");
    }
  }

  els.btnSaveKey.addEventListener("click", () => {
    const key = els.apiKeyInput.value.trim();
    if (!key) {
      els.onboardingError.textContent = "Cole uma chave de API válida.";
      els.onboardingError.classList.remove("hidden");
      return;
    }
    state.apiKey = key;
    localStorage.setItem(LS_API_KEY, key);
    sessionStorage.clear();
    state.pathStack = [];
    history.pushState({ pathIds: [] }, "", "#");
    renderCurrent();
  });

  els.btnSettings.addEventListener("click", () => showOnboarding());
  els.btnBack.addEventListener("click", () => {
    if (!els.viewOnboarding.classList.contains("hidden")) {
      if (state.apiKey) renderCurrent();
      return;
    }
    goBack();
  });

  // ---------- Init ----------
  function init() {
    if (!state.apiKey) {
      showOnboarding();
      return;
    }
    history.replaceState({ pathIds: [] }, "", "#");
    renderCurrent();
  }

  init();
})();
