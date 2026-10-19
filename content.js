'use strict';

(() => {
  if (window.__ECOM_IMAGE_PICKER_INSTALLED__) return;
  window.__ECOM_IMAGE_PICKER_INSTALLED__ = true;

  // 只处理顶层页面，避免商品页 iframe 内重复出现按钮。
  if (window.top !== window.self) return;

  const ROOT_ID = 'ecom-image-picker-host';
  const MIN_LONG_SIDE = 120;
  const MIN_SHORT_SIDE = 60;
  const MAX_IMAGES = 800;
  const MAX_SCROLL_STEPS = 36;
  const MAX_INNER_SCROLL_STEPS = 18;
  const SCROLL_DELAY = 130;
  const MAX_BACKGROUND_ELEMENTS = 20000;
  const MAX_DATA_URL_LENGTH = 2 * 1024 * 1024;
  const MAX_TOTAL_DATA_LENGTH = 1.5 * 1024 * 1024;

  const LAZY_SRC_ATTRIBUTES = [
    'data-original',
    'data-origin',
    'data-src',
    'data-lazy-src',
    'data-lazyload',
    'data-ks-lazyload',
    'data-lazy-img',
    'data-actualsrc',
    'data-echo',
    'data-url',
    'data-image',
    'data-img',
    'data-large',
    'data-large-src',
    'data-hi-res',
    'data-hi-res-src',
    'data-zoom-image',
    'data-big',
    'data-big-image',
    'data-original-src',
    'data-remote-src'
  ];

  const state = {
    mounted: false,
    scanning: false,
    root: null,
    shadow: null,
    fab: null,
    fabText: null,
    panel: null,
    panelTitle: null,
    panelDetail: null,
    progress: null,
    progressFill: null,
    closeButton: null,
    hideTimer: null,
    watchTimer: null,
    scanToken: 0
  };

  const STATIC_UI = `
    <div class="eip">
      <button class="eip-fab" type="button" aria-label="获取当前页面的图片">
        <span class="eip-fab-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4.5" width="18" height="15" rx="3"></rect>
            <circle cx="8.2" cy="9.2" r="1.25" fill="currentColor" stroke="none"></circle>
            <path d="M3.8 16.2l4.3-4.1a1.8 1.8 0 0 1 2.4 0l2.2 2.1"></path>
            <path d="M12.2 15.1l1.5-1.4a1.8 1.8 0 0 1 2.4 0l4.1 3.8"></path>
          </svg>
        </span>
        <span class="eip-fab-text">获取图片</span>
        <span class="eip-fab-spinner" aria-hidden="true"></span>
      </button>

      <section class="eip-panel" hidden role="status" aria-live="polite" aria-atomic="true">
        <div class="eip-panel-head">
          <span class="eip-state-dot" aria-hidden="true"></span>
          <strong class="eip-panel-title">正在扫描图片</strong>
          <button class="eip-panel-close" type="button" aria-label="关闭提示">×</button>
        </div>
        <div class="eip-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <span class="eip-progress-fill"></span>
        </div>
        <div class="eip-panel-detail">准备中…</div>
      </section>
    </div>
  `;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function detectSite() {
    const host = location.hostname.toLowerCase();
    if (/(^|\.)(taobao|tmall)\.com$/.test(host)) return 'taobao';
    if (/(^|\.)jd\.(com|hk)$/.test(host)) return 'jd';
    if (/(^|\.)(pinduoduo|yangkeduo)\.com$/.test(host)) return 'pdd';
    return 'ecommerce';
  }

  function isProductPage() {
    const site = detectSite();
    if (site === 'ecommerce') return false;

    const { hostname, pathname, search } = location;
    const params = new URLSearchParams(search);
    const idKeys = [
      'id',
      'goods_id',
      'goodsId',
      'item_id',
      'itemId',
      'product_id',
      'productId',
      'sku',
      'skuId',
      'wareId',
      'spu_id'
    ];
    const hasProductId = idKeys.some((key) => Boolean(params.get(key)));

    if (site === 'jd') {
      if (/\/\d+\.html$/i.test(pathname)) return true;
      if (/\/(?:product|item)\/\d+/i.test(pathname)) return true;
    }

    if (site === 'pdd') {
      if (/(?:goods|detail|product)/i.test(pathname)) return true;
    }

    if (site === 'taobao') {
      if (/\/item(?:\.htm|\/|$)/i.test(pathname)) return true;
      if (/^(?:detail|chaoshi\.detail)\.tmall\.com$/i.test(hostname)) return true;
      if (/\/detail(?:\.htm)?$/i.test(pathname)) return true;
    }

    if (hasProductId) return true;

    const ogType = document.querySelector('meta[property="og:type"]');
    return Boolean(ogType && /product/i.test(ogType.getAttribute('content') || ''));
  }

  function mount() {
    if (state.mounted || document.getElementById(ROOT_ID)) return;

    const host = document.createElement('div');
    host.id = ROOT_ID;
    host.style.cssText = [
      'position: fixed !important',
      'right: 22px !important',
      'bottom: calc(22px + env(safe-area-inset-bottom)) !important',
      'z-index: 2147483647 !important',
      'display: block !important',
      'width: max-content !important',
      'height: auto !important',
      'margin: 0 !important',
      'padding: 0 !important',
      'border: 0 !important',
      'background: transparent !important',
      'pointer-events: auto !important',
      'isolation: isolate !important',
      'opacity: 0 !important'
    ].join(';');

    const shadow = host.attachShadow({ mode: 'open' });
    let revealed = false;

    const reveal = () => {
      if (revealed) return;
      revealed = true;
      host.style.setProperty('opacity', '1', 'important');
    };

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.addEventListener('load', reveal);

    // 正常情况下 link 即可；极端情况下页面 CSP 拦截时再用 fetch 注入。
    link.addEventListener('error', () => {
      fetch(chrome.runtime.getURL('content.css'))
        .then((response) => {
          if (!response.ok) throw new Error('无法加载样式');
          return response.text();
        })
        .then((css) => {
          const style = document.createElement('style');
          style.textContent = css;
          shadow.appendChild(style);
          reveal();
        })
        .catch(() => {
          // 样式失败时按钮仍可点击，只是外观会退化。
          reveal();
        });
    });

    link.href = chrome.runtime.getURL('content.css');
    shadow.appendChild(link);
    window.setTimeout(reveal, 450);

    const wrapper = document.createElement('div');
    wrapper.innerHTML = STATIC_UI;
    shadow.appendChild(wrapper);

    state.root = host;
    state.shadow = shadow;
    state.fab = shadow.querySelector('.eip-fab');
    state.fabText = shadow.querySelector('.eip-fab-text');
    state.panel = shadow.querySelector('.eip-panel');
    state.panelTitle = shadow.querySelector('.eip-panel-title');
    state.panelDetail = shadow.querySelector('.eip-panel-detail');
    state.progress = shadow.querySelector('.eip-progress');
    state.progressFill = shadow.querySelector('.eip-progress-fill');
    state.closeButton = shadow.querySelector('.eip-panel-close');

    state.fab.addEventListener('click', handleScanClick);
    state.closeButton.addEventListener('click', hidePanel);

    document.documentElement.appendChild(host);
    state.mounted = true;
  }

  function unmount() {
    if (state.scanning) return;
    clearTimeout(state.hideTimer);
    state.hideTimer = null;
    state.scanToken += 1;
    if (state.root) state.root.remove();
    state.mounted = false;
    state.root = null;
    state.shadow = null;
    state.fab = null;
    state.fabText = null;
    state.panel = null;
    state.panelTitle = null;
    state.panelDetail = null;
    state.progress = null;
    state.progressFill = null;
    state.closeButton = null;
  }

  function watchRoute() {
    if (state.watchTimer) return;
    state.watchTimer = window.setInterval(() => {
      if (!document.documentElement) return;

      if (state.mounted && state.root && !state.root.isConnected) {
        state.mounted = false;
        state.root = null;
        state.shadow = null;
        state.fab = null;
      }

      const shouldMount = isProductPage();
      if (shouldMount && !state.mounted) {
        mount();
      } else if (!shouldMount && state.mounted && !state.scanning) {
        unmount();
      }
    }, 1500);
  }

  function setBusy(busy) {
    if (!state.fab) return;
    state.fab.disabled = busy;
    state.fab.classList.toggle('is-busy', busy);
    state.fab.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (state.fabText) {
      state.fabText.textContent = busy ? '扫描中…' : '获取图片';
    }
    if (state.closeButton) {
      state.closeButton.disabled = busy;
    }
  }

  function showPanel({ title, detail = '', progress = 0, tone = 'info', autoHide = 0 }) {
    if (!state.panel) return;

    clearTimeout(state.hideTimer);
    state.hideTimer = null;

    state.panel.hidden = false;
    state.panel.dataset.tone = tone;
    if (state.panelTitle) state.panelTitle.textContent = title;
    if (state.panelDetail) state.panelDetail.textContent = detail;

    const value = Math.max(0, Math.min(100, Math.round(progress)));
    if (state.progressFill) state.progressFill.style.width = `${value}%`;
    if (state.progress) state.progress.setAttribute('aria-valuenow', String(value));

    if (autoHide > 0) {
      state.hideTimer = window.setTimeout(hidePanel, autoHide);
    }
  }

  function hidePanel() {
    clearTimeout(state.hideTimer);
    state.hideTimer = null;
    if (state.panel) state.panel.hidden = true;
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
          } else {
            resolve(response);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function handleScanClick() {
    if (state.scanning || !state.mounted) return;

    const token = ++state.scanToken;
    state.scanning = true;
    setBusy(true);
    showPanel({
      title: '正在扫描页面图片',
      detail: '会自动滚动页面，触发懒加载图片…',
      progress: 4,
      tone: 'info'
    });

    try {
      const result = await scanPage((progress, detail) => {
        if (state.scanToken !== token) return;
        showPanel({
          title: '正在扫描页面图片',
          detail,
          progress,
          tone: 'info'
        });
      });

      if (state.scanToken !== token) return;

      if (result.images.length === 0) {
        showPanel({
          title: '没有找到可下载的图片',
          detail: '已过滤小图标和占位图，请确认当前页面已完整加载。',
          progress: 100,
          tone: 'warning',
          autoHide: 5000
        });
        return;
      }

      showPanel({
        title: `已找到 ${result.images.length} 张图片`,
        detail: '正在保存并打开图库…',
        progress: 98,
        tone: 'info'
      });

      const response = await sendMessage({
        type: 'ECOM_OPEN_GALLERY',
        images: result.images,
        stats: result.stats,
        pageUrl: location.href,
        pageTitle: document.title,
        site: detectSite()
      });

      if (!response || !response.ok) {
        throw new Error((response && response.error) || '保存图片列表失败');
      }

      showPanel({
        title: '采集完成',
        detail: `图库已在新标签页打开，共 ${response.count || result.images.length} 张图片。`,
        progress: 100,
        tone: 'success',
        autoHide: 3200
      });
    } catch (error) {
      console.error('[电商图片采集]', error);
      if (state.scanToken === token) {
        showPanel({
          title: '采集失败',
          detail:
            error && error.message
              ? error.message
              : '请刷新页面后重试，或检查扩展权限。',
          progress: 100,
          tone: 'error',
          autoHide: 6500
        });
      }
    } finally {
      state.scanning = false;
      setBusy(false);
    }
  }

  async function scanPage(onProgress) {
    const found = new Map();
    const stats = {
      filtered: 0,
      truncated: false,
      backgroundCount: 0,
      dataBytes: 0
    };
    const context = {
      smallNodes: new WeakSet()
    };

    const originalX = window.scrollX;
    const originalY = window.scrollY;
    const html = document.documentElement;
    const previousScrollBehavior = html.style.scrollBehavior;

    html.style.setProperty('scroll-behavior', 'auto', 'important');

    try {
      let y = 0;
      let step = 0;

      for (; step < MAX_SCROLL_STEPS; step += 1) {
        window.scrollTo(0, y);
        await sleep(step === 0 ? 100 : SCROLL_DELAY);
        collectImages(found, stats, context);

        const maxScroll = getMaxScroll();
        const ratio = maxScroll > 0 ? Math.min(1, y / maxScroll) : 1;
        onProgress(
          8 + Math.round(ratio * 72),
          `正在加载页面图片… ${Math.round(ratio * 100)}%`
        );

        if (y >= maxScroll) break;
        y = Math.min(maxScroll, y + Math.max(400, window.innerHeight * 0.85));
      }

      if (window.scrollY < getMaxScroll() - 10) {
        stats.truncated = true;
      }

      // 拼多多商家后台等布局可能使用内部滚动容器，窗口本身几乎不可滚动。
      if (getMaxScroll() < 200) {
        const scroller = findMainScrollContainer();
        if (scroller) {
          const originalTop = scroller.scrollTop;
          try {
            let innerY = 0;
            for (let innerStep = 0; innerStep < MAX_INNER_SCROLL_STEPS; innerStep += 1) {
              scroller.scrollTop = innerY;
              await sleep(110);
              collectImages(found, stats, context);

              const innerMax = Math.max(
                0,
                scroller.scrollHeight - scroller.clientHeight
              );
              const innerRatio = innerMax > 0 ? Math.min(1, innerY / innerMax) : 1;
              onProgress(
                76 + Math.round(innerRatio * 6),
                `正在加载详情区域图片… ${Math.round(innerRatio * 100)}%`
              );

              if (innerY >= innerMax) break;
              innerY = Math.min(
                innerMax,
                innerY + Math.max(300, scroller.clientHeight * 0.85)
              );
            }

            if (
              scroller.scrollTop <
              Math.max(0, scroller.scrollHeight - scroller.clientHeight) - 10
            ) {
              stats.truncated = true;
            }
          } finally {
            scroller.scrollTop = originalTop;
          }
        }
      }

      onProgress(83, '正在等待图片加载完成…');
      await waitForImages(1800);
      collectImages(found, stats, context);

      onProgress(90, '正在扫描 CSS 背景图…');
      await sleep(30);
      collectBackgrounds(found, stats, context);

      onProgress(97, '正在整理图片列表…');
      stats.backgroundCount = Array.from(found.values()).filter(
        (image) => image.source === 'background'
      ).length;

      return {
        images: Array.from(found.values()),
        stats
      };
    } finally {
      window.scrollTo(originalX, originalY);
      if (previousScrollBehavior) {
        html.style.setProperty('scroll-behavior', previousScrollBehavior);
      } else {
        html.style.removeProperty('scroll-behavior');
      }
    }
  }

  function getMaxScroll() {
    const doc = document.documentElement;
    const body = document.body;
    const height = Math.max(
      doc.scrollHeight,
      doc.offsetHeight,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0
    );
    return Math.max(0, height - window.innerHeight);
  }

  function findMainScrollContainer() {
    const minWidth = Math.max(360, window.innerWidth * 0.5);
    const elements = document.querySelectorAll('div, main, section, article');
    let best = null;
    let bestScore = 0;

    for (const element of elements) {
      if (element === document.body || element === document.documentElement) {
        continue;
      }
      if (element.clientHeight < 300 || element.clientWidth < minWidth) continue;

      const extra = element.scrollHeight - element.clientHeight;
      if (extra < 200) continue;

      const style = window.getComputedStyle(element);
      if (!/(auto|scroll)/i.test(style.overflowY)) continue;
      if (style.position === 'fixed' || style.display === 'none') continue;

      const score = extra * element.clientWidth;
      if (score > bestScore) {
        bestScore = score;
        best = element;
      }
    }

    return best;
  }

  function waitForImages(timeout) {
    const pending = Array.from(document.images).filter(
      (img) => !img.complete || (img.naturalWidth === 0 && Boolean(img.currentSrc))
    );
    if (pending.length === 0) return Promise.resolve();

    const waitAll = Promise.all(
      pending.map(
        (img) =>
          new Promise((resolve) => {
            if (img.complete) {
              resolve();
              return;
            }
            const done = () => {
              img.removeEventListener('load', done);
              img.removeEventListener('error', done);
              resolve();
            };
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
          })
      )
    );

    return Promise.race([waitAll, sleep(timeout)]);
  }

  function collectImages(map, stats, context) {
    for (const img of document.images) {
      if (!(img instanceof HTMLImageElement)) continue;
      const info = getImageInfo(img);
      if (info) addCandidate(map, stats, context, info);
    }

    for (const video of document.querySelectorAll('video[poster]')) {
      const poster = normalizeUrl(video.getAttribute('poster'));
      if (!poster) continue;
      const rect = video.getBoundingClientRect();
      addCandidate(map, stats, context, {
        url: upgradeImageUrl(poster),
        originalUrl: poster,
        width: Math.max(rect.width, video.videoWidth || 0),
        height: Math.max(rect.height, video.videoHeight || 0),
        source: 'image',
        origin: 'poster',
        alt: video.getAttribute('aria-label') || video.title || '',
        node: video
      });
    }

    for (const svgImage of document.querySelectorAll('svg image')) {
      const href =
        svgImage.getAttribute('href') ||
        svgImage.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      const source = normalizeUrl(href);
      if (!source) continue;
      const rect = svgImage.getBoundingClientRect();
      addCandidate(map, stats, context, {
        url: upgradeImageUrl(source),
        originalUrl: source,
        width: rect.width,
        height: rect.height,
        source: 'image',
        origin: 'svg',
        alt: svgImage.getAttribute('aria-label') || '',
        node: svgImage
      });
    }

    for (const input of document.querySelectorAll('input[type="image"][src]')) {
      const source = normalizeUrl(input.getAttribute('src'));
      if (!source) continue;
      const rect = input.getBoundingClientRect();
      addCandidate(map, stats, context, {
        url: upgradeImageUrl(source),
        originalUrl: source,
        width: Math.max(rect.width, parseDimension(input.getAttribute('width'))),
        height: Math.max(rect.height, parseDimension(input.getAttribute('height'))),
        source: 'image',
        origin: 'img',
        alt: input.getAttribute('alt') || '',
        node: input
      });
    }
  }

  function getImageInfo(img) {
    const picked = pickImageSource(img);
    if (!picked) return null;

    const rect = img.getBoundingClientRect();
    const width = Math.max(
      img.naturalWidth || 0,
      parseDimension(img.getAttribute('width')),
      rect.width || 0
    );
    const height = Math.max(
      img.naturalHeight || 0,
      parseDimension(img.getAttribute('height')),
      rect.height || 0
    );

    return {
      url: upgradeImageUrl(picked.url),
      originalUrl: picked.url,
      width,
      height,
      source: 'image',
      origin: picked.origin,
      alt: img.alt || img.getAttribute('aria-label') || img.title || '',
      node: img
    };
  }

  function pickImageSource(img) {
    const candidates = [];

    const add = (raw, score, origin) => {
      const normalized = normalizeUrl(raw);
      if (!normalized) return;

      let adjusted = score;
      if (isKnownPlaceholder(normalized)) adjusted -= 300;
      if (/^data:/i.test(normalized)) {
        adjusted -= 15;
        if (img.naturalWidth <= 2 && img.naturalHeight <= 2) adjusted -= 100;
      }
      if (img.naturalWidth >= MIN_LONG_SIDE && img.naturalHeight >= MIN_SHORT_SIDE) {
        adjusted += 5;
      } else if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        // 当前显示的是缩略图时，降低 currentSrc 的优先级，优先尝试 data-* 中的原图。
        if (origin === 'img') adjusted -= 55;
      }

      candidates.push({ url: normalized, score: adjusted, origin });
    };

    const currentScore =
      img.complete && img.naturalWidth > 0 ? 140 : 110;
    add(img.currentSrc, currentScore, 'img');

    const srcset = img.getAttribute('srcset');
    if (srcset) add(bestFromSrcset(srcset), 108, 'img');

    for (const name of LAZY_SRC_ATTRIBUTES) {
      add(img.getAttribute(name), 120, 'lazy');
    }

    const dataSrcset = img.getAttribute('data-srcset');
    if (dataSrcset) add(bestFromSrcset(dataSrcset), 114, 'lazy');

    add(img.getAttribute('src'), 90, 'img');

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  function bestFromSrcset(srcset) {
    if (!srcset || /^data:/i.test(srcset.trim())) return null;

    let best = null;
    let bestScore = -1;

    for (const part of srcset.split(',')) {
      const item = part.trim();
      if (!item) continue;

      const match = item.match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)(w|x))?$/i);
      if (!match) continue;

      const descriptor = match[2] ? Number(match[2]) : 0;
      const unit = (match[3] || '').toLowerCase();
      const score = unit === 'w' ? descriptor : unit === 'x' ? descriptor * 1000 : 1;

      if (score > bestScore) {
        bestScore = score;
        best = match[1];
      }
    }

    return best;
  }

  function collectBackgrounds(map, stats, context) {
    const elements = document.querySelectorAll('*');
    let scanned = 0;

    for (const element of elements) {
      scanned += 1;
      if (scanned > MAX_BACKGROUND_ELEMENTS) {
        stats.truncated = true;
        break;
      }
      if (element === state.root || element.id === ROOT_ID) continue;

      const tag = element.tagName;
      if (
        tag === 'SCRIPT' ||
        tag === 'STYLE' ||
        tag === 'LINK' ||
        tag === 'META' ||
        tag === 'NOSCRIPT' ||
        tag === 'TEMPLATE' ||
        tag === 'HEAD' ||
        tag === 'TITLE'
      ) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) continue;

      const style = window.getComputedStyle(element);
      if (!style || !style.backgroundImage || style.backgroundImage === 'none') continue;
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (Number(style.opacity) === 0) continue;

      const urls = extractCssUrls(style.backgroundImage);
      if (urls.length === 0) continue;

      const dimensions = getBackgroundDimensions(style, rect);
      const alt =
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        '';

      for (const raw of urls) {
        const source = normalizeUrl(raw);
        if (!source) continue;
        addCandidate(map, stats, context, {
          url: upgradeImageUrl(source),
          originalUrl: source,
          width: dimensions.width,
          height: dimensions.height,
          source: 'background',
          origin: 'css',
          alt,
          node: element
        });
      }
    }
  }

  function getBackgroundDimensions(style, rect) {
    const size = (style.backgroundSize || '').trim();
    if (!size || size === 'auto' || size === 'cover' || size === 'contain') {
      return { width: rect.width, height: rect.height };
    }

    const parts = size.split(/\s+/);
    const width = parseCssLength(parts[0]);
    const height = parseCssLength(parts[1] || parts[0]);

    if (width <= 0 && height <= 0) {
      return { width: rect.width, height: rect.height };
    }

    return {
      width: width > 0 ? Math.min(rect.width, width) : rect.width,
      height: height > 0 ? Math.min(rect.height, height) : rect.height
    };
  }

  function parseCssLength(value) {
    const match = String(value || '')
      .trim()
      .match(/^(\d+(?:\.\d+)?)px$/i);
    return match ? Number(match[1]) : 0;
  }

  function extractCssUrls(value) {
    const urls = [];
    const regex = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
    let match;

    while ((match = regex.exec(value)) !== null) {
      const url = (match[1] || match[2] || match[3] || '').trim();
      if (url) urls.push(url);
    }

    return urls;
  }

  function addCandidate(map, stats, context, candidate) {
    const url = normalizeUrl(candidate.url);
    if (!url) return;

    const originalUrl = normalizeUrl(candidate.originalUrl) || url;
    const width = Math.max(0, Math.round(Number(candidate.width) || 0));
    const height = Math.max(0, Math.round(Number(candidate.height) || 0));
    const isDataUrl = /^data:/i.test(url);

    if (isDataUrl && url.length > MAX_DATA_URL_LENGTH) {
      countFiltered(stats, context, candidate.node);
      return;
    }

    if (isTooSmall(width, height, url)) {
      countFiltered(stats, context, candidate.node);
      return;
    }

    const key = canonicalKey(url);
    const existing = map.get(key);

    if (existing) {
      existing.width = Math.max(existing.width, width);
      existing.height = Math.max(existing.height, height);
      if (!existing.alt && candidate.alt) {
        existing.alt = String(candidate.alt).slice(0, 300);
      }
      if (existing.source === 'background' && candidate.source !== 'background') {
        existing.source = 'image';
        existing.origin = candidate.origin || 'img';
        existing.url = url;
        existing.originalUrl = originalUrl;
      }
      return;
    }

    if (map.size >= MAX_IMAGES) {
      stats.truncated = true;
      return;
    }

    if (isDataUrl) {
      if (stats.dataBytes + url.length > MAX_TOTAL_DATA_LENGTH) {
        stats.truncated = true;
        countFiltered(stats, context, candidate.node);
        return;
      }
      stats.dataBytes += url.length;
    }

    map.set(key, {
      id: `img-${map.size + 1}`,
      url,
      originalUrl,
      width,
      height,
      source: candidate.source === 'background' ? 'background' : 'image',
      origin: candidate.origin || 'img',
      alt: candidate.alt ? String(candidate.alt).slice(0, 300) : ''
    });
  }

  function countFiltered(stats, context, node) {
    if (node && context && context.smallNodes.has(node)) return;
    if (node && context) context.smallNodes.add(node);
    stats.filtered += 1;
  }

  function isTooSmall(width, height, url) {
    const knownWidth = width > 0;
    const knownHeight = height > 0;

    if (knownWidth && knownHeight) {
      return (
        Math.max(width, height) < MIN_LONG_SIDE ||
        Math.min(width, height) < MIN_SHORT_SIDE
      );
    }

    if (knownWidth || knownHeight) {
      return (knownWidth ? width : height) < MIN_LONG_SIDE;
    }

    if (/^data:/i.test(url)) return true;
    if (/\.svg(?:[?#]|$)/i.test(url)) return true;
    return isLikelyTinyUrl(url);
  }

  function isLikelyTinyUrl(url) {
    return /(?:^|[/_.-])(?:1x1|spacer|blank|pixel|transparent)(?:[/_.-]|$)/i.test(url);
  }

  function isKnownPlaceholder(url) {
    if (/^data:image\/gif;base64,R0lGODlhAQAB/i.test(url)) return true;
    return /(?:^|[/_.-])(?:1x1|spacer|blank|pixel|transparent)\.(?:gif|png)(?:[?#]|$)/i.test(
      url
    );
  }

  function canonicalKey(url) {
    if (/^data:/i.test(url)) {
      return `data:${url.length}:${url.slice(-180)}`;
    }
    return url;
  }

  function normalizeUrl(raw) {
    if (typeof raw !== 'string') return null;

    let value = raw.trim();
    if (!value) return null;
    value = value.replace(/^['"]+|['"]+$/g, '').trim();
    if (!value || value === 'none' || value.startsWith('#')) return null;

    if (/^data:image\//i.test(value)) {
      return value.length <= MAX_DATA_URL_LENGTH ? value : null;
    }

    try {
      const url = new URL(value, location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  }

  function upgradeImageUrl(original) {
    if (/^data:/i.test(original)) return original;

    try {
      const url = new URL(original);
      url.protocol = 'https:';
      url.hash = '';

      const host = url.hostname.toLowerCase();

      if (/(^|\.)(?:alicdn|taobaocdn)\.com$|(^|\.)tbcdn\.cn$/.test(host)) {
        for (let index = 0; index < 4; index += 1) {
          const before = url.pathname;
          url.pathname = url.pathname
            .replace(/_\.(?:webp|avif)$/i, '')
            .replace(/_\d+x\d+(?:q\d+)?\.(?:jpe?g|png|webp|gif|avif)$/i, '')
            .replace(/_q\d+\.(?:jpe?g|png|webp|gif|avif)$/i, '');
          if (url.pathname === before) break;
        }
      } else if (/(^|\.)360buyimg\.com$/.test(host)) {
        url.pathname = url.pathname
          .replace(/\/(?:n\d+|s\d+x\d+_[a-z0-9]+)\/jfs\//i, '/n0/jfs/')
          .replace(/\/s\d+x\d+_[a-z0-9]+\//i, '/n0/jfs/');
      } else if (/(^|\.)(?:pddpic|yangkeduo)\.com$/.test(host)) {
        for (const key of Array.from(url.searchParams.keys())) {
          if (/^(?:imageView2|imageMogr2|image_process)\b/i.test(key)) {
            url.searchParams.delete(key);
          }
        }
      }

      return url.href;
    } catch {
      return original;
    }
  }

  function parseDimension(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value !== 'string') return 0;
    const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
    return match ? Number(match[1]) : 0;
  }

  function init() {
    if (isProductPage()) mount();
    watchRoute();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
