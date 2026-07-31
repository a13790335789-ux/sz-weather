/**
 * 深圳天气监测 App — 自动定位版
 * GPS精准定位到区 → 实时天气 + 推送通知
 */

// ========== 配置 ==========
let QWEATHER_KEY = localStorage.getItem('qweather_key') || '';
let currentPosition = null;  // { lat, lng, district, city }

// ========== 天气图标映射 ==========
const WEATHER_ICONS = {
  '晴': '☀️', '少云': '🌤', '晴间多云': '⛅', '多云': '☁️', '阴': '☁️',
  '小雨': '🌧', '中雨': '🌧', '大雨': '🌧', '暴雨': '⛈', '大暴雨': '⛈',
  '雷阵雨': '⛈', '阵雨': '🌦', '小雪': '🌨', '中雪': '🌨', '大雪': '❄️',
  '雨夹雪': '🌨', '雾': '🌫', '霾': '🌫', '浮尘': '🌪', '沙尘暴': '🌪',
  '大风': '💨', '台风': '🌀', '冰雹': '🧊',
};
function getIcon(text) {
  for (const [key, icon] of Object.entries(WEATHER_ICONS)) {
    if (text?.includes(key)) return icon;
  }
  return '🌡';
}

// ========== DOM 引用 ==========
const $ = id => document.getElementById(id);
const els = {
  currentTemp: $('currentTemp'),
  weatherText: $('weatherText'),
  feelLike: $('feelLike'),
  humidity: $('humidity'),
  wind: $('wind'),
  vis: $('vis'),
  updateTime: $('updateTime'),
  cityName: $('cityName'),
  districtName: $('districtName'),
  locStatus: $('locStatus'),
  hourlyScroll: $('hourlyScroll'),
  warningSection: $('warningSection'),
  warningCard: $('warningCard'),
  monitorStatus: $('monitorStatus'),
  nextCheck: $('nextCheck'),
  lastNotify: $('lastNotify'),
  btnRefresh: $('btnRefresh'),
  btnInstall: $('btnInstall'),
  setupOverlay: $('setupOverlay'),
  apiKeyInput: $('apiKeyInput'),
  btnSaveKey: $('btnSaveKey'),
  keyError: $('keyError'),
};

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', () => {
  if (!QWEATHER_KEY) {
    els.setupOverlay.classList.remove('hidden');
    setupKeyInput();
  } else {
    startApp();
  }
});

function startApp() {
  registerSW();
  setupButtons();
  setupPeriodicCheck();
  checkInstallable();
  setTimeout(() => sendKeyToSW(QWEATHER_KEY), 2000);
  // 先定位，再查天气
  getLocation().then(() => fetchAllWeather());
}

// ========== GPS 定位（核心）==========
async function getLocation() {
  els.locStatus.textContent = '定位中...';

  if (!navigator.geolocation) {
    els.locStatus.textContent = '浏览器不支持GPS';
    useFallbackLocation();
    return;
  }

  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,  // GPS精确模式
        timeout: 10000,
        maximumAge: 5 * 60 * 1000, // 5分钟缓存
      });
    });

    const lat = pos.coords.latitude.toFixed(4);
    const lng = pos.coords.longitude.toFixed(4);
    currentPosition = { lat, lng };

    // 用和风天气的反查API获取区级位置
    await reverseGeocode(lat, lng);

  } catch (err) {
    console.warn('GPS定位失败:', err.message);
    els.locStatus.textContent = 'GPS失败，用IP定位';
    useFallbackLocation();
  }
}

// ========== 逆向地理编码（经纬度→区名）==========
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://api.qweather.com/v2/city/lookup?location=${lng},${lat}&key=${QWEATHER_KEY}&number=1`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.code === '200' && data.location?.length > 0) {
      const loc = data.location[0];
      currentPosition = {
        ...currentPosition,
        district: loc.name || '',      // 如"南山"
        city: loc.adm2 || loc.adm1 || '', // 如"深圳"
        locationId: loc.id || '',      // 和风天气城市ID
      };
      els.cityName.textContent = currentPosition.city || '深圳';
      els.districtName.textContent = currentPosition.district || '';
      els.locStatus.textContent = '✅ GPS定位';
      sendLocationToSW(); // 同步给后台Service Worker
    } else {
      useFallbackLocation();
    }
  } catch (e) {
    console.warn('反查失败:', e);
    useFallbackLocation();
  }
}

// ========== 兜底：IP定位 ==========
async function useFallbackLocation() {
  try {
    // 用和风天气的IP定位
    const resp = await fetch(`https://api.qweather.com/v2/city/lookup?key=${QWEATHER_KEY}&q=深圳`);
    const data = await resp.json();
    if (data.code === '200' && data.location?.length > 0) {
      const loc = data.location[0];
      currentPosition = {
        lat: loc.lat, lng: loc.lon,
        district: '深圳',
        city: '深圳',
        locationId: loc.id || '101280601',
      };
      els.cityName.textContent = '深圳';
      els.districtName.textContent = '(IP定位)';
      els.locStatus.textContent = '📡 IP定位';
    }
  } catch (e) {
    // 最终兜底：深圳默认
    currentPosition = {
      lat: '22.54', lng: '114.06',
      district: '深圳',
      city: '深圳',
      locationId: '101280601',
    };
    els.cityName.textContent = '深圳';
    els.districtName.textContent = '';
    els.locStatus.textContent = '📌 默认深圳';
  }
}

// ========== 天气数据获取（用位置ID或坐标）==========
async function fetchAllWeather() {
  els.updateTime.textContent = '更新中...';

  if (!currentPosition) {
    els.updateTime.textContent = '等待GPS定位...';
    return;
  }

  const loc = currentPosition.locationId ||
    `${currentPosition.lng},${currentPosition.lat}`;

  // 调试：显示请求参数
  console.log('请求天气:', { loc, key: QWEATHER_KEY.slice(0,8) + '...' });

  try {
    const [nowResp, hourlyResp, warningResp] = await Promise.all([
      fetch(`https://api.qweather.com/v7/weather/now?location=${loc}&key=${QWEATHER_KEY}`),
      fetch(`https://api.qweather.com/v7/weather/24h?location=${loc}&key=${QWEATHER_KEY}`),
      fetch(`https://api.qweather.com/v7/warning/now?location=${loc}&key=${QWEATHER_KEY}`),
    ]);

    const now = await nowResp.json();
    const hourly = await hourlyResp.json();
    const warning = await warningResp.json();

    // 显示API状态（调试用）
    console.log('API返回:', { nowCode: now.code, hourlyCode: hourly.code, warningCode: warning.code });

    // 检查API是否正常
    if (now.code !== '200') {
      els.updateTime.textContent = `API错误: ${now.code || '未知'}`;
      els.weatherText.textContent = '请检查API Key是否正确';
      console.error('API错误:', now);
      return null;
    }

    updateUI({ now, hourly, warning });

    const d = new Date();
    els.updateTime.textContent = `更新于 ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;

    return { now, hourly, warning, position: currentPosition };
  } catch (err) {
    console.error('获取天气失败:', err);
    els.updateTime.textContent = `网络错误: ${err.message}`;
    els.weatherText.textContent = '请检查网络连接';
    return null;
  }
}

// ========== UI 更新 ==========
function updateUI(data) {
  const { now, hourly, warning } = data;

  // --- 当前天气 ---
  if (now?.code === '200' && now.now) {
    const n = now.now;
    els.currentTemp.textContent = n.temp || '--';
    els.weatherText.textContent = n.text || '--';
    els.feelLike.textContent = `体感 ${n.feelsLike || '--'}°C`;
    els.humidity.textContent = `${n.humidity || '--'}%`;
    els.wind.textContent = `${n.windScale || '--'}级 ${n.windDir || ''}`;
    els.vis.textContent = `${n.vis || '--'}km`;
  }

  // --- 24小时预报 ---
  const hourlies = hourly?.hourly || [];
  if (hourlies.length > 0) {
    els.hourlyScroll.innerHTML = hourlies.slice(0, 24).map(h => {
      const time = (h.fxTime || '').split('T')[1]?.slice(0, 5) || '';
      return `
        <div class="hour-item">
          <div class="time">${time || '--'}</div>
          <div class="icon">${getIcon(h.text)}</div>
          <div class="temp">${h.temp}°</div>
          ${h.pop > 0 ? `<div class="rain-chance">💧${h.pop}%</div>` : ''}
        </div>`;
    }).join('');
  }

  // --- 气象预警 ---
  const warnings = warning?.warning || [];
  if (warnings.length > 0 && warning?.code === '200') {
    els.warningSection.classList.remove('hidden');
    els.warningCard.innerHTML = warnings.map(w =>
      `<div style="font-weight:bold;margin-bottom:4px;">⚠️ ${w.typeName || '气象预警'} — ${w.level || ''}</div>
       <div>${w.text || ''}</div>
       <div style="font-size:12px;opacity:0.5;margin-top:4px;">发布时间: ${w.pubTime || ''}</div>`
    ).join('<hr style="opacity:0.15;margin:10px 0;">');
  } else {
    els.warningSection.classList.add('hidden');
  }
}

// ========== 定时检查 ==========
let checkTimer = null;

function setupPeriodicCheck() {
  const interval = 30 * 60 * 1000;
  updateNextCheckTime(interval);

  checkTimer = setInterval(async () => {
    await requestNotificationPermission();
    await getLocation();  // 重新定位
    const data = await fetchAllWeather();
    if (data && swRegistration) {
      const sw = swRegistration.active || swRegistration.installing;
      if (sw) sw.postMessage('check-weather');
    }
    updateNextCheckTime(interval);
  }, interval);
}

function updateNextCheckTime(intervalMs) {
  const next = new Date(Date.now() + intervalMs);
  els.nextCheck.textContent = `${next.getHours().toString().padStart(2,'0')}:${next.getMinutes().toString().padStart(2,'0')}`;
}

// ========== Service Worker ==========
let swRegistration = null;

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'weather-update') {
        updateUI(event.data.data);
      }
    });
    if ('periodicSync' in swRegistration) {
      try {
        await swRegistration.periodicSync.register('weather-check', {
          minInterval: 30 * 60 * 1000,
        });
      } catch (e) { /* 静默失败 */ }
    }
  } catch (err) {
    els.monitorStatus.textContent = '不可用';
    els.monitorStatus.classList.remove('on');
  }
}

function sendKeyToSW(key) {
  if (!swRegistration) return;
  const sw = swRegistration.active || swRegistration.installing;
  if (sw) sw.postMessage({ type: 'set-api-key', key });
}

function sendLocationToSW() {
  if (!swRegistration || !currentPosition) return;
  const sw = swRegistration.active || swRegistration.installing;
  if (sw) {
    sw.postMessage({
      type: 'set-location',
      locationId: currentPosition.locationId,
      lat: currentPosition.lat,
      lng: currentPosition.lng,
    });
  }
}

// ========== 通知权限 ==========
async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') return;
  if (Notification.permission !== 'denied') {
    await Notification.requestPermission();
  }
}

// ========== 按钮 ==========
function setupButtons() {
  els.btnRefresh.addEventListener('click', async () => {
    els.btnRefresh.textContent = '⏳ 刷新中...';
    els.btnRefresh.disabled = true;
    await getLocation();
    await fetchAllWeather();
    els.btnRefresh.textContent = '🔄 刷新定位+天气';
    els.btnRefresh.disabled = false;
  });
}

// ========== API Key设置 ==========
function setupKeyInput() {
  els.btnSaveKey.addEventListener('click', () => {
    const key = els.apiKeyInput.value.trim();
    if (!key || key.length < 10) {
      els.keyError.style.display = 'block';
      els.keyError.textContent = 'Key格式不正确，请检查';
      return;
    }
    localStorage.setItem('qweather_key', key);
    QWEATHER_KEY = key;
    els.setupOverlay.classList.add('hidden');
    sendKeyToSW(key);
    startApp();
  });
  els.apiKeyInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') els.btnSaveKey.click();
  });
}

// ========== PWA 安装 ==========
let deferredPrompt = null;

function checkInstallable() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    els.btnInstall.style.display = 'block';
  });
  els.btnInstall.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const result = await deferredPrompt.userChoice;
    if (result.outcome === 'accepted') {
      els.btnInstall.style.display = 'none';
    }
    deferredPrompt = null;
  });
  if (window.matchMedia('(display-mode: standalone)').matches) {
    els.btnInstall.style.display = 'none';
  }
}

// 1分钟后请求通知权限
setTimeout(requestNotificationPermission, 60000);
