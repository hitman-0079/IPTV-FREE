let channels = [];
let activeCategoryList = [];
let currentChannelIndex = 0;
let skipTimer = null;
let searchTimeout = null;

let hlsPlayer = null;
let plyrInstance = null;

// Gemini Captions State
let captionsEnabled = false;
let geminiApiKey = localStorage.getItem('gemini_api_key') || '';
let captureInterval = null;
let isCapturing = false;

// Audio Volume States
let userVolume = 1;
let isUserMuted = false;

// Background Channel Scanner State
let verifiedOnlineUrls = new Set();
let scannedUrls = new Set();
let isScanning = false;
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

// Live Caption DOM Elements
const captionToggleBtn = document.getElementById('captionToggleBtn');
const liveCaptionOverlay = document.getElementById('liveCaptionOverlay');
const captionText = document.getElementById('captionText');

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

  channelListEl.addEventListener('scroll', () => {
    if (channelListEl.scrollTop + channelListEl.clientHeight >= channelListEl.scrollHeight - 200) {
      appendMoreChannels();
    }
  });

  captionToggleBtn.addEventListener('click', toggleCaptions);

  playlistSelect.value = DEFAULT_PLAYLIST_URL;
  fetchAndParsePlaylist(playlistSelect.value);
});

/* ========================================================= */
/* BACKGROUND ONLINE/OFFLINE STREAM SCANNER                   */
/* ========================================================= */

function startBackgroundScanner() {
  scanQueue = [...channels];
  verifiedOnlineUrls.clear();
  scannedUrls.clear();
  
  if (!isScanning) {
    isScanning = true;
    processScanQueue();
  }
}

async function processScanQueue() {
  // Concurrently test 5 streams at a time in the background
  const BATCH_SIZE = 5;

  while (scanQueue.length > 0) {
    const batch = scanQueue.splice(0, BATCH_SIZE);
    
    await Promise.all(batch.map(async (channel) => {
      if (scannedUrls.has(channel.url)) return;
      scannedUrls.add(channel.url);

      const isOnline = await checkStreamHealth(channel.url);
      if (isOnline) {
        verifiedOnlineUrls.add(channel.url);
        // Refresh visible directory menu to continuously expose new live streams
        filterChannels(); 
      }
    }));

    // Pause briefly between batches to prevent UI lag
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  isScanning = false;
}

function checkStreamHealth(url) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, 3500); // 3.5 sec timeout

    // Rapid request check to see if playlist file exists and yields an HTTP 200
    fetch(url, { method: 'GET', signal: controller.signal })
      .then(response => {
        clearTimeout(timeoutId);
        resolve(response.ok);
      })
      .catch(() => {
        clearTimeout(timeoutId);
        resolve(false);
      });
  });
}

/* ========================================================= */
/* GEMINI AI LIVE AUDIO CAPTIONING                           */
/* ========================================================= */

async function toggleCaptions() {
  captionsEnabled = !captionsEnabled;
  captionToggleBtn.classList.toggle('active', captionsEnabled);

  if (captionsEnabled) {
    if (!geminiApiKey) {
      geminiApiKey = prompt("Enter your Google Gemini API Key to enable AI Live Captions:");
      if (!geminiApiKey) {
        captionsEnabled = false;
        captionToggleBtn.classList.remove('active');
        return;
      }
      localStorage.setItem('gemini_api_key', geminiApiKey);
    }
    startGeminiCaptions();
  } else {
    stopGeminiCaptions();
  }
}

function startGeminiCaptions() {
  liveCaptionOverlay.classList.remove('hidden');
  captionText.textContent = "Connecting to Gemini AI...";
  isCapturing = true;

  try {
    const stream = videoPlayer.captureStream ? videoPlayer.captureStream() : (videoPlayer.mozCaptureStream ? videoPlayer.mozCaptureStream() : null);
    
    if (!stream || stream.getAudioTracks().length === 0) {
      captionText.textContent = "Error: Audio blocked by stream security/CORS policies.";
      return;
    }

    captionText.textContent = "Listening to live broadcast...";
    
    captureInterval = setInterval(() => {
      if (isCapturing) recordAndSendAudioChunk(stream);
    }, 4000);
    
    recordAndSendAudioChunk(stream);

  } catch (err) {
    captionText.textContent = "CORS Error: Audio capture blocked by stream security.";
    console.error("Capture stream error:", err);
  }
}

function stopGeminiCaptions() {
  isCapturing = false;
  liveCaptionOverlay.classList.add('hidden');
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
}

function recordAndSendAudioChunk(stream) {
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) return;

  const chunkStream = new MediaStream([audioTrack]);
  const recorder = new MediaRecorder(chunkStream, { mimeType: 'audio/webm' });
  const chunks = [];

  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    if (blob.size > 0) {
      const base64Audio = await blobToBase64(blob);
      transcribeWithGemini(base64Audio);
    }
  };

  recorder.start();
  setTimeout(() => {
    if (recorder.state !== 'inactive') recorder.stop();
  }, 3900); 
}

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

async function transcribeWithGemini(base64Data) {
  if (!isCapturing) return;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
  const payload = {
    contents: [{
      parts: [
        { text: "You are a closed-captioning system. Transcribe the following short audio snippet accurately in English. Do not add markdown or extra commentary. If there is no human speech, reply strictly with '[SILENCE]'." },
        { inlineData: { mimeType: "audio/webm", data: base64Data } }
      ]
    }],
    generationConfig: { temperature: 0.2 }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (data.candidates && data.candidates[0].content.parts[0].text) {
      const text = data.candidates[0].content.parts[0].text.trim();
      if (text && !text.includes("[SILENCE]")) {
        captionText.textContent = text;
      }
    } else if (data.error && data.error.code === 403) {
      captionText.textContent = "Error: Invalid Gemini API Key.";
      stopGeminiCaptions();
    }
  } catch (err) {
    console.error("Gemini Transcription Error:", err);
  }
}

/* ========================================================= */
/* APP LOGIC & M3U HANDLING                                  */
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
  statusBar.textContent = 'Downloading iptv-org playlist...';
  channelListEl.innerHTML = '<li style="padding: 20px; color: #6b7280; text-align: center; font-size: 0.85rem;">Parsing channels...</li>';

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Network error');
    const m3uText = await response.text();
    
    statusBar.textContent = 'Building directory...';
    
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

      // Trigger automatic background health scanning
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

// FILTER: Only display channels verified as ONLINE (or display all during initial load)
function filterChannels() {
  const query = searchInput.value.trim().toLowerCase();
  
  // Filter channels based on background scan results
  let pool = channels;
  if (scannedUrls.size > 0 && verifiedOnlineUrls.size > 0) {
    pool = channels.filter(c => verifiedOnlineUrls.has(c.url));
  }

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
    const scannedTotal = scannedUrls.size;
    channelCountEl.textContent = scannedTotal > 0 
      ? `Online Channels: ${activeCategoryList.length.toLocaleString()} (Scanned: ${scannedTotal})` 
      : `Channels: ${activeCategoryList.length.toLocaleString()}`;
  }

  if (activeCategoryList.length === 0) {
    channelListEl.innerHTML = '<li style="padding: 20px; color: #6b7280; text-align: center; font-size: 0.85rem;">Scanning for online streams...</li>';
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

function playChannel(channel, element, categoryIndex, isUserClicked = true) {
  if (skipTimer) {
    clearTimeout(skipTimer);
    skipTimer = null;
  }
  
  if (captionsEnabled) {
    stopGeminiCaptions();
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
          if (captionsEnabled) setTimeout(startGeminiCaptions, 1000);
        }).catch(() => {
          if (plyrInstance) plyrInstance.muted = true;
          videoPlayer.muted = true;
          videoPlayer.play();
          statusBar.textContent = 'Broadcasting (Muted)';
          if (captionsEnabled) setTimeout(startGeminiCaptions, 1000);
        });
      }
    });

    hlsPlayer.on(Hls.Events.ERROR, function(event, data) {
      if (data.fatal) {
        // If playing the stream fails, mark it offline and remove it from menu
        verifiedOnlineUrls.delete(channel.url);
        filterChannels();

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            statusBar.textContent = 'Offline. Skipping to next working stream...';
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
      if (captionsEnabled) setTimeout(startGeminiCaptions, 1000);
    }).catch(() => {
      if (plyrInstance) plyrInstance.muted = true;
      videoPlayer.muted = true;
      videoPlayer.play();
      statusBar.textContent = 'Broadcasting (Muted)';
      if (captionsEnabled) setTimeout(startGeminiCaptions, 1000);
    });
  }
}
