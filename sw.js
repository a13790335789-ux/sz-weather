// Service Worker — 后台天气检查 + 推送通知
const CACHE_NAME = 'sz-weather-v2';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(['/', '/index.html', '/app.js', '/style.css', '/manifest.json'])
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  // 清除所有旧缓存
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
  );
  // 立即接管所有页面
  event.waitUntil(self.clients.claim());
});

// 存储位置
let watchLat = 22.5431;
let watchLng = 114.0579;

self.addEventListener('message', event => {
  if (event.data?.type === 'set-location') {
    watchLat = parseFloat(event.data.lat) || 22.5431;
    watchLng = parseFloat(event.data.lng) || 114.0579;
  } else if (event.data === 'check-weather') {
    checkWeatherAndNotify();
  }
});

self.addEventListener('periodicsync', event => {
  if (event.tag === 'weather-check') {
    event.waitUntil(checkWeatherAndNotify());
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      if (clientList.length > 0) clientList[0].focus();
      else clients.openWindow('/');
    })
  );
});

// ========== 天气检查（Open-Meteo，无需Key）==========
async function checkWeatherAndNotify() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${watchLat}&longitude=${watchLng}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=2`;

    const resp = await fetch(url);
    const data = await resp.json();

    if (!data.current) return;

    const notifications = detectChanges(data);

    // 推送数据给页面
    const allClients = await self.clients.matchAll();
    allClients.forEach(c => c.postMessage({ type: 'weather-update', data }));

    // 发通知
    for (const n of notifications) {
      await self.registration.showNotification(n.title, {
        body: n.body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: n.tag,
        requireInteraction: n.important,
        vibrate: [200, 100, 200],
      });
    }

    // 缓存数据供下次对比
    const cache = await caches.open(CACHE_NAME);
    cache.put('last_weather', new Response(JSON.stringify({
      temp: data.current.temperature_2m,
      code: data.current.weather_code,
      time: Date.now(),
    })));

  } catch (err) {
    console.error('SW天气检查失败:', err);
  }
}

// ========== 变化检测 ==========
async function detectChanges(data) {
  const notifications = [];
  const c = data.current;
  const temp = Math.round(c.temperature_2m);
  const code = c.weather_code;
  const wind = c.wind_speed_10m;

  // --- 降雨检测 ---
  const rainCodes = [51,53,55,61,63,65,80,81,82,95,96,99];
  if (rainCodes.includes(code)) {
    notifications.push({
      title: '🌧 当前正在下雨',
      body: `温度${temp}°C，出门记得带伞`,
      tag: 'rain-now',
      important: true,
    });
  }

  // 未来降雨概率
  if (data.hourly) {
    const nowHour = new Date().getHours();
    const next6Pop = data.hourly.precipitation_probability
      ?.slice(nowHour, nowHour + 6)
      ?.filter(p => p > 50);

    if (next6Pop?.length > 0) {
      notifications.push({
        title: '🌧 未来6小时可能降雨',
        body: `降雨概率${Math.max(...next6Pop)}%，出门带伞`,
        tag: 'rain-coming',
        important: true,
      });
    }
  }

  // --- 大风 ---
  if (wind >= 25) {  // km/h, ~6级风
    notifications.push({
      title: '💨 大风预警',
      body: `当前风速${Math.round(wind)}km/h，注意安全`,
      tag: 'wind',
      important: wind >= 40,
    });
  }

  // --- 高温/低温 ---
  if (temp >= 35) {
    notifications.push({
      title: '🔥 高温预警',
      body: `当前${temp}°C，注意防暑`,
      tag: 'heat',
      important: true,
    });
  } else if (temp <= 5) {
    notifications.push({
      title: '🥶 低温预警',
      body: `当前${temp}°C，注意保暖`,
      tag: 'cold',
      important: true,
    });
  }

  return notifications;
}
