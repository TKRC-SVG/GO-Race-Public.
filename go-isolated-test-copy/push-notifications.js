(function () {
  'use strict';
  const toggle = document.getElementById('pushToggle');
  const test = document.getElementById('pushTest');
  const status = document.getElementById('pushStatus');
  const signIn = document.getElementById('pushSignIn');
  let registration, subscription, deviceId, config, busy = false, requestPending = false;
  let lastSent = '', latest, lastAttempt = 0;
  async function api(path, method = 'GET', body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/push/' + path, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json();
      if (!response.ok) { signIn.hidden = response.status !== 401; const error = new Error(data.error || 'No se ha podido completar la operación push.'); error.status = response.status; throw error; }
      signIn.hidden = true;
      return data;
    } finally { clearTimeout(timer); }
  }
  function ui() {
    toggle.textContent = deviceId ? 'Desactivar push' : 'Activar push';
    toggle.setAttribute('aria-pressed', String(!!deviceId));
    toggle.disabled = busy;
    test.disabled = busy || !deviceId;
  }
  function errorText(error) {
    if (error.status === 401) return error.message;
    if (Notification.permission === 'denied') return 'Los avisos están bloqueados. Permítelos en Ajustes > Notificaciones > GO! y vuelve a intentarlo.';
    return error.name === 'AbortError' ? 'Sin respuesta del servicio push. Vuelve a intentarlo.' : error.message;
  }
  function keyBytes(value) {
    return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  }
  async function prepare() {
    if (!config) config = await api('config');
    if (!registration) {
      await navigator.serviceWorker.register('./sw.js');
      let timer;
      try { registration = await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Vuelve a abrir Go para preparar las notificaciones.')), 10000); })]); }
      finally { clearTimeout(timer); }
    }
  }
  async function saveSubscription() {
    const result = await api('subscribe', 'POST', { subscription: subscription.toJSON() });
    deviceId = result.id;
    status.textContent = 'Push activados en este dispositivo. Pulsa Probar push para comprobar la recepción.';
  }
  async function init() {
    try { config = await api('config'); } catch (error) { status.textContent = error.message; }
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (ios && !standalone) {
      toggle.disabled = true;
      status.textContent = 'En iPhone: abre Go desde su icono de la pantalla de inicio. Si aún no lo tienes, usa Compartir > Añadir a pantalla de inicio.';
      return;
    }
    if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
      toggle.disabled = true; status.textContent = 'Este navegador no admite avisos push. Prueba con Go instalada en el móvil.'; return;
    }
    toggle.addEventListener('click', async () => {
      if (busy) return;
      busy = true; ui();
      try {
        if (deviceId) {
          await api('subscribe', 'DELETE', { id: deviceId });
          if (subscription) await subscription.unsubscribe();
          deviceId = null; subscription = null;
          status.textContent = 'Push desactivados en este dispositivo.';
        } else {
          // Ask directly from the tap; fetching before this can lose iOS user activation.
          const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
          if (permission !== 'granted') throw new Error('No se ha concedido el permiso de notificaciones.');
          await prepare();
          subscription = await registration.pushManager.getSubscription();
          if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey) });
          await saveSubscription();
        }
      } catch (error) { status.textContent = errorText(error); }
      finally { busy = false; ui(); }
    });
    test.addEventListener('click', async () => {
      if (busy || !deviceId) return;
      busy = true; ui();
      try {
        await api('test', 'POST', { id: deviceId });
        status.textContent = 'Prueba programada: bloquea ahora el móvil. El servidor enviará el push en 10 segundos.';
      } catch (error) { status.textContent = errorText(error); }
      finally { busy = false; ui(); }
    });
    try {
      await prepare();
      subscription = await registration.pushManager.getSubscription();
      if (subscription && Notification.permission === 'granted') await saveSubscription();
    } catch (error) { status.textContent = errorText(error); }
    ui();
  }
  async function relay(data) {
    latest = data;
    if (!config || document.visibilityState !== 'visible') return;
    // Sending from another signed-in Go does not require notification permission there.
    if (!data?.running || !data.target || requestPending || lastSent === data.target.key || Date.now() - lastAttempt < 5000) return;
    requestPending = true; lastAttempt = Date.now();
    try {
      const result = await api('notify', 'POST', { target: data.target, observedAt: Date.now() });
      if (!result.failed) lastSent = data.target.key;
    } catch { /* Try again on a later fresh Live update. The sound alarm is independent. */ }
    finally { requestPending = false; }
  }
  window.GoPush = { update: relay };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && latest) relay(latest); });
  init();
})();
