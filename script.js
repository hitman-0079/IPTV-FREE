let channels = [];
let activeCategoryList = [];
let currentChannelIndex = 0;
let skipTimer = null;
let searchTimeout = null;

let hlsPlayer = null;
let plyrInstance = null;

// Audio Volume States
let userVolume = 1;
let isUserMuted = false;

// Continuous 24/7 Background Channel Scanner State
let brokenUrls = new Set();
let scannedUrls = new Set();
let scannerLoopActive = false;
let scanQueue = [];

const RENDER_CHUNK_SIZE = 100;
let renderedCount = 0;

const isMobileDevice = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const DEFAULT_PLAYLIST_URL = "https://iptv-org.github.io/iptv/index.m3u";

// Fallback Stream
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

/* ========================================================= */
/* AUTOMATIC INIT ON DOM LOAD                                */
/* ========================================================= */

document.addEventListener('DOMContentLoaded', () => {
  plyrInstance = new Plyr(videoPlayer, {
    controls: ['play-large', 'play', 'mute', 'volume', 'current-time', 'settings', 'pip', 'fullscreen'],
    autoplay: true,
    quality: {
      default: -1,
      options: [-1],
      forced: true,
      onChange: (q) => { if (hlsPlayer) hlsPlayer.currentLevel = q; }
    }
  });

  plyrInstance.on('volumechange', () => {
    userVolume = plyrInstance.volume;
    isUserMuted = plyrInstance.muted;
    videoPlayer.volume = userVolume;
    videoPlayer.muted = isUserMuted;
  });

  // Automatically switch screen orientation to landscape on fullscreen
  plyrInstance.on('enterfullscreen', () => {
    autoLockOrientation('landscape');
  });

  plyrInstance.on('exitfullscreen', () => {
    autoUnlockOrientation();
  });

  channelListEl.addEventListener('scroll', () => {
    if (channelListEl.scrollTop + channelListEl.clientHeight >= channelListEl.scrollHeight - 200) {
      appendMoreChannels();
    }
  });

  playlistSelect.value = DEFAULT_PLAYLIST_URL;
  autoInitializeApp();
});

// Fallback listener for native browser fullscreen changes
document.addEventListener('fullscreenchange', handleNativeFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleNativeFullscreenChange);

function handleNativeFullscreenChange() {
  const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (isFullscreen) {
    autoLockOrientation('landscape');
  } else {
    autoUnlockOrientation();
  }
}

async function autoLockOrientation(orientationType) {
  if (isMobileDevice && screen.orientation && typeof screen.orientation.lock === 'function') {
    try {
      await screen.orientation.lock(orientationType);
    } catch (err) {
      console.warn("Screen orientation lock prevented:", err);
    }
  }
}

function autoUnlockOrientation() {
  if (screen.orientation && typeof screen.orientation.unlock === 'function') {
    try {
      screen.orientation.unlock();
    } catch (err) {
      // Ignore unlock exceptions
    }
  }
}

async function autoInitializeApp() {
  statusBar.textContent = 'Loading channel directory...';
  fetchAndParsePlaylist(playlistSelect.value);
}

/* ========================================================= */
/* CONTINUOUS 24/7 BACKGROUND SCANNER                        */
/* ========================================================= */

function startBackgroundScanner() {
  scanQueue = [...channels];
  
  if (!scannerLoopActive) {
    scannerLoopActive = true;
    continuousScannerLoop();
  }
}

async function continuousScannerLoop() {
  const BATCH_SIZE = 15;        // Concurrent stream checks per batch
  const BATCH_DELAY_MS = 200;   // Delay between batches to keep UI silky smooth (0.2s)
  const CYCLE_REST_MS = 10000;  // Rest delay when 100% of channels have been checked (10s)

  while (scannerLoopActive) {
    // When finished testing all channels, pause 10s and restart the verification cycle
    if (scanQueue.length === 0) {
      scannedUrls.clear(); 
      scanQueue = [...channels];
      await new Promise(resolve => setTimeout(resolve, CYCLE_REST_MS));
      continue;
    }

    const batch = [];
    while (batch.length < BATCH_SIZE && scanQueue.length > 0) {
      const channel = scanQueue.shift();
      if (!scannedUrls.has(channel.url)) {
        scannedUrls.add(channel.url);
        batch.push(channel);
      }
    }

    if (batch.length > 0) {
      await Promise.all(batch.map(async (channel) => {
        const isOnline = await checkStreamHealth(channel.url);
        
        // Hide channel if offline
        if (!isOnline && !brokenUrls.has(channel.url)) {
          brokenUrls.add(channel.url);
          throttledFilterChannels(); 
        } 
        // Re-enable channel if it comes back online
        else if (isOnline && brokenUrls.has(channel.url)) {
          brokenUrls.delete(channel.url);
          throttledFilterChannels();
        }
      }));
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

    fetch(url, { 
      method: 'HEAD', 
      mode: 'no-cors',
      signal: controller.signal 
    })
      .then(() => {
        clearTimeout(timeoutId);
        resolve(true);
      })
      .catch(() => {
        clearTimeout(timeoutId);
        resolve(false);
      });
  });
}

/* ========================================================= */
/* M3U HANDLING & PLAYLIST CONTROLS                          */
/* ========================================================= */

brandLogo.addEventListener('click', goHome);
brandLogo.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    goHome();
  }
});

function goHome() {
  if (skipTimer) {
    clearTimeout(skipTimer);
    skipTimer = null;
  }
  
  searchInput.value = '';
  m3uUrlInput.value = '';
  playlistSelect.value = DEFAULT_PLAYLIST_URL;

  window.scrollTo({ top: 0, behavior: 'smooth' });
  fetchAndParsePlaylist(DEFAULT_PLAYLIST_URL);
}

playlistSelect.addEventListener('change', () => {
  m3uUrlInput.value = '';
  fetchAndParsePlaylist(playlistSelect.value);
});

loadBtn.addEventListener('click', () => {
  const customUrl = m3uUrlInput.value.trim();
  fetchAndParsePlaylist(customUrl || playlistSelect.value);
});

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(filterChannels, 150);
});

prevBtn.addEventListener('click', () => navigateCategoryChannel(-1));
nextBtn.addEventListener('click', () => navigateCategoryChannel(1));

stopBtn.addEventListener('click', () => {
  if (skipTimer) {
    clearTimeout(skipTimer);
    skipTimer = null;
  }
  videoPlayer.pause();
  statusBar.textContent = 'Auto-skip stopped';
});

function navigateCategoryChannel(direction) {
  if (activeCategoryList.length === 0) return;
  if (skipTimer) {
    clearTimeout(skipTimer);
    skipTimer = null;
  }

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
  brokenUrls.clear();
  scannedUrls.clear();

  statusBar.textContent = 'Auto-fetching live channels...';
  channelListEl.innerHTML = '<li style="padding: 20px; color: #6b7280; text-align: center; font-size: 0.85rem;">Syncing full channel list...</li>';

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Network error');
    const m3uText = await response.text();
    
    statusBar.textContent = 'Parsing directory...';
    
    setTimeout(() => {
      const urlLang = detectLanguageFromUrl(url);
      const parsedChannels = fastM3UParse(m3uText, urlLang);

      if (parsedChannels.length > 0) {
        channels = parsedChannels;
      } else {
        channels = [DEFAULT_FALLBACK_CHANNEL];
      }

      filterChannels();
      statusBar.textContent = `${channels.length.toLocaleString()} channels loaded`;

      const firstChannel = activeCategoryList[0] || channels[0];
      const firstElement = channelListEl.children[0];
      playChannel(firstChannel, firstElement, 0, false);

      startBackgroundScanner();

    }, 20);

  } catch (error) {
    channels = [DEFAULT_FALLBACK_CHANNEL];
    filterChannels();
    playChannel(DEFAULT_FALLBACK_CHANNEL, channelListEl.children[0], 0, false);
    statusBar.textContent = 'Fallback stream loaded';
  }
}

function detectLanguageFromUrl(url) {
  const match = url.match(/languages\/([a-z]{2,3})\.m3u/i);
  if (match && ISO_LANGUAGES[match[1].toLowerCase()]) {
    return ISO_LANGUAGES[match[1].toLowerCase()];
  }
  return null;
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
      if (langMatch) {
        const rawLang = langMatch[1].toLowerCase();
        language = ISO_LANGUAGES[rawLang] || capitalize(rawLang);
      } else if (defaultLanguage) {
        language = defaultLanguage;
      } else {
        language = 'Global';
      }

      const commaIdx = line.indexOf(',');
      name = commaIdx !== -1 ? line.substring(commaIdx + 1) : 'Unknown Broadcast';
    } else if (line.length > 0 && !line.startsWith('#')) {
      if (name) {
        result.push({
          name: name.trim(),
          category: category.trim(),
          language: language.trim(),
          url: line
        });
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
  
  let pool = channels.filter(c => !brokenUrls.has(c.url));

  if (!query) {
    activeCategoryList = pool;
  } else {
    activeCategoryList = pool.filter(c => 
      c.name.toLowerCase().includes(query) || 
      c.category.toLowerCase().includes(query) ||
      c.language.toLowerCase().includes(query)
    );
  }

  renderedCount = 0;
  channelListEl.innerHTML = '';
  
  if (channelCountEl) {
    const hiddenCount = brokenUrls.size;
    channelCountEl.textContent = `Channels: ${activeCategoryList.length.toLocaleString()}` + (hiddenCount > 0 ? ` (${hiddenCount} offline hidden)` : '');
  }

  if (activeCategoryList.length === 0) {
    channelListEl.innerHTML = '<li style="padding: 20px; color: #6b7280; text-align: center; font-size: 0.85rem;">No channels available...</li>';
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

    const index = i;
    li.addEventListener('click', () => {
      playChannel(channel, li, index, true);
    });

    fragment.appendChild(li);
  }

  channelListEl.appendChild(fragment);
  renderedCount = nextChunkLimit;
}

/* ========================================================= */
/* STREAM PLAYER EXECUTION                                   */
/* ========================================================= */

function playChannel(channel, element, categoryIndex, isUserClicked = true) {
  if (skipTimer) {
    clearTimeout(skipTimer);
    skipTimer = null;
  }

  currentChannelIndex = categoryIndex;

  const prevActive = channelListEl.querySelector('.active');
  if (prevActive) prevActive.classList.remove('active');
  if (element) {
    element.classList.add('active');
    element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  if (isUserClicked && window.innerWidth < 1024) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  currentChannelName.innerHTML = `${channel.name} <span class="header-lang-tag">${channel.language}</span>`;
  statusBar.textContent = 'Connecting...';

  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }

  if (plyrInstance) {
    plyrInstance.volume = userVolume;
    plyrInstance.muted = isUserMuted;
  }
  videoPlayer.volume = userVolume;
  videoPlayer.muted = isUserMuted;

  if (Hls.isSupported()) {
    hlsPlayer = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      maxBufferLength: isMobileDevice ? 10 : 15,
      maxMaxBufferLength: isMobileDevice ? 20 : 30,
      maxBufferSize: (isMobileDevice ? 15 : 30) * 1024 * 1024,
      backBufferLength: 8,
      manifestLoadingTimeOut: 4000,
      manifestLoadingMaxRetry: 1,
      fragLoadingTimeOut: 5000,
      fragLoadingMaxRetry: 2
    });
    
    hlsPlayer.loadSource(channel.url);
    hlsPlayer.attachMedia(videoPlayer);

    hlsPlayer.on(Hls.Events.MANIFEST_PARSED, function(event, data) {
      const availableQualities = data.levels.map(l => l.height).filter(Boolean);
      availableQualities.unshift(-1);

      plyrInstance.config.quality = {
        default: -1,
        options: availableQualities,
        forced: true,
        onChange: (q) => { if (hlsPlayer) hlsPlayer.currentLevel = q; }
      };

      const playPromise = videoPlayer.play();
      if (playPromise !== undefined) {
        playPromise.then(() => {
          statusBar.textContent = 'Broadcasting';
        }).catch(() => {
          if (plyrInstance) plyrInstance.muted = true;
          videoPlayer.muted = true;
          videoPlayer.play();
          statusBar.textContent = 'Broadcasting (Muted)';
        });
      }
    });

    hlsPlayer.on(Hls.Events.ERROR, function(event, data) {
      if (data.fatal) {
        brokenUrls.add(channel.url);
        filterChannels();

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            statusBar.textContent = 'Offline. Skipping to next channel...';
            skipTimer = setTimeout(() => navigateCategoryChannel(1), 1200);
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hlsPlayer.recoverMediaError();
            break;
          default:
            statusBar.textContent = 'Playback error. Skipping...';
            skipTimer = setTimeout(() => navigateCategoryChannel(1), 1200);
            break;
        }
      }
    });

  } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
    videoPlayer.src = channel.url;
    videoPlayer.play().then(() => {
      statusBar.textContent = 'Broadcasting';
    }).catch(() => {
      if (plyrInstance) plyrInstance.muted = true;
      videoPlayer.muted = true;
      videoPlayer.play();
      statusBar.textContent = 'Broadcasting (Muted)';
    });
  }
}
