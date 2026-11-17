(function () {
  'use strict';
  const panel = document.getElementById('heatAlarm');
  const toggle = document.getElementById('heatAlarmToggle');
  const test = document.getElementById('heatAlarmTest');
  const status = document.getElementById('heatAlarmStatus');
  const notice = document.getElementById('heatAlarmNotice');
  const message = document.getElementById('heatAlarmMessage');
  const stopButton = document.getElementById('heatAlarmStop');
  const storageKey = 'goJorgeHeatAlarmSeenV1';
  let context, enabled = false, soundSource, ringing = false, wakeLock, wakePending = false, latest;
  let seen;
  try { seen = new Set(JSON.parse(localStorage.getItem(storageKey) || '[]')); }
  catch { seen = new Set(); }

  function stop() {
    ringing = false;
    if (soundSource) { try { soundSource.stop(); soundSource.disconnect(); } catch {} soundSource = null; }
    stopButton.hidden = true;
  }
  function sound(short = false) {
    if (!context || context.state !== 'running') return false;
    stop();
    const rate = context.sampleRate, duration = short ? 0.48 : 2.4;
    const buffer = context.createBuffer(1, Math.ceil(rate * duration), rate);
    const samples = buffer.getChannelData(0);
    const starts = short ? [0, 0.24] : [0, 0.24, 0.48, 0.72, 1.2, 1.44, 1.68, 1.92];
    starts.forEach((start, index) => {
      const frequency = index % 2 ? 1320 : 880, length = 0.18;
      for (let frame = Math.ceil(start * rate); frame < Math.min(samples.length, Math.floor((start + length) * rate)); frame++) {
        const time = frame / rate - start, phase = 2 * Math.PI * frequency * time;
        const envelope = Math.min(1, time / 0.006, (length - time) / 0.012);
        // Raise the sustained level with smooth compression, then normalize below full scale.
        const wave = (Math.sin(phase) + 0.32 * Math.sin(3 * phase) + 0.16 * Math.sin(5 * phase)) / 1.48;
        samples[frame] = envelope * (short ? 0.4 * wave : Math.tanh(2 * wave));
      }
    });
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    if (peak > 0) for (let frame = 0; frame < samples.length; frame++) samples[frame] *= (short ? 0.4 : 0.99) / peak;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = !short;
    source.connect(context.destination);
    soundSource = source;
    ringing = !short;
    stopButton.hidden = short;
    source.onended = () => {
      source.disconnect();
      if (soundSource === source) { soundSource = null; ringing = false; stopButton.hidden = true; }
    };
    source.start();
    return true;
  }
  function showTest() {
    if (!sound()) return false;
    message.textContent = 'Prueba de alarma: sonará de forma repetitiva hasta que pulses Parar alarma.';
    notice.hidden = false;
    status.textContent = 'Prueba de alarma sonando · pulsa Parar alarma para detenerla.';
    return true;
  }
  function dismiss() {
    stop(); notice.hidden = true;
    status.textContent = enabled ? 'Alarma detenida · seguimiento activo para tus próximas salidas.' : 'Alarma desactivada.';
  }
  async function keepScreenOn() {
    if (!enabled || document.visibilityState !== 'visible' || !navigator.wakeLock || wakeLock || wakePending) return;
    wakePending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!enabled || document.visibilityState !== 'visible') { await lock.release(); return; }
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
    } catch {} finally { wakePending = false; }
  }
  function controls() {
    toggle.textContent = enabled ? 'Desactivar alarma' : 'Activar alarma';
    toggle.setAttribute('aria-pressed', String(enabled));
    test.disabled = !enabled;
  }
  async function activate(testAfter = false) {
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) throw new Error('audio');
      if (!context || context.state === 'closed') context = new Audio();
      // Resume directly from the tap: iPhone requires user interaction.
      await Promise.race([context.resume(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500))]);
      if (context.state !== 'running') throw new Error('suspended');
      enabled = true; controls(); sound(true); keepScreenOn();
      window.dispatchEvent(new Event('go-heat-alarm-ready'));
      if (latest) update(latest);
      if (testAfter && !ringing) showTest();
    } catch {
      enabled = false; controls();
      status.textContent = 'No se ha podido activar el sonido. Vuelve a tocar Activar alarma.';
    }
  }
  toggle.addEventListener('click', () => {
    if (!enabled) { activate(); return; }
    enabled = false; stop(); notice.hidden = true; controls();
    if (wakeLock) wakeLock.release().catch(() => {});
    status.textContent = 'Alarma desactivada.';
  });
  test.addEventListener('click', () => { if (!ringing && !showTest()) activate(true); });
  document.getElementById('heatAlarmDismiss').addEventListener('click', dismiss);
  stopButton.addEventListener('click', dismiss);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    keepScreenOn();
    window.dispatchEvent(new Event('go-heat-alarm-ready'));
  });
  function update(data) {
    latest = data;
    panel.hidden = !data.hasRace && !ringing;
    if (!enabled) return;
    if (context?.state !== 'running') {
      enabled = false; controls();
      status.textContent = 'El sonido se ha pausado. Toca Activar alarma para reactivarlo.';
      return;
    }
    status.textContent = ringing ? 'Alarma sonando · pulsa Parar alarma para detenerla.' : data.status;
    if (!data.running || !data.target || document.visibilityState !== 'visible') return;
    const key = data.target.key;
    try { for (const previous of JSON.parse(localStorage.getItem(storageKey) || '[]')) seen.add(previous); } catch {}
    if (seen.has(key)) return;
    if (!ringing && !sound()) return;
    seen.add(key);
    seen = new Set([...seen].slice(-150));
    try { localStorage.setItem(storageKey, JSON.stringify([...seen])); } catch {}
    message.textContent = '¡Jorge Atienza, prepara tu salida! Ha empezado la manga anterior. Tu próxima salida: ' + data.target.label + '.';
    notice.hidden = false;
    status.textContent = 'Aviso emitido · ' + data.target.label;
  }
  window.GoHeatAlarm = { update };
  controls();
})();
