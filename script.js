let channels = [];
let activeCategoryList = [];
let currentChannelIndex = 0;
let skipTimer = null;
let searchTimeout = null;

let hlsPlayer = null;
let plyrInstance = null;

let userVolume = 1;
let isUserMuted = false;

let brokenUrls = new Set(JSON.parse(localStorage.getItem('streamflix_offline_urls') || '[]'));
let scannerLoopActive = false;
let currentScanIndex = parseInt(localStorage.getItem('streamflix_scan_index') || '0', 10);

const RENDER_CHUNK_SIZE = 100;
let renderedCount = 0;

const isMobileDevice = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const DEFAULT_PLAYLIST_URL = "https://iptv-org.github.io/iptv/index.m3u";

const DEFAULT_FALLBACK_CHANNEL = {
  name: "ABC News Live",
  category: "News",
  language: "English",
  url: "https://content.uplynk.com/channel/3324f2467c414329b3b0cc5838d41a37.m3u8"
};

const ISO_LANGUAGES = {
  eng: "English", en: "English",
  spa: "Spanish", es: "Spanish",
  fra: "French", fr: "French",
  deu: "German", de: "German",
  ita: "Italian", it: "Italian",
  por: "Portuguese", pt: "Portuguese",
  rus: "Russian", ru: "Russian",
  zho: "Chinese", zh: "Chinese",
  ara: "Arabic", ar: "Arabic",
  hin: "Hindi", hi: "Hindi",
  jpn: "Japanese", ja: "Japanese",
  kor: "Korean", ko: "Korean",
  tur: "Turkish", tr: "Turkish"
};

// DOM Elements
const brandLogo = document.getElementById('brandLogo');
const playlistSelect = document.getElementById('playlistSelect');
const categoryFilter = document.getElementById('categoryFilter');
const m3uUrlInput = document.getElementById('m3uUrlInput');
const loadBtn = document.getElementById('loadBtn');
const channelListEl = document.getElementById('channelList');
const searchInput = document.getElementById('channelSearch');
const videoPlayer = document.getElementById('videoPlayer');
const statusBar = document.getElementById('statusBar');
const currentChannelName = document.getElementById('currentChannelName');
const prevBtn = document.getElementById('prevBtn');
const stopBtn = document.getElementById('stopBtn');
const nextBtn = document.getElementById('nextBtn');
const channelCountEl = document.getElementById('channelCount');

/* PERSISTENCE HELPERS */
function saveOfflineChannels() {
  localStorage.setItem('streamflix_offline_urls', JSON.stringify([...brokenUrls]));
}

function saveScanProgress(index) {
  localStorage.setItem('streamflix_scan_index', index.toString());
}

/* INITIALIZATION */
document.addEventListener('DOMContentLoaded', () => {
  plyrInstance = new Plyr(videoPlayer, {
    controls: ['play-large', 'play', 'mute', 'volume', 'current-time', 'settings', 'pip', 'fullscreen'],
    autoplay: true
  });

  plyrInstance.on('volumechange', () => {
    userVolume = plyrInstance.volume;
    isUserMuted = plyrInstance.muted;
    videoPlayer.volume = userVolume;
    videoPlayer.muted = isUserMuted;
  });

  channelListEl.addEventListener('scroll', () => {
    if (channelListEl.scrollTop + channelListEl.clientHeight >= channelListEl.scrollHeight - 200) {
      appendMoreChannels();
    }
  });

  categoryFilter.addEventListener('change', filterChannels);
  playlistSelect.value = DEFAULT_PLAYLIST_URL;
  autoInitializeApp();
});

async function autoInitializeApp() {
  statusBar.textContent = 'Loading channel directory...';
  fetchAndParsePlaylist(playlistSelect.value);
}

/* BACKGROUND SCANNER */
function startBackgroundScanner() {
  if (!scannerLoopActive && channels.length > 0) {
    scannerLoopActive = true;
    continuousScannerLoop();
  }
}

async function continuousScannerLoop() {
  const BATCH_SIZE = 10;
  const BATCH_DELAY_MS = 300;
  const CYCLE_REST_MS = 5000;

  while (scannerLoopActive) {
    if (channels.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }

    if (currentScanIndex >= channels.length) {
      currentScanIndex = 0;
      saveScanProgress(0);
      await new Promise(resolve => setTimeout(resolve, CYCLE_REST_MS));
      continue;
    }

    const batch = channels.slice(currentScanIndex, currentScanIndex + BATCH_SIZE);

    if (batch.length > 0) {
      await Promise.all(batch.map(async (channel) => {
        const isOnline = await checkStreamHealth(channel.url);
        if (!isOnline && !brokenUrls.has(channel.url)) {
          brokenUrls.add(channel.url);
          saveOfflineChannels();
          throttledFilterChannels(); 
        } else if (isOnline && brokenUrls.has(channel.url)) {
          brokenUrls.delete(channel.url);
          saveOfflineChannels();
          throttledFilterChannels();
        }
      }));

      currentScanIndex += batch.length;
      saveScanProgress(currentScanIndex);
    }

    await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
  }
}

let renderThrottleTimeout = null;
function throttledFilterChannels() {
  if (renderThrottleTimeout) return;
  renderThrottleTimeout = setTimeout(() => {
    filterChannels();
    renderThrottleTimeout = null;
  }, 500);
}

function checkStreamHealth(url) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, 2500);

    fetch(url, { method: 'HEAD', mode: 'no-cors', signal: controller.signal })
      .then(() => { clearTimeout(timeoutId); resolve(true); })
      .catch(() => { clearTimeout(timeoutId); resolve(false); });
  });
}

/* PLAYLIST & CATEGORY MANAGEMENT */
brandLogo.addEventListener('click', goHome);

function goHome() {
  if (skipTimer) clearTimeout(skipTimer);
  searchInput.value = '';
  m3uUrlInput.value = '';
  categoryFilter.value = 'ALL';
  playlistSelect.value = DEFAULT_PLAYLIST_URL;
  fetchAndParsePlaylist(DEFAULT_PLAYLIST_URL);
}

playlistSelect.addEventListener('change', () => {
  m3uUrlInput.value = '';
  currentScanIndex = 0;
  saveScanProgress(0);
  fetchAndParsePlaylist(playlistSelect.value);
});

loadBtn.addEventListener('click', () => {
  const customUrl = m3uUrlInput.value.trim();
  currentScanIndex = 0;
  saveScanProgress(0);
  fetchAndParsePlaylist(customUrl || playlistSelect.value);
});

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(filterChannels, 150);
});

prevBtn.addEventListener('click', () => navigateCategoryChannel(-1));
nextBtn.addEventListener('click', () => navigateCategoryChannel(1));

stopBtn.addEventListener('click', () => {
  if (skipTimer) clearTimeout(skipTimer);
  videoPlayer.pause();
  statusBar.textContent = 'Auto-skip halted';
});

function navigateCategoryChannel(direction) {
  if (activeCategoryList.length === 0) return;
  if (skipTimer) clearTimeout(skipTimer);

  currentChannelIndex += direction;
  if (currentChannelIndex >= activeCategoryList.length) currentChannelIndex = 0;
  if (currentChannelIndex < 0) currentChannelIndex = activeCategoryList.length - 1;

  const nextChannel = activeCategoryList[currentChannelIndex];
  while (renderedCount <= currentChannelIndex && renderedCount < activeCategoryList.length) {
    appendMoreChannels();
  }

  const targetElement = channelListEl.children[currentChannelIndex];
  playChannel(nextChannel, targetElement, currentChannelIndex, true);
}

async function fetchAndParsePlaylist(url) {
  statusBar.textContent = 'Loading directory...';
  channelListEl.innerHTML = '<li style="padding: 20px; color: #9ca3af; text-align: center;">Syncing stream directory...</li>';

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Network error');
    const m3uText = await response.text();
    
    setTimeout(() => {
      const urlLang = detectLanguageFromUrl(url);
      channels = fastM3UParse(m3uText, urlLang);

      if (channels.length === 0) channels = [DEFAULT_FALLBACK_CHANNEL];

      populateCategoryFilter();
      filterChannels();

      const firstChannel = activeCategoryList[0] || channels[0];
      playChannel(firstChannel, channelListEl.children[0], 0, false);
      startBackgroundScanner();
    }, 20);

  } catch (error) {
    channels = [DEFAULT_FALLBACK_CHANNEL];
    populateCategoryFilter();
    filterChannels();
    playChannel(DEFAULT_FALLBACK_CHANNEL, channelListEl.children[0], 0, false);
    statusBar.textContent = 'Loaded fallback channel';
  }
}

function populateCategoryFilter() {
  const categories = new Set();
  channels.forEach(c => categories.add(c.category || 'General'));

  const sorted = Array.from(categories).sort();
  categoryFilter.innerHTML = '<option value="ALL">All Categories</option>';

  sorted.forEach(cat => {
    const option = document.createElement('option');
    option.value = cat;
    option.textContent = cat;
    categoryFilter.appendChild(option);
  });
}

function detectLanguageFromUrl(url) {
  const match = url.match(/languages\/([a-z]{2,3})\.m3u/i);
  return (match && ISO_LANGUAGES[match[1].toLowerCase()]) ? ISO_LANGUAGES[match[1].toLowerCase()] : null;
}

function fastM3UParse(m3uData, defaultLanguage = null) {
  const result = [];
  const lines = m3uData.split('\n');
  let name = '', category = 'General', language = defaultLanguage || 'Global';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXTINF:')) {
      const groupMatch = line.match(/group-title="([^"]+)"/i);
      category = groupMatch ? groupMatch[1] : 'General';

      const langMatch = line.match(/tvg-language="([^"]+)"/i) || line.match(/language="([^"]+)"/i);
      language = langMatch ? (ISO_LANGUAGES[langMatch[1].toLowerCase()] || capitalize(langMatch[1])) : (defaultLanguage || 'Global');

      const commaIdx = line.indexOf(',');
      name = commaIdx !== -1 ? line.substring(commaIdx + 1) : 'Live Broadcast';
    } else if (line.length > 0 && !line.startsWith('#')) {
      if (name) {
        result.push({ name: name.trim(), category: category.trim(), language: language.trim(), url: line });
        name = '';
      }
    }
  }
  return result;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function filterChannels() {
  const query = searchInput.value.trim().toLowerCase();
  const selectedCategory = categoryFilter.value;
  
  let pool = channels.filter(c => !brokenUrls.has(c.url));

  if (selectedCategory !== 'ALL') {
    pool = pool.filter(c => c.category === selectedCategory);
  }

  if (query) {
    pool = pool.filter(c => 
      c.name.toLowerCase().includes(query) || 
      c.category.toLowerCase().includes(query) ||
      c.language.toLowerCase().includes(query)
    );
  }

  activeCategoryList = pool;
  renderedCount = 0;
  channelListEl.innerHTML = '';
  
  if (channelCountEl) {
    channelCountEl.textContent = `Channels: ${activeCategoryList.length.toLocaleString()}` + 
      (brokenUrls.size > 0 ? ` (${brokenUrls.size} offline hidden)` : '');
  }

  if (activeCategoryList.length === 0) {
    channelListEl.innerHTML = '<li style="padding: 20px; color: #9ca3af; text-align: center;">No matching streams found</li>';
    return;
  }

  appendMoreChannels();
}

function appendMoreChannels() {
  if (renderedCount >= activeCategoryList.length) return;

  const fragment = document.createDocumentFragment();
  const nextChunkLimit = Math.min(renderedCount + RENDER_CHUNK_SIZE, activeCategoryList.length);

  for (let i = renderedCount; i < nextChunkLimit; i++) {
    const channel = activeCategoryList[i];
    const li = document.createElement('li');
    li.className = 'channel-item';
    li.innerHTML = `
      <span class="channel-name">${channel.name}</span>
      <div class="channel-meta">
        <span class="channel-category">${channel.category}</span>
        <span class="channel-language">${channel.language}</span>
      </div>
    `;

    const idx = i;
    li.addEventListener('click', () => playChannel(channel, li, idx, true));
    fragment.appendChild(li);
  }

  channelListEl.appendChild(fragment);
  renderedCount = nextChunkLimit;
}

/* MEDIA PLAYER EXECUTION */
function playChannel(channel, element, categoryIndex, isUserClicked = true) {
  if (skipTimer) clearTimeout(skipTimer);
  currentChannelIndex = categoryIndex;

  const prevActive = channelListEl.querySelector('.active');
  if (prevActive) prevActive.classList.remove('active');
  if (element) {
    element.classList.add('active');
    element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  currentChannelName.innerHTML = `${channel.name} <span class="header-lang-tag">${channel.language}</span>`;
  statusBar.textContent = 'Connecting...';

  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }

  if (Hls.isSupported()) {
    hlsPlayer = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      manifestLoadingTimeOut: 4000,
      fragLoadingTimeOut: 5000
    });
    
    hlsPlayer.loadSource(channel.url);
    hlsPlayer.attachMedia(videoPlayer);

    hlsPlayer.on(Hls.Events.MANIFEST_PARSED, function() {
      videoPlayer.play().then(() => {
        statusBar.textContent = 'Broadcasting';
      }).catch(() => {
        videoPlayer.muted = true;
        videoPlayer.play();
        statusBar.textContent = 'Broadcasting (Muted)';
      });
    });

    hlsPlayer.on(Hls.Events.ERROR, function(event, data) {
      if (data.fatal) {
        statusBar.textContent = 'Stream error. Skipping...';
        skipTimer = setTimeout(() => navigateCategoryChannel(1), 1200);
      }
    });

  } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
    videoPlayer.src = channel.url;
    videoPlayer.play().then(() => {
      statusBar.textContent = 'Broadcasting';
    });
  }
}
