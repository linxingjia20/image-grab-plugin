'use strict';

(() => {
  const MAX_CONCURRENT_DOWNLOADS = 2;
  const FETCH_TIMEOUT_MS = 25000;
  const MAX_IMAGE_BYTES = 60 * 1024 * 1024;
  const MAX_DATA_URL_LENGTH = 3 * 1024 * 1024;
  const MAX_CANVAS_DIMENSION = 8192;
  const MAX_CANVAS_AREA = 32_000_000;
  const OBJECT_URL_LIFETIME_MS = 10 * 60 * 1000;

  const SITE_LABELS = {
    taobao: '淘宝 / 天猫',
    jd: '京东',
    pdd: '拼多多',
    ecommerce: '电商'
  };

  const ALLOWED_ORIGINS = new Set(['img', 'lazy', 'poster', 'svg', 'css']);

  const state = {
    scan: null,
    images: [],
    imageById: new Map(),
    selected: new Set(),
    filter: 'all',
    downloading: false,
    cardById: new Map(),
    toastTimer: null,
    downloadBarTimer: null,
    objectUrls: new Map(),
    downloadStamp: '',
    lastFocus: null,
    lightboxItem: null
  };

  const els = {};

  function clampInt(value, min, max, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function truncateText(value, maxLength) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function toHttpUrl(value) {
    if (typeof value !== 'string') return '';
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      url.hash = '';
      return url.href;
    } catch {
      return '';
    }
  }

  function safeImageUrl(value) {
    if (typeof value !== 'string') return '';
    const raw = value.trim();
    if (!raw) return '';

    if (/^data:image\//i.test(raw)) {
      return raw.length <= MAX_DATA_URL_LENGTH ? raw : '';
    }

    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      url.hash = '';
      return url.href;
    } catch {
      return '';
    }
  }

  function cacheElements() {
    const ids = [
      'loading',
      'emptyState',
      'emptyTitle',
      'emptyText',
      'galleryView',
      'sourceMeta',
      'sourceLink',
      'summary',
      'selectAll',
      'invertBtn',
      'countText',
      'filterSelect',
      'downloadBtn',
      'downloadLabel',
      'grid',
      'toast',
      'downloadBar',
      'downloadText',
      'downloadPercent',
      'downloadProgress',
      'downloadDetail',
      'lightbox',
      'lightboxClose',
      'lightboxImg',
      'lightboxCaption',
      'lightboxOpen'
    ];

    for (const id of ids) {
      els[id] = document.getElementById(id);
    }
  }

  function bindEvents() {
    els.selectAll.addEventListener('change', handleSelectAll);
    els.invertBtn.addEventListener('click', handleInvertSelection);
    els.filterSelect.addEventListener('change', handleFilterChange);
    els.downloadBtn.addEventListener('click', handleDownload);
    els.grid.addEventListener('change', handleGridChange);
    els.grid.addEventListener('click', handleGridClick);

    els.lightboxClose.addEventListener('click', closeLightbox);
    els.lightbox.addEventListener('click', (event) => {
      if (event.target === els.lightbox) closeLightbox();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !els.lightbox.hidden) {
        closeLightbox();
      }
    });

    window.addEventListener('beforeunload', (event) => {
      if (!state.downloading) return;
      event.preventDefault();
      event.returnValue = '';
    });

    window.addEventListener('pagehide', (event) => {
      if (event.persisted) return;
      for (const entry of state.objectUrls.values()) {
        clearTimeout(entry.timer);
        URL.revokeObjectURL(entry.url);
      }
      state.objectUrls.clear();
    });

    if (chrome.downloads && chrome.downloads.onChanged) {
      chrome.downloads.onChanged.addListener(handleDownloadChanged);
    }
  }

  async function init() {
    cacheElements();

    if (
      !els.grid ||
      !els.downloadBtn ||
      !els.lightbox ||
      !els.emptyState ||
      !els.galleryView
    ) {
      console.error('[图片采集] 页面结构不完整');
      return;
    }

    bindEvents();

    try {
      await loadScan();
    } catch (error) {
      console.error('[图片采集] 读取数据失败：', error);
      showEmpty('读取采集结果失败', '请关闭此页，回到商品详情页重新采集。');
    }
  }

  function showLoading() {
    els.loading.hidden = false;
    els.emptyState.hidden = true;
    els.galleryView.hidden = true;
    if (els.sourceLink) els.sourceLink.hidden = true;
  }

  function showEmpty(title, text) {
    els.loading.hidden = true;
    els.galleryView.hidden = true;
    els.emptyState.hidden = false;
    if (els.sourceLink) els.sourceLink.hidden = true;

    if (title) {
      els.emptyTitle.textContent = title;
      els.sourceMeta.textContent = title;
    }
    if (text) els.emptyText.textContent = text;
  }

  function showGallery() {
    els.loading.hidden = true;
    els.emptyState.hidden = true;
    els.galleryView.hidden = false;
  }

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(keys, (result) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
          } else {
            resolve(result || {});
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function loadScan() {
    showLoading();

    const params = new URLSearchParams(location.search);
    let scanId = params.get('scan');

    if (!scanId) {
      const storedLatest = await storageGet('latestScanId');
      scanId =
        typeof storedLatest.latestScanId === 'string'
          ? storedLatest.latestScanId
          : '';
    }

    if (!scanId) {
      els.sourceMeta.textContent = '还没有采集记录';
      showEmpty();
      return;
    }

    const key = `scan:${scanId}`;
    const stored = await storageGet(key);
    const scan = normalizeScan(stored[key]);

    if (!scan || scan.images.length === 0) {
      showEmpty(
        '采集记录不存在',
        '该记录可能已被新采集覆盖。请回到商品详情页，点击右下角「获取图片」重新扫描。'
      );
      return;
    }

    state.scan = scan;
    state.images = scan.images;
    state.imageById = new Map(scan.images.map((image) => [image.id, image]));
    state.selected.clear();
    state.filter = 'all';

    try {
      const nextUrl = new URL(location.href);
      nextUrl.searchParams.set('scan', scanId);
      history.replaceState(null, '', nextUrl.href);
    } catch {
      // 忽略历史记录更新失败
    }

    renderScan(scan);
  }

  function normalizeScan(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.images)) {
      return null;
    }

    const images = [];
    const usedIds = new Set();

    for (let index = 0; index < raw.images.length; index += 1) {
      const image = normalizeImage(raw.images[index], index);
      if (!image) continue;

      let id = image.id;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${image.id}-${suffix}`;
        suffix += 1;
      }

      usedIds.add(id);
      images.push({ ...image, id });
    }

    const site = Object.prototype.hasOwnProperty.call(SITE_LABELS, raw.site)
      ? raw.site
      : 'ecommerce';

    return {
      ...raw,
      site,
      pageTitle: truncateText(raw.pageTitle, 300) || '商品详情页',
      pageUrl: toHttpUrl(raw.pageUrl),
      createdAt: Number(raw.createdAt) || 0,
      stats: {
        filtered: clampInt(raw.stats && raw.stats.filtered, 0, 100000, 0),
        truncated: Boolean(raw.stats && raw.stats.truncated)
      },
      images
    };
  }

  function normalizeImage(raw, index) {
    if (!raw || typeof raw !== 'object') return null;

    const url = safeImageUrl(raw.url) || safeImageUrl(raw.originalUrl);
    if (!url) return null;

    const originalUrl = safeImageUrl(raw.originalUrl) || url;
    const source = raw.source === 'background' ? 'background' : 'image';
    const origin = ALLOWED_ORIGINS.has(raw.origin) ? raw.origin : 'img';

    return {
      id:
        typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 120
          ? raw.id
          : `img-${index + 1}`,
      url,
      originalUrl,
      width: clampInt(raw.width, 0, 100000, 0),
      height: clampInt(raw.height, 0, 100000, 0),
      source,
      origin,
      alt: truncateText(raw.alt, 300)
    };
  }

  function renderScan(scan) {
    const siteLabel = SITE_LABELS[scan.site] || SITE_LABELS.ecommerce;
    const timestamp = formatTimestamp(scan.createdAt);
    const metaParts = [siteLabel, scan.pageTitle, timestamp].filter(Boolean);

    els.sourceMeta.textContent = metaParts.join(' · ');
    els.sourceMeta.title = scan.pageTitle || '';

    if (els.sourceLink) {
      const pageUrl = toHttpUrl(scan.pageUrl);
      if (pageUrl) {
        els.sourceLink.href = pageUrl;
        els.sourceLink.hidden = false;
        els.sourceLink.title = scan.pageTitle || '打开原页面';
      } else {
        els.sourceLink.hidden = true;
      }
    }

    document.title = `${scan.pageTitle} · 图片采集`;

    const backgroundCount = scan.images.filter(
      (image) => image.source === 'background'
    ).length;
    const summaryParts = [`共 ${scan.images.length} 张图片`];

    if (backgroundCount > 0) {
      summaryParts.push(`背景图 ${backgroundCount} 张`);
    }
    if (scan.stats.filtered > 0) {
      summaryParts.push(`已过滤 ${scan.stats.filtered} 个无效或小尺寸图片`);
    }
    if (scan.stats.truncated) {
      summaryParts.push('图片较多，仅展示部分结果');
    }

    els.summary.textContent = summaryParts.join(' · ');

    els.selectAll.checked = false;
    els.selectAll.indeterminate = false;
    els.filterSelect.value = 'all';
    state.filter = 'all';

    state.cardById.clear();
    const fragment = document.createDocumentFragment();

    scan.images.forEach((image, index) => {
      fragment.appendChild(createCard(image, index));
    });

    els.grid.replaceChildren(fragment);
    showGallery();
    applyFilter();
    updateSelectionUI();
  }

  function createCard(item, index) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = item.id;
    card.dataset.source = item.source;
    card.style.setProperty('--i', String(Math.min(index, 18)));

    const checkLabel = document.createElement('label');
    checkLabel.className = 'card-check';
    checkLabel.title = '选择此图片';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `选择第 ${index + 1} 张图片`);
    checkLabel.appendChild(checkbox);

    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'thumb';
    thumb.dataset.action = 'preview';
    thumb.setAttribute('aria-label', `预览第 ${index + 1} 张图片`);
    thumb.title = '点击预览大图';

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.alt = item.alt || `图片 ${index + 1}`;
    img.src = item.url;

    img.addEventListener('error', () => {
      handleCardImageError(item, img, card);
    });

    const fallback = document.createElement('span');
    fallback.className = 'thumb-fallback';
    fallback.textContent = '预览加载失败';

    thumb.append(img, fallback);

    const body = document.createElement('div');
    body.className = 'card-body';

    const meta = document.createElement('div');
    meta.className = 'card-meta';

    const badgeInfo = getBadgeInfo(item);
    const badge = document.createElement('span');
    badge.className = `source-badge${badgeInfo.isBackground ? ' is-background' : ''}`;
    badge.textContent = badgeInfo.label;

    const dims = document.createElement('span');
    dims.className = 'card-dims';
    dims.textContent = formatDimensions(item);

    meta.append(badge, dims);

    const alt = document.createElement('div');
    alt.className = 'card-alt';
    alt.textContent = item.alt || '';

    const url = document.createElement('div');
    url.className = 'card-url';
    url.textContent = displayUrl(item.url);
    url.title = /^data:/i.test(item.url) ? '内嵌图片' : item.url;

    const status = document.createElement('div');
    status.className = 'card-status';
    status.textContent = '下载失败';

    body.append(meta, alt, url, status);
    card.append(checkLabel, thumb, body);

    state.cardById.set(item.id, { card, checkbox, img });

    return card;
  }

  function handleCardImageError(item, img, card) {
    if (
      img.dataset.fallbackTried !== '1' &&
      item.originalUrl &&
      item.originalUrl !== item.url
    ) {
      img.dataset.fallbackTried = '1';
      img.src = item.originalUrl;
      return;
    }

    card.classList.add('is-broken');
  }

  function getBadgeInfo(item) {
    if (item.source === 'background') {
      return { label: '背景图', isBackground: true };
    }

    if (item.origin === 'poster') {
      return { label: '视频封面', isBackground: false };
    }

    if (item.origin === 'svg') {
      return { label: 'SVG', isBackground: false };
    }

    if (item.origin === 'lazy') {
      return { label: '懒加载', isBackground: false };
    }

    return { label: '图片', isBackground: false };
  }

  function formatDimensions(item) {
    if (item.width > 0 && item.height > 0) {
      return `${item.width} × ${item.height}`;
    }
    if (item.width > 0) return `宽 ${item.width}`;
    if (item.height > 0) return `高 ${item.height}`;
    return '尺寸未知';
  }

  function displayUrl(value) {
    if (/^data:/i.test(value)) return '内嵌图片 (data URI)';
    try {
      const url = new URL(value);
      let path = url.pathname;
      try {
        path = decodeURIComponent(path);
      } catch {
        // 保留原始 path
      }
      return `${url.hostname}${path}`.slice(0, 160);
    } catch {
      return String(value).slice(0, 160);
    }
  }

  function hostLabel(value) {
    if (/^data:/i.test(value)) return '内嵌图片';
    try {
      return new URL(value).hostname;
    } catch {
      return '';
    }
  }

  function formatTimestamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';

    const pad = (number) => String(number).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
      date.getHours()
    )}:${pad(date.getMinutes())}`;
  }

  function formatDateStamp(date) {
    const pad = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
      date.getDate()
    )}`;
  }

  function getVisibleImages() {
    if (state.filter === 'background') {
      return state.images.filter((image) => image.source === 'background');
    }
    if (state.filter === 'image') {
      return state.images.filter((image) => image.source !== 'background');
    }
    return state.images;
  }

  function applyFilter() {
    const visibleIds = new Set(getVisibleImages().map((image) => image.id));

    for (const [id, ref] of state.cardById) {
      ref.card.hidden = !visibleIds.has(id);
    }

    updateSelectionUI();
  }

  function updateSelectionUI() {
    const visible = getVisibleImages();
    const selectedVisible = visible.filter((image) =>
      state.selected.has(image.id)
    ).length;

    const selectedCount = state.selected.size;
    const totalCount = state.images.length;

    els.countText.textContent =
      state.filter === 'all'
        ? `已选 ${selectedCount} / ${totalCount} 张`
        : `已选 ${selectedCount} / ${totalCount} 张 · 当前 ${visible.length} 张`;

    els.selectAll.checked =
      visible.length > 0 && selectedVisible === visible.length;
    els.selectAll.indeterminate =
      selectedVisible > 0 && selectedVisible < visible.length;
    els.selectAll.disabled = state.downloading || visible.length === 0;
    els.invertBtn.disabled = state.downloading || visible.length === 0;

    els.downloadBtn.disabled = state.downloading || selectedCount === 0;
    els.downloadBtn.title =
      selectedCount > 0
        ? `将 ${selectedCount} 张图片转换为 PNG`
        : '请先勾选图片';

    if (state.downloading) {
      els.downloadLabel.textContent = '正在下载…';
    } else if (selectedCount > 0) {
      els.downloadLabel.textContent = `下载 ${selectedCount} 张为 PNG`;
    } else {
      els.downloadLabel.textContent = '下载选中为 PNG';
    }
  }

  function syncAllCards() {
    for (const [id, ref] of state.cardById) {
      const selected = state.selected.has(id);
      ref.checkbox.checked = selected;
      ref.card.classList.toggle('is-selected', selected);
    }
  }

  function syncCard(id) {
    const ref = state.cardById.get(id);
    if (!ref) return;
    const selected = state.selected.has(id);
    ref.checkbox.checked = selected;
    ref.card.classList.toggle('is-selected', selected);
  }

  function toggleSelection(id, force) {
    if (!state.imageById.has(id)) return;

    const shouldSelect =
      typeof force === 'boolean' ? force : !state.selected.has(id);

    if (shouldSelect) {
      state.selected.add(id);
    } else {
      state.selected.delete(id);
    }

    syncCard(id);
    updateSelectionUI();
  }

  function handleSelectAll() {
    if (state.downloading) return;

    const shouldSelect = els.selectAll.checked;
    for (const image of getVisibleImages()) {
      if (shouldSelect) {
        state.selected.add(image.id);
      } else {
        state.selected.delete(image.id);
      }
    }

    syncAllCards();
    updateSelectionUI();
  }

  function handleInvertSelection() {
    if (state.downloading) return;

    for (const image of getVisibleImages()) {
      if (state.selected.has(image.id)) {
        state.selected.delete(image.id);
      } else {
        state.selected.add(image.id);
      }
    }

    syncAllCards();
    updateSelectionUI();
  }

  function handleFilterChange() {
    state.filter = els.filterSelect.value;
    applyFilter();
  }

  function handleGridChange(event) {
    const input = event.target.closest('input[type="checkbox"]');
    if (!input) return;

    const card = input.closest('.card');
    if (!card) return;

    toggleSelection(card.dataset.id, input.checked);
  }

  function handleGridClick(event) {
    const previewButton = event.target.closest('[data-action="preview"]');
    if (previewButton) {
      const card = previewButton.closest('.card');
      const item = card ? state.imageById.get(card.dataset.id) : null;
      if (item) openLightbox(item);
      return;
    }

    if (event.target.closest('.card-check, input, a')) return;

    const card = event.target.closest('.card');
    if (!card) return;

    toggleSelection(card.dataset.id);
  }

  function openLightbox(item) {
    state.lightboxItem = item;
    state.lastFocus = document.activeElement;

    els.lightboxImg.dataset.fallbackTried = '0';
    els.lightboxImg.alt = item.alt || '图片预览';
    els.lightboxImg.src = item.url;
    els.lightboxImg.onerror = () => handleLightboxError(item);

    const badgeInfo = getBadgeInfo(item);
    els.lightboxCaption.textContent = [
      badgeInfo.label,
      formatDimensions(item),
      hostLabel(item.url)
    ]
      .filter(Boolean)
      .join(' · ');

    const openUrl = toHttpUrl(item.originalUrl) || toHttpUrl(item.url);
    if (openUrl) {
      els.lightboxOpen.href = openUrl;
      els.lightboxOpen.hidden = false;
    } else {
      els.lightboxOpen.hidden = true;
      els.lightboxOpen.removeAttribute('href');
    }

    els.lightbox.hidden = false;
    document.body.classList.add('no-scroll');
    els.lightboxClose.focus();
  }

  function handleLightboxError(item) {
    if (
      els.lightboxImg.dataset.fallbackTried !== '1' &&
      item.originalUrl &&
      item.originalUrl !== item.url
    ) {
      els.lightboxImg.dataset.fallbackTried = '1';
      els.lightboxImg.src = item.originalUrl;
      return;
    }

    els.lightboxCaption.textContent = '大图加载失败，可尝试打开原图。';
  }

  function closeLightbox() {
    if (els.lightbox.hidden) return;

    els.lightbox.hidden = true;
    els.lightboxImg.onerror = null;
    els.lightboxImg.removeAttribute('src');
    els.lightboxItem = null;
    document.body.classList.remove('no-scroll');

    if (state.lastFocus && typeof state.lastFocus.focus === 'function') {
      state.lastFocus.focus();
    }
    state.lastFocus = null;
  }

  async function handleDownload() {
    if (state.downloading) return;

    const items = state.images.filter((image) => state.selected.has(image.id));
    if (items.length === 0) {
      showToast('请先勾选要下载的图片', 'warning');
      return;
    }

    state.downloading = true;
    state.downloadStamp = formatDateStamp(new Date());
    updateSelectionUI();
    showDownloadBar(items.length);

    for (const item of items) {
      const ref = state.cardById.get(item.id);
      if (ref) ref.card.classList.remove('is-failed');
    }

    els.downloadDetail.textContent = '正在检查图片访问权限…';

    try {
      await ensureImagePermissions(items);
    } catch (error) {
      console.warn('[图片采集] 权限检查失败：', error);
    }

    const total = items.length;
    let done = 0;
    let scaled = 0;
    const failures = [];
    const queue = items.map((item, index) => ({ item, index }));

    els.downloadDetail.textContent = `准备下载 ${total} 张图片…`;

    async function worker() {
      while (queue.length > 0) {
        const task = queue.shift();
        if (!task) return;

        els.downloadDetail.textContent = `正在处理 ${Math.min(
          done + 1,
          total
        )} / ${total} 张：${shortLabel(task.item)}`;

        try {
          const result = await downloadOne(task.item, task.index, total);
          if (result.scaled) scaled += 1;
        } catch (error) {
          failures.push({ item: task.item, error });
          markCardFailed(task.item.id, error);
          console.warn('[图片采集] 下载失败：', task.item.url, error);
        } finally {
          done += 1;
          updateDownloadBar(done, total);
        }
      }
    }

    try {
      const workerCount = Math.min(MAX_CONCURRENT_DOWNLOADS, total);
      await Promise.all(
        Array.from({ length: workerCount }, () => worker())
      );

      state.downloading = false;
      updateSelectionUI();

      const failedCount = failures.length;
      const successCount = total - failedCount;

      els.downloadText.textContent = '下载完成';
      els.downloadPercent.textContent = '100%';
      els.downloadProgress.style.width = '100%';
      els.downloadDetail.textContent = `成功 ${successCount} / ${total} 张${
        failedCount > 0 ? `，失败 ${failedCount} 张` : ''
      }`;

      const folder = `ecom-images/${state.scan.site}/${state.downloadStamp}/`;
      let message = `成功下载 ${successCount} 张 PNG，保存在 ${folder}`;
      let toastType = 'success';

      if (scaled > 0) {
        message += `；${scaled} 张超大图已等比缩小`;
      }

      if (failedCount > 0) {
        message += `。${failedCount} 张失败，可能受防盗链、跨域权限或图片格式限制。`;
        toastType = successCount > 0 ? 'warning' : 'error';
      }

      showToast(message, toastType, failedCount > 0 ? 6500 : 3800);
      scheduleHideDownloadBar(failedCount > 0 ? 7000 : 3200);
    } catch (error) {
      console.error('[图片采集] 批量下载异常：', error);
      state.downloading = false;
      updateSelectionUI();
      els.downloadText.textContent = '下载中断';
      els.downloadDetail.textContent = '发生异常，请重试已选图片。';
      showToast('批量下载中断，请重试。', 'error', 5000);
      scheduleHideDownloadBar(5000);
    }
  }

  async function downloadOne(item, index, total) {
    const ref = state.cardById.get(item.id);
    if (ref) ref.card.classList.remove('is-failed');

    const sourceBlob = await fetchImageBlob(item);
    const converted = await convertToPng(sourceBlob);
    const objectUrl = URL.createObjectURL(converted.blob);

    const filename = buildFilename(item, index, total);

    let downloadId;
    try {
      downloadId = await downloadsDownload({
        url: objectUrl,
        filename,
        saveAs: false,
        conflictAction: 'uniquify'
      });
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }

    trackObjectUrl(downloadId, objectUrl);
    return { scaled: converted.scaled };
  }

  async function fetchImageBlob(item) {
    const urls = [];
    if (item.url) urls.push(item.url);
    if (item.originalUrl && item.originalUrl !== item.url) {
      urls.push(item.originalUrl);
    }

    let lastError = null;

    for (const url of urls) {
      try {
        return await fetchOneImage(url);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('无法读取图片内容');
  }

  async function fetchOneImage(url) {
    const response = await fetchWithTimeout(url, {
      credentials: 'omit',
      cache: 'no-cache',
      referrerPolicy: 'no-referrer'
    });

    if (!response.ok) {
      throw new Error(`图片请求失败（HTTP ${response.status}）`);
    }
    if (response.type === 'opaque') {
      throw new Error('图片响应不可读取');
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (
      contentType.includes('text/html') ||
      contentType.includes('application/json')
    ) {
      throw new Error('图片地址返回了网页内容');
    }

    const blob = await response.blob();
    if (!blob.size) throw new Error('图片内容为空');
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('图片超过 60MB');

    return blob;
  }

  async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error('图片请求超时');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function convertToPng(blob) {
    const decoded = await decodeImage(blob);

    try {
      const width = decoded.width;
      const height = decoded.height;

      if (!width || !height) {
        throw new Error('图片尺寸无效');
      }

      const scale = Math.min(
        1,
        MAX_CANVAS_DIMENSION / width,
        MAX_CANVAS_DIMENSION / height,
        Math.sqrt(MAX_CANVAS_AREA / (width * height))
      );

      const canvasWidth = Math.max(1, Math.round(width * scale));
      const canvasHeight = Math.max(1, Math.round(height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;

      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建画布');

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(decoded.source, 0, 0, canvasWidth, canvasHeight);

      const pngBlob = await canvasToBlob(canvas);
      return {
        blob: pngBlob,
        scaled: scale < 0.999
      };
    } finally {
      if (typeof decoded.cleanup === 'function') decoded.cleanup();
    }
  }

  async function decodeImage(blob) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(blob, {
          imageOrientation: 'from-image'
        });
        if (bitmap.width > 0 && bitmap.height > 0) {
          return {
            source: bitmap,
            width: bitmap.width,
            height: bitmap.height,
            cleanup: () => {
              if (typeof bitmap.close === 'function') bitmap.close();
            }
          };
        }
        if (typeof bitmap.close === 'function') bitmap.close();
      } catch {
        // 某些格式（如部分 SVG）需要回退到 HTMLImageElement
      }
    }

    const objectUrl = URL.createObjectURL(blob);

    try {
      const image = await loadImageElement(objectUrl);
      return {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        cleanup: () => URL.revokeObjectURL(objectUrl)
      };
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  function loadImageElement(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('浏览器无法解码该图片'));
      image.src = url;
    });
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('PNG 编码失败'));
        }
      }, 'image/png');
    });
  }

  function buildFilename(item, index, total) {
    const site = ['taobao', 'jd', 'pdd'].includes(state.scan.site)
      ? state.scan.site
      : 'ecommerce';
    const stamp = state.downloadStamp || formatDateStamp(new Date());
    const width = Math.max(3, String(total).length);
    const sequence = String(index + 1).padStart(width, '0');
    const base = filenameFromUrl(item.url || item.originalUrl);

    return `ecom-images/${site}/${stamp}/${sequence}-${base}.png`;
  }

  function filenameFromUrl(value) {
    if (!value || /^data:/i.test(value)) return 'image';

    try {
      const url = new URL(value);
      const segment = url.pathname.split('/').filter(Boolean).pop() || 'image';
      let name = segment;

      try {
        name = decodeURIComponent(segment);
      } catch {
        // 使用原始文件名
      }

      name = name.replace(/\.[a-z0-9]{1,6}$/i, '');
      return sanitizeFilename(name) || 'image';
    } catch {
      return 'image';
    }
  }

  function sanitizeFilename(value) {
    let name = String(value || '')
      .normalize('NFKC')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[.\-\s]+|[.\-\s]+$/g, '')
      .slice(0, 56);

    if (!name) return '';

    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
      name = `_${name}`;
    }

    return name;
  }

  function shortLabel(item) {
    const alt = truncateText(item.alt, 40);
    if (alt) return alt;
    return filenameFromUrl(item.url || item.originalUrl).slice(0, 40);
  }

  function showDownloadBar(total) {
    clearTimeout(state.downloadBarTimer);
    state.downloadBarTimer = null;
    els.downloadBar.hidden = false;
    els.downloadText.textContent = '正在转换并下载…';
    els.downloadPercent.textContent = '0%';
    els.downloadProgress.style.width = '0%';
    els.downloadDetail.textContent = `共 ${total} 张图片，PNG 转换在本地完成。`;
  }

  function updateDownloadBar(done, total) {
    const percent = total > 0 ? Math.round((done / total) * 100) : 100;
    els.downloadPercent.textContent = `${percent}%`;
    els.downloadProgress.style.width = `${percent}%`;
    els.downloadText.textContent =
      done >= total ? '正在完成…' : '正在转换并下载…';
    els.downloadDetail.textContent = `已处理 ${done} / ${total} 张`;
  }

  function scheduleHideDownloadBar(delay) {
    clearTimeout(state.downloadBarTimer);
    state.downloadBarTimer = setTimeout(() => {
      if (!state.downloading) {
        els.downloadBar.hidden = true;
      }
    }, delay);
  }

  function markCardFailed(id, error) {
    const ref = state.cardById.get(id);
    if (!ref) return;

    ref.card.classList.add('is-failed');
    const status = ref.card.querySelector('.card-status');
    if (status) {
      status.textContent = '下载失败';
      status.title = error && error.message ? error.message : '';
    }
  }

  function trackObjectUrl(downloadId, objectUrl) {
    const timer = setTimeout(() => {
      releaseObjectUrl(downloadId, 0);
    }, OBJECT_URL_LIFETIME_MS);

    state.objectUrls.set(downloadId, { url: objectUrl, timer });

    // 防止下载在 onChanged 监听注册前就已经完成。
    try {
      chrome.downloads.search({ id: downloadId }, (items) => {
        void chrome.runtime.lastError;
        const item = Array.isArray(items) ? items[0] : null;
        if (item && (item.state === 'complete' || item.state === 'interrupted')) {
          releaseObjectUrl(downloadId, 1500);
        }
      });
    } catch {
      // 忽略查询失败，定时器仍会释放
    }
  }

  function releaseObjectUrl(downloadId, delay = 0) {
    const entry = state.objectUrls.get(downloadId);
    if (!entry) return;

    clearTimeout(entry.timer);
    state.objectUrls.delete(downloadId);

    if (delay > 0) {
      setTimeout(() => URL.revokeObjectURL(entry.url), delay);
    } else {
      URL.revokeObjectURL(entry.url);
    }
  }

  function handleDownloadChanged(delta) {
    if (!delta || typeof delta.id !== 'number') return;

    const stage = delta.state && delta.state.current;
    if (stage !== 'complete' && stage !== 'interrupted') return;

    releaseObjectUrl(delta.id, 4000);
  }

  function downloadsDownload(options) {
    return new Promise((resolve, reject) => {
      try {
        chrome.downloads.download(options, (downloadId) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
          } else if (typeof downloadId === 'number') {
            resolve(downloadId);
          } else {
            reject(new Error('下载任务未能创建'));
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function permissionsContains(origin) {
    return new Promise((resolve) => {
      try {
        chrome.permissions.contains({ origins: [origin] }, (granted) => {
          void chrome.runtime.lastError;
          resolve(Boolean(granted));
        });
      } catch {
        resolve(false);
      }
    });
  }

  function permissionsRequest(origins) {
    return new Promise((resolve) => {
      try {
        chrome.permissions.request({ origins }, (granted) => {
          void chrome.runtime.lastError;
          resolve(Boolean(granted));
        });
      } catch {
        resolve(false);
      }
    });
  }

  async function ensureImagePermissions(items) {
    if (!chrome.permissions) return;

    const origins = new Set();

    for (const item of items) {
      for (const value of [item.url, item.originalUrl]) {
        try {
          const url = new URL(value);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
          origins.add(`${url.protocol}//${url.hostname}/*`);
        } catch {
          // data URL 等无需站点权限
        }
      }
    }

    if (origins.size === 0) return;

    const checks = await Promise.all(
      Array.from(origins).map(async (origin) => ({
        origin,
        granted: await permissionsContains(origin)
      }))
    );

    const missing = checks
      .filter((check) => !check.granted)
      .map((check) => check.origin);

    if (missing.length === 0) return;

    const granted = await permissionsRequest(missing);
    if (!granted) {
      console.warn('[图片采集] 用户未授予部分图片域名的访问权限');
    }
  }

  function showToast(message, type = 'info', duration = 3500) {
    clearTimeout(state.toastTimer);

    els.toast.hidden = false;
    els.toast.dataset.type = type;
    els.toast.textContent = message;
    els.toast.classList.remove('is-visible');

    // 强制回流，确保连续提示也有过渡动画
    void els.toast.offsetWidth;
    els.toast.classList.add('is-visible');

    state.toastTimer = setTimeout(() => {
      els.toast.classList.remove('is-visible');
      state.toastTimer = setTimeout(() => {
        els.toast.hidden = true;
      }, 180);
    }, duration);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
