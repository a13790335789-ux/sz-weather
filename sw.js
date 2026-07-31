// Service Worker — 后台定时检查天气 + 推送通知
const CACHE_NAME = 'sz-weather-v1';
const CHECK_INTERVAL = 30 * 60 * 1000; // 30分钟检查一次

// 安装时缓存核心文件
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(['/', '/index.html', '/app.js', '/style.css', '/manifest.json'])
    )
  );
  self.skipWaiting();
});

// 存储状态
let apiKey = '';
let watchLocation = '101280601'; // 默认深圳

self.addEventListener('message', event => {
  if (event.data?.type === 'set-api-key') {
    apiKey = event.data.key;
  } else if (event.data?.type === 'set-location') {
    watchLocation = event.data.locationId || `${event.data.lng},${event.data.lat}`;
  } else if (event.data === 'check-weather') {
    checkWeatherAndNotify();
  }
});

// 激活时清理旧缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 定时检查（通过 Periodic Background Sync）
self.addEventListener('periodicsync', event => {
  if (event.tag === 'weather-check') {
    event.waitUntil(checkWeatherAndNotify());
  }
});

// 推送通知点击 → 打开App
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      if (clientList.length > 0) {
        clientList[0].focus();
      } else {
        clients.openWindow('/');
      }
    })
  );
});

// ========== 天气检查逻辑 ==========
const STORAGE_KEY = 'last_weather_data';

async function checkWeatherAndNotify() {
  if (!apiKey) {
    console.warn('SW: 未设置API Key，跳过检查');
    return;
  }
  try {
    // 并行请求：实时天气 + 24h预报 + 预警
    const [now, hourly, warning] = await Promise.all([
      fetch(`https://api.qweather.com/v7/weather/now?location=${watchLocation}&key=${apiKey}`).then(r => r.json()),
      fetch(`https://api.qweather.com/v7/weather/24h?location=${watchLocation}&key=${apiKey}`).then(r => r.json()),
      fetch(`https://api.qweather.com/v7/warning/now?location=${watchLocation}&key=${apiKey}`).then(r => r.json()),
    ]);

    const currentData = { now, hourly, warning, timestamp: Date.now() };

    // 检测变化并生成通知
    const notifications = detectChanges(currentData);

    // 保存当前数据
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({ type: 'weather-update', data: currentData });
    });

    // 发送通知
    for (const n of notifications) {
      self.registration.showNotification(n.title, {
        body: n.body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: n.tag,
        requireInteraction: n.important,
        vibrate: [200, 100, 200],
      });
    }

    // 存储本次数据用于下次对比
    const cache = await caches.open(CACHE_NAME);
    cache.put(STORAGE_KEY, new Response(JSON.stringify(currentData)));

  } catch (err) {
    console.error('天气检查失败:', err);
  }
}

// ========== 变化检测算法 ==========

async function detectChanges(current) {
  const notifications = [];
  const now = current.now;
  const hourlies = current.hourly?.hourly || [];
  const warnings = current.warning?.warning || [];

  if (!now || now.code !== '200') return notifications;

  // --- 1. 气象预警（最重要）---
  for (const w of warnings) {
    const warningTypes = {
      '台风': '🌀', '暴雨': '🌧', '雷电': '⚡', '大风': '💨',
      '冰雹': '🧊', '高温': '🔥', '寒潮': '🥶', '大雾': '🌫',
    };
    let emoji = '⚠️';
    for (const [key, val] of Object.entries(warningTypes)) {
      if (w.typeName?.includes(key)) { emoji = val; break; }
    }
    notifications.push({
      title: `${emoji} ${w.typeName || '气象预警'} — ${w.level || ''}`,
      body: w.text || '请查看详情',
      tag: `warning-${w.id}`,
      important: true,
    });
  }

  // --- 2. 降雨检测（未来6小时内有雨）---
  const upcomingRain = hourlies.slice(0, 6).filter(h => {
    const text = h.text || '';
    return text.includes('雨') || text.includes('雪');
  });
  if (upcomingRain.length > 0) {
    const firstRain = upcomingRain[0];
    notifications.push({
      title: '🌧 即将降雨',
      body: `预计${firstRain.fxTime?.split('T')[1]?.slice(0, 5) || ''}开始有${firstRain.text}，出门记得带伞`,
      tag: 'rain-alert',
      important: true,
    });
  }

  // --- 3. 温度骤变 ---
  if (hourlies.length >= 2) {
    const currentTemp = parseInt(now.now?.temp) || 0;
    const nextTemp = parseInt(hourlies[0]?.temp) || 0;
    if (Math.abs(nextTemp - currentTemp) >= 5) {
      const isDrop = nextTemp < currentTemp;
      notifications.push({
        title: isDrop ? '📉 即将降温' : '📈 即将升温',
        body: `未来1小时温度将从${currentTemp}°C${isDrop ? '降至' : '升至'}${nextTemp}°C`,
        tag: 'temp-change',
        important: false,
      });
    }
  }

  // --- 4. 风力预警 ---
  const windScale = parseInt(now.now?.windScale) || 0;
  if (windScale >= 6) {
    notifications.push({
      title: '💨 大风预警',
      body: `当前风力${windScale}级，注意防风`,
      tag: 'wind-alert',
      important: windScale >= 8,
    });
  }

  // --- 5. 转晴提醒 ---
  const currentText = now.now?.text || '';
  const isRainNow = currentText.includes('雨');
  const upcomingClear = hourlies.slice(0, 4).filter(h => (h.text || '').includes('晴'));
  if (isRainNow && upcomingClear.length > 0) {
    notifications.push({
      title: '☀️ 即将转晴',
      body: '雨快停了，适合安排出行',
      tag: 'clear-up',
      important: false,
    });
  }

  return notifications;
}
