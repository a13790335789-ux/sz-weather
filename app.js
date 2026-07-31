/**
 * 深圳天气监测 App — 自动定位版
 * 使用 Open-Meteo 免费API（无需Key）
 */

// ========== 天气图标 ==========
function getIcon(code, isNight) {
  const map = {
    0: isNight ? '🌙' : '☀️',      // 晴
    1: isNight ? '🌙' : '🌤',      // 少云
    2: '⛅',                        // 多云
    3: '☁️',                        // 阴
    45: '🌫', 48: '🌫',            // 雾
    51: '🌦', 53: '🌦', 55: '🌦',  // 小雨
    61: '🌧', 63: '🌧', 65: '🌧',  // 雨
    71: '🌨', 73: '🌨', 75: '🌨',  // 雪
    80: '🌦', 81: '🌧', 82: '⛈',  // 阵雨
    95: '⛈', 96: '⛈', 99: '⛈',   // 雷暴
  };
  return map[code] || '🌡';
}

function getWeatherText(code) {
  const map = {
    0:'晴',1:'少云',2:'多云',3:'阴',
    45:'雾',48:'雾凇',
    51:'毛毛雨',53:'小雨',55:'中雨',
    61:'小雨',63:'中雨',65:'大雨',
    71:'小雪',73:'中雪',75:'大雪',
    80:'阵雨',81:'中阵雨',82:'暴雨',
    95:'雷暴',96:'冰雹雷暴',99:'强雷暴',
  };
  return map[code] || '未知';
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
let currentPosition = null;
let QWEATHER_KEY = localStorage.getItem('qweather_key') || '';

document.addEventListener('DOMContentLoaded', () => {
  // 不再需要API Key了，直接用Open-Meteo
  startApp();
});

function startApp() {
  registerSW();
  setupButtons();
  setupPeriodicCheck();
  checkInstallable();
  getLocation().then(() => fetchAllWeather());
}

// ========== GPS 定位 ==========
async function getLocation() {
  els.locStatus.textContent = '定位中...';

  if (!navigator.geolocation) {
    els.locStatus.textContent = '浏览器不支持GPS';
    useDefaultLocation();
    return;
  }

  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 5 * 60 * 1000,
      });
    });

    currentPosition = {
      lat: parseFloat(pos.coords.latitude.toFixed(4)),
      lng: parseFloat(pos.coords.longitude.toFixed(4)),
    };

    // 反向地理编码获取区名（用免费的 nominatim）
    await reverseGeocode(currentPosition.lat, currentPosition.lng);

  } catch (err) {
    console.warn('GPS失败:', err.message);
    els.locStatus.textContent = 'GPS失败，使用IP定位';
    useDefaultLocation();
  }
}

async function reverseGeocode(lat, lng) {
  try {
    // 用Nominatim免费反向地理编码（OpenStreetMap）
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14&accept-language=zh`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'SZWeatherApp/1.0' } });
    const data = await resp.json();

    if (data.address) {
      const ad = data.address;
      // 提取区名（深圳的区：南山/福田/罗湖/宝安/龙岗/龙华/盐田/坪山/光明）
      const district = ad.district || ad.city_district || ad.suburb || ad.county || '';
      const city = ad.city || ad.state || '深圳';

      currentPosition.district = district.replace('区', '');
      currentPosition.city = city.replace('市', '');

      els.cityName.textContent = currentPosition.city || '深圳';
      els.districtName.textContent = currentPosition.district || '';
      els.locStatus.textContent = '✅ GPS定位';
    }
  } catch (e) {
    console.warn('反查失败:', e);
    useDefaultLocation();
  }
}

function useDefaultLocation() {
  currentPosition = { lat: 22.5431, lng: 114.0579, city: '深圳', district: '' };
  els.cityName.textContent = '深圳';
  els.locStatus.textContent = '📌 默认深圳';
}

// ========== 获取天气（Open-Meteo，无需Key）==========
async function fetchAllWeather() {
  els.updateTime.textContent = '更新中...';

  if (!currentPosition) {
    els.updateTime.textContent = '等待定位...';
    return null;
  }

  try {
    const { lat, lng } = currentPosition;

    // Open-Meteo: 免费、无需Key、全球覆盖
    // 参数说明: hourly降水概率需要额外参数
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=2`;

    const resp = await fetch(url);
    const data = await resp.json();

    updateUI(data);

    const d = new Date();
    els.updateTime.textContent = `更新于 ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;

    return data;
  } catch (err) {
    console.error('天气获取失败:', err);
    els.updateTime.textContent = `错误: ${err.message}`;
    return null;
  }
}

// ========== UI 更新 ==========
function updateUI(data) {
  // --- 当前天气 ---
  if (data.current) {
    const c = data.current;
    const isNight = new Date().getHours() < 6 || new Date().getHours() >= 19;
    els.currentTemp.textContent = Math.round(c.temperature_2m);
    els.weatherText.textContent = getWeatherText(c.weather_code);
    els.feelLike.textContent = `体感 ${Math.round(c.apparent_temperature)}°C`;
    els.humidity.textContent = `${c.relative_humidity_2m}%`;
    els.wind.textContent = `${c.wind_speed_10m} km/h`;
    els.vis.textContent = '--';
  }

  // --- 24小时预报 ---
  if (data.hourly) {
    const nowHour = new Date().getHours();
    const hours = data.hourly.time
      .map((t, i) => ({
        time: t.split('T')[1]?.slice(0, 5) || '',
        temp: Math.round(data.hourly.temperature_2m[i]),
        code: data.hourly.weather_code[i],
        pop: data.hourly.precipitation_probability[i] || 0,
        wind: data.hourly.wind_speed_10m[i] || 0,
      }))
      .slice(nowHour, nowHour + 24);

    const isNight = new Date().getHours() >= 18 || new Date().getHours() < 6;

    els.hourlyScroll.innerHTML = hours.map(h => `
      <div class="hour-item">
        <div class="time">${h.time}</div>
        <div class="icon">${getIcon(h.code, isNight)}</div>
        <div class="temp">${h.temp}°</div>
        ${h.pop > 20 ? `<div class="rain-chance">💧${h.pop}%</div>` : ''}
        ${h.wind >= 25 ? `<div style="font-size:10px;color:#f59e0b;">💨${h.wind}</div>` : ''}
      </div>
    `).join('');
  }

  // --- 天气预警（Open-Meteo没有，隐藏）---
  els.warningSection.classList.add('hidden');

  // --- 未来几天摘要 ---
  if (data.daily) {
    const today = data.daily;
    const tomorrowMax = Math.round(today.temperature_2m_max[1]);
    const tomorrowMin = Math.round(today.temperature_2m_min[1]);
    const rainProb = today.precipitation_probability_max[1] || 0;

    let alert = '';
    if (rainProb >= 60) alert = '⚠️ 明天降雨概率高';
    else if (tomorrowMax >= 35) alert = '🔥 明天高温';
    else if (tomorrowMax <= 15) alert = '🥶 明天降温';
    else alert = '✅ 明天天气正常';

    // 在预警区显示明日摘要
    if (alert.includes('⚠️') || alert.includes('🔥') || alert.includes('🥶')) {
      els.warningSection.classList.remove('hidden');
      els.warningCard.innerHTML = `
        <div style="font-weight:bold;margin-bottom:4px;">📅 ${alert}</div>
        <div>明天 ${tomorrowMin}°C ~ ${tomorrowMax}°C · 降雨概率 ${rainProb}%</div>
      `;
    }
  }
}

// ========== 定时检查 ==========
let checkTimer = null;

function setupPeriodicCheck() {
  const interval = 30 * 60 * 1000;
  updateNextCheckTime(interval);

  checkTimer = setInterval(async () => {
    await requestNotificationPermission();
    await getLocation();
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
    // 先注销所有旧SW
    const oldRegs = await navigator.serviceWorker.getRegistrations();
    for (const reg of oldRegs) {
      await reg.unregister();
    }

    swRegistration = await navigator.serviceWorker.register('/sw.js?v=3', { scope: '/' });

    // 检测SW更新
    swRegistration.addEventListener('updatefound', () => {
      const newSW = swRegistration.installing;
      newSW.addEventListener('statechange', () => {
        if (newSW.state === 'activated' && navigator.serviceWorker.controller) {
          // 新SW激活了，刷新页面
          window.location.reload();
        }
      });
    });

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
      } catch (e) {}
    }
  } catch (err) {
    console.error('SW注册失败:', err);
    els.monitorStatus.textContent = '不可用';
    els.monitorStatus.classList.remove('on');
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

setTimeout(requestNotificationPermission, 60000);
