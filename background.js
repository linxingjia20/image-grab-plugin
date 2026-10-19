'use strict';

/**
 * 电商图片采集助手 - service worker
 * 负责：接收扫描结果 -> 持久化 -> 打开图库页
 */

const SCAN_PREFIX = 'scan:';
const MAX_SCANS = 6;
const MAX_IMAGES = 1000;
const MAX_SCAN_URL_BYTES = 1_200_000;
const MAX_URL_LENGTH = 4096;
const MAX_DATA_URL_LENGTH = 3 * 1024 * 1024;
const MAX_PAGE_TITLE_LENGTH = 300;

const ALLOWED_SITES = new Set(['taobao', 'jd', 'pdd', 'ecommerce']);
const ALLOWED_SOURCES = new Set(['image', 'background']);
const ALLOWED_ORIGINS = new Set(['img', 'lazy', 'poster', 'svg', 'css']);

function clampInt(value, min, max, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function truncateText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeUrl(value) {
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
    return url.href.length <= MAX_URL_LENGTH ? url.href : '';
  } catch {
    return '';
  }
}

function inferSite(pageUrl) {
  try {
    const host = new URL(pageUrl).hostname.toLowerCase();
    if (/(^|\.)(taobao|tmall)\.com$/.test(host)) return 'taobao';
    if (/(^|\.)jd\.(com|hk)$/.test(host)) return 'jd';
    if (/(^|\.)(pinduoduo|yangkeduo)\.com$/.test(host)) return 'pdd';
  } catch {
    // ignore
  }
  return 'ecommerce';
}

function sanitizeImage(raw, index) {
  if (!raw || typeof raw !== 'object') return null;

  const url = normalizeUrl(raw.url);
  if (!url) return null;

  const originalUrl = normalizeUrl(raw.originalUrl) || url;
  const source = ALLOWED_SOURCES.has(raw.source) ? raw.source : 'image';
  const origin = ALLOWED_ORIGINS.has(raw.origin) ? raw.origin : 'img';
  const id =
    typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 120
      ? raw.id
      : `img-${index + 1}`;

  return {
    id,
    url,
    originalUrl,
    width: clampInt(raw.width, 0, 100000, 0),
    height: clampInt(raw.height, 0, 100000, 0),
    source,
    origin,
    alt: truncateText(raw.alt, 300)
  };
}

function sanitizeStats(raw) {
  const stats = raw && typeof raw === 'object' ? raw : {};
  return {
    filtered: clampInt(stats.filtered, 0, 100000, 0),
    truncated: Boolean(stats.truncated)
  };
}

function createScanId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `s_${Date.now().toString(36)}_${crypto.randomUUID()}`;
  }
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function openGalleryTab(scanId) {
  const baseUrl = chrome.runtime.getURL('gallery.html');
  const url = scanId ? `${baseUrl}?scan=${encodeURIComponent(scanId)}` : baseUrl;
  return chrome.tabs.create({ url });
}

async function saveScan(scan) {
  const indexEntry = {
    id: scan.id,
    createdAt: scan.createdAt,
    count: scan.images.length,
    site: scan.site,
    pageTitle: scan.pageTitle,
    backgroundCount: scan.stats.backgroundCount
  };

  const stored = await chrome.storage.local.get('scanIndex');
  let index = Array.isArray(stored.scanIndex)
    ? stored.scanIndex.filter((item) => item && typeof item.id === 'string')
    : [];

  index = index.filter((item) => item.id !== scan.id);
  index.unshift(indexEntry);

  const removed = index.splice(MAX_SCANS);
  if (removed.length > 0) {
    await chrome.storage.local.remove(
      removed.map((item) => `${SCAN_PREFIX}${item.id}`)
    );
  }

  const payload = {
    [`${SCAN_PREFIX}${scan.id}`]: scan,
    latestScanId: scan.id,
    scanIndex: index
  };

  try {
    await chrome.storage.local.set(payload);
  } catch (error) {
    const message = String((error && error.message) || error);
    if (!/quota/i.test(message)) throw error;

    // 本地存储空间不足时，只保留最近两条记录再重试一次。
    const keep = index.slice(0, 2);
    const drop = index.slice(2);
    if (drop.length > 0) {
      await chrome.storage.local.remove(
        drop.map((item) => `${SCAN_PREFIX}${item.id}`)
      );
    }
    await chrome.storage.local.set({ ...payload, scanIndex: keep });
  }
}

async function handleOpenGallery(message, sender) {
  const rawImages = Array.isArray(message.images) ? message.images : [];
  if (rawImages.length === 0) {
    return { ok: false, error: '没有可展示的图片' };
  }

  const images = [];
  const seenUrls = new Set();
  const seenIds = new Set();
  const stats = sanitizeStats(message.stats);
  let urlBytes = 0;

  for (let index = 0; index < rawImages.length && images.length < MAX_IMAGES; index += 1) {
    const image = sanitizeImage(rawImages[index], index);
    if (!image || seenUrls.has(image.url)) continue;

    const imageBytes =
      image.url.length +
      (image.originalUrl !== image.url ? image.originalUrl.length : 0);
    if (urlBytes + imageBytes > MAX_SCAN_URL_BYTES) {
      stats.truncated = true;
      break;
    }

    let id = image.id;
    let suffix = 2;
    while (seenIds.has(id)) {
      id = `${image.id}-${suffix}`;
      suffix += 1;
    }

    seenUrls.add(image.url);
    seenIds.add(id);
    urlBytes += imageBytes;
    images.push({ ...image, id });
  }

  if (images.length === 0) {
    return { ok: false, error: '图片地址无效，请刷新页面后重试' };
  }

  const pageUrl = normalizeUrl(message.pageUrl) || normalizeUrl(sender?.tab?.url) || '';
  const site = ALLOWED_SITES.has(message.site) ? message.site : inferSite(pageUrl);
  const pageTitle =
    truncateText(message.pageTitle, MAX_PAGE_TITLE_LENGTH) ||
    truncateText(sender?.tab?.title, MAX_PAGE_TITLE_LENGTH) ||
    '商品详情页';

  stats.backgroundCount = images.filter((image) => image.source === 'background').length;
  const scan = {
    version: 1,
    id: createScanId(),
    createdAt: Date.now(),
    pageUrl,
    pageTitle,
    site,
    stats,
    images
  };

  await saveScan(scan);

  let tab;
  try {
    tab = await openGalleryTab(scan.id);
  } catch (error) {
    console.error('[电商图片采集] 打开图库失败：', error);
    return {
      ok: false,
      error: '扫描成功，但打开图库失败，请点击工具栏图标重试',
      scanId: scan.id,
      count: images.length
    };
  }

  return {
    ok: true,
    scanId: scan.id,
    tabId: tab?.id,
    count: images.length
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'ECOM_OPEN_GALLERY') return false;

  handleOpenGallery(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error('[电商图片采集] 保存扫描结果失败：', error);
      sendResponse({
        ok: false,
        error: '保存图片列表失败，请重试或减少页面图片数量'
      });
    });

  return true;
});

chrome.action.onClicked.addListener(async () => {
  try {
    const stored = await chrome.storage.local.get('latestScanId');
    const latestScanId =
      typeof stored.latestScanId === 'string' ? stored.latestScanId : '';
    await openGalleryTab(latestScanId);
  } catch (error) {
    console.error('[电商图片采集] 打开最近图库失败：', error);
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;
  try {
    const stored = await chrome.storage.local.get('scanIndex');
    if (!Array.isArray(stored.scanIndex)) {
      await chrome.storage.local.set({ scanIndex: [] });
    }
  } catch (error) {
    console.error('[电商图片采集] 初始化存储失败：', error);
  }
});
