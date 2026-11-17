(() => {
  const OCR_SCRIPT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const OCR_WORKER = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js';
  const OCR_CORE = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1';
  const OCR_LANG = 'https://tessdata.projectnaptha.com/4.0.0';
  const PDFJS_MODULE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs';
  const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs';
  const XLSX_SCRIPT = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  let ocrScriptPromise = null;
  let pdfModulePromise = null;
  let xlsxScriptPromise = null;

  function text(value) { return String(value ?? '').trim(); }
  function normalized(value) {
    return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  }
  function numberToken(value) {
    return text(value).toUpperCase().replace(/[ILO|]/g, '1').replace(/[^0-9]/g, '');
  }
  function timeValue(value) {
    let input = text(value).toUpperCase().replace(/[OQ]/g, '0').replace(/[ILO|]/g, '1').replace(/[.,]/g, ':').replace(/\s/g, '');
    const match = input.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return '';
    const hour = Number(match[1]), minute = Number(match[2]);
    if (hour > 23 || minute > 59) return '';
    return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
  }
  function parseSessionTitle(words) {
    const tokens = words.map(word => normalized(word.text)).filter(Boolean);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const next = tokens[index + 1] || '';
      const after = tokens[index + 2] || '';
      const inlineRound = numberToken(token);
      if (/^ENTREN/.test(token) || /^ENTRENO$/.test(token)) {
        if (/^RECOLOC/.test(next)) return { name: 'Entreno recolocado', phaseKey: 'practiceQual', round: 1, wordIndexes: [index, index + 1] };
        if (next === 'LIBRE') return { name: 'Entrenamiento libre', phaseKey: 'practice', round: 1, wordIndexes: [index, index + 1] };
        const round = Number(inlineRound) || Number(numberToken(next));
        return { name: 'Entrenamiento' + (round ? ' ' + round : ''), phaseKey: 'practice', round: round || 1, wordIndexes: [index, ...(round && !inlineRound ? [index + 1] : [])] };
      }
      if (/^RECOLOC/.test(token)) {
        const round = Number(inlineRound) || Number(numberToken(next));
        return { name: 'Recolocación ' + (round || 1), phaseKey: 'seeding', round: round || 1, wordIndexes: [index, ...(round && !inlineRound ? [index + 1] : [])] };
      }
      if (/^CLASIF/.test(token) || /^QUAL/.test(token)) {
        const round = Number(inlineRound) || Number(numberToken(next));
        return { name: (token.startsWith('QUAL') ? 'Qualifier ' : 'Clasificación ') + (round || 1), phaseKey: 'qualifying', round: round || 1, wordIndexes: [index, ...(round && !inlineRound ? [index + 1] : [])] };
      }
      if (/^FINAL/.test(token)) {
        const round = Number(inlineRound) || Number(numberToken(next));
        return { name: 'Final ' + (round || 1), phaseKey: 'finals', round: round || 1, wordIndexes: [index, ...(round && !inlineRound ? [index + 1] : [])] };
      }
      if (/^ENTRENO/.test(token) && /^RECOLOC/.test(after)) return { name: 'Entreno recolocado', phaseKey: 'practiceQual', round: 1, wordIndexes: [index, index + 2] };
    }
    return null;
  }
  function normalizeRunLabel(value) {
    let label = text(value).toUpperCase().replace(/[|]/g, '1').replace(/\b2W0\b/g, '2WD').replace(/\b4W0\b/g, '4WD').replace(/\s+/g, ' ').trim();
    label = label.replace(/\b([24]WD)\s*([G][0-9]+)\b/, '$1 $2');
    const categoryMatch = label.match(/\b(2WD|4WD)\b/);
    if (!categoryMatch) return null;
    const categoryToken = categoryMatch[1];
    const remainder = label.slice(categoryMatch.index + categoryToken.length).trim();
    if (categoryToken === '2WD' && /VINT/.test(remainder)) {
      const afterVintage = remainder.replace(/^.*?VINT[A-Z0-9]*/,'').trim();
      const suffix = afterVintage.replace(/^[^A-Z0-9]*/, '').trim();
      return { category: '2WD Vintage', group: suffix || 'Vintage', label: '2WD Vintage' + (suffix ? ' ' + suffix : '') };
    }
    const group = remainder.replace(/^[^A-Z0-9]*/, '').trim();
    if (!group) return null;
    return { category: categoryToken, group, label: categoryToken + ' ' + group };
  }
  function detectDay(value, fileName, override) {
    const source = normalized(value), file = normalized(fileName);
    if (/DOMINGO|SUNDAY/.test(source)) return 'sunday';
    if (/SABADO|SATURDAY/.test(source)) return 'saturday';
    if (/DOMINGO|SUNDAY/.test(file)) return 'sunday';
    if (/SABADO|SATURDAY/.test(file)) return 'saturday';
    return override === 'saturday' || override === 'sunday' ? override : '';
  }
  function dayLabel(key) { return key === 'sunday' ? 'Domingo' : 'Sábado'; }
  function clockMinutes(value) { const [hour, minute] = value.split(':').map(Number); return hour * 60 + minute; }
  function median(values) {
    const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }
  function box(word) {
    const b = word?.bbox || {};
    const x0 = Number(b.x0 ?? b.left ?? 0), y0 = Number(b.y0 ?? b.top ?? 0);
    const x1 = Number(b.x1 ?? b.right ?? x0), y1 = Number(b.y1 ?? b.bottom ?? y0);
    return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, height: Math.max(1, y1 - y0) };
  }
  function collectWords(data) {
    if (Array.isArray(data?.words) && data.words.length) return data.words.filter(word => text(word.text) && word.bbox);
    const output = [];
    const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
    blocks.forEach(block => (block.paragraphs || []).forEach(paragraph => (paragraph.lines || []).forEach(line => (line.words || []).forEach(word => {
      if (text(word.text) && word.bbox) output.push(word);
    }))));
    return output;
  }
  function clusterRows(words) {
    const sorted = words.map(word => ({ word, ...box(word) })).sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    const tolerance = Math.max(5, median(sorted.map(item => item.height)) * 0.75);
    const rows = [];
    sorted.forEach(item => {
      let row = rows[rows.length - 1];
      if (!row || Math.abs(item.cy - row.cy) > tolerance) {
        row = { cy: item.cy, words: [] };
        rows.push(row);
      }
      row.words.push(item);
      row.cy = row.words.reduce((sum, current) => sum + current.cy, 0) / row.words.length;
    });
    rows.forEach(row => row.words.sort((a, b) => a.cx - b.cx));
    return rows;
  }
  function xColumns(timeWords, tolerance) {
    const columns = [];
    timeWords.map(item => item.cx).sort((a, b) => a - b).forEach(x => {
      let column = columns.find(entry => Math.abs(entry.center - x) <= tolerance);
      if (!column) { column = { center: x, xs: [] }; columns.push(column); }
      column.xs.push(x);
      column.center = column.xs.reduce((sum, value) => sum + value, 0) / column.xs.length;
    });
    return columns.sort((a, b) => a.center - b.center);
  }
  function parseOcrProgram(data, file, dayOverride) {
    const words = collectWords(data).map(word => ({ ...word, clean: text(word.text), ...box(word) })).filter(word => Number(word.confidence ?? word.conf ?? 100) >= 15);
    if (!words.length) throw new Error('No pude reconocer texto en ' + file.name + '. Prueba con una imagen más nítida.');
    const allText = [data?.text || '', ...words.map(word => word.clean)].join(' ');
    const day = detectDay(allText, file.name, dayOverride);
    if (!day) throw new Error('No detecté si la imagen es sábado o domingo. Selecciona el día y vuelve a subirla.');
    const rows = clusterRows(words);
    const headerRows = rows.map((row, index) => ({ ...row, index, headings: [] })).map(row => {
      for (let index = 0; index < row.words.length; index += 1) {
        const heading = parseSessionTitle(row.words.slice(index).map(item => ({ text: item.clean })));
        if (!heading) continue;
        const selectedWords = heading.wordIndexes.map(wordIndex => row.words[index + wordIndex]).filter(Boolean);
        const centerX = selectedWords.length ? selectedWords.reduce((sum, item) => sum + item.cx, 0) / selectedWords.length : row.words[index].cx;
        row.headings.push({ ...heading, centerX });
        index += Math.max(0, heading.wordIndexes.length - 1);
      }
      return row;
    }).filter(row => row.headings.length);
    if (!headerRows.length) throw new Error('No pude localizar los nombres de las sesiones en ' + file.name + '.');
    const timed = rows.flatMap(row => row.words.filter(word => timeValue(word.clean)).map(word => ({ ...word, time: timeValue(word.clean) })));
    const columnTolerance = Math.max(18, median(timed.map(word => word.height)) * 2.2);
    const columns = xColumns(timed, columnTolerance);
    if (!columns.length) throw new Error('No pude leer las horas de ' + file.name + '.');
    const imageRight = Math.max(...words.map(word => word.x1), 1) + 10;
    const sessions = [];
    headerRows.forEach((header, headerIndex) => {
      const nextHeader = headerRows.slice(headerIndex + 1).find(row => row.cy > header.cy + 3);
      const endY = nextHeader?.cy ?? Math.max(...rows.map(row => row.cy)) + columnTolerance;
      header.headings.forEach(heading => {
        const leftColumns = columns.filter(column => column.center < heading.centerX - 2);
        const column = leftColumns[leftColumns.length - 1] || [...columns].sort((a, b) => Math.abs(a.center - heading.centerX) - Math.abs(b.center - heading.centerX))[0];
        if (!column) return;
        const heats = [];
        rows.filter(row => row.cy > header.cy + 3 && row.cy < endY - 2).forEach(row => {
          const rowTimes = row.words.filter(word => timeValue(word.clean)).map(word => ({ ...word, time: timeValue(word.clean) })).sort((a, b) => a.cx - b.cx);
          const timeWord = rowTimes.reduce((best, item) => !best || Math.abs(item.cx - column.center) < Math.abs(best.cx - column.center) ? item : best, null);
          if (!timeWord || Math.abs(timeWord.cx - column.center) > columnTolerance * 1.6) return;
          const nextTime = rowTimes.find(item => item.cx > timeWord.cx + columnTolerance * 0.5);
          const lowerX = timeWord.x1 + Math.max(3, timeWord.height * 0.15), upperX = nextTime?.x0 ?? imageRight;
          const labelText = row.words.filter(word => !timeValue(word.clean) && word.cx > lowerX && word.cx < upperX).map(word => word.clean).join(' ');
          const run = normalizeRunLabel(labelText);
          if (!run) return;
          heats.push({ ...run, time: timeWord.time, order: 0 });
        });
        const unique = new Map();
        heats.forEach(heat => unique.set(heat.time + '|' + heat.label, heat));
        const cleanHeats = [...unique.values()].sort((a, b) => clockMinutes(a.time) - clockMinutes(b.time));
        if (cleanHeats.length < 2) return;
        cleanHeats.forEach((heat, index) => { heat.order = index + 1; });
        sessions.push({ day, name: heading.name, phaseKey: heading.phaseKey, round: heading.round, start: cleanHeats[0].time, heats: cleanHeats });
      });
    });
    const uniqueSessions = new Map();
    sessions.sort((a, b) => clockMinutes(a.start) - clockMinutes(b.start)).forEach(session => uniqueSessions.set(session.name + '|' + session.start, session));
    const sessionList = [...uniqueSessions.values()];
    if (!sessionList.length) throw new Error('He encontrado la foto, pero no pude extraer sus salidas. Prueba a subirla en mayor resolución o como CSV.');
    return { key: day, label: dayLabel(day), sessions: sessionList, notes: [] };
  }
  function csvRows(source) {
    const firstLine = source.split(/\r?\n/, 1)[0] || '';
    const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : (firstLine.includes('\t') ? '\t' : ',');
    return source.split(/\r?\n/).filter(line => line.trim()).map(line => {
      const cells = [];
      let cell = '', quoted = false;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '"' && line[index + 1] === '"' && quoted) { cell += '"'; index += 1; }
        else if (char === '"') quoted = !quoted;
        else if (char === delimiter && !quoted) { cells.push(cell.trim()); cell = ''; }
        else cell += char;
      }
      cells.push(cell.trim());
      return cells;
    });
  }
  function columnIndex(headers, names) { return headers.findIndex(header => names.includes(normalized(header).replace(/ /g, ''))); }
  function parseCsvProgram(source, file, dayOverride) {
    const rows = csvRows(source);
    if (rows.length < 2) throw new Error('El CSV no contiene filas de horario.');
    const headers = rows[0];
    const dayIndex = columnIndex(headers, ['DIA', 'DAY', 'JORNADA']);
    const sessionIndex = columnIndex(headers, ['SESION', 'SESSION', 'FASE', 'QUALIFIER']);
    const timeIndex = columnIndex(headers, ['HORA', 'TIME', 'INICIO']);
    const categoryIndex = columnIndex(headers, ['CATEGORIA', 'CATEGORY']);
    const groupIndex = columnIndex(headers, ['GRUPO', 'GROUP', 'SERIE', 'SERIES']);
    if ([sessionIndex, timeIndex, categoryIndex].some(index => index < 0)) throw new Error('El CSV necesita columnas: sesión, hora y categoría; grupo es opcional.');
    const grouped = new Map();
    rows.slice(1).forEach(row => {
      const sessionTitle = text(row[sessionIndex]), time = timeValue(row[timeIndex]);
      const run = normalizeRunLabel([row[categoryIndex], row[groupIndex] || ''].filter(Boolean).join(' '));
      const day = detectDay(row[dayIndex] || '', file.name, dayOverride);
      if (!sessionTitle || !time || !run || !day) return;
      const heading = parseSessionTitle(sessionTitle.split(/\s+/).map(token => ({ text: token })));
      const parsedHeading = heading || { name: sessionTitle, phaseKey: 'other', round: 1 };
      const key = [day, parsedHeading.name].join('|');
      if (!grouped.has(key)) grouped.set(key, { day, name: parsedHeading.name, phaseKey: parsedHeading.phaseKey, round: parsedHeading.round, start: time, heats: [] });
      grouped.get(key).heats.push({ ...run, time, order: 0 });
    });
    const days = new Map();
    [...grouped.values()].forEach(session => {
      const unique = new Map();
      session.heats.forEach(heat => unique.set(heat.time + '|' + heat.label, heat));
      session.heats = [...unique.values()].sort((a, b) => clockMinutes(a.time) - clockMinutes(b.time));
      session.heats.forEach((heat, index) => { heat.order = index + 1; });
      session.start = session.heats[0]?.time || session.start;
      const day = days.get(session.day) || { key: session.day, label: dayLabel(session.day), sessions: [], notes: [] };
      day.sessions.push(session);
      days.set(session.day, day);
    });
    if (!days.size) throw new Error('No encontré filas válidas. Revisa las columnas del CSV y el día.');
    return { days: [...days.values()].map(day => ({ ...day, sessions: day.sessions.sort((a, b) => clockMinutes(a.start) - clockMinutes(b.start)) })) };
  }
  function spreadsheetTime(value) {
    const direct = timeValue(value);
    if (direct) return direct;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric >= 1) return '';
    const minutes = Math.round(numeric * 1440);
    return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
  }
  function parseSpreadsheetProgram(rows, file, dayOverride, sheetName = '') {
    const grid = (rows || []).map(row => Array.isArray(row) ? row.map(text) : []).filter(row => row.some(Boolean));
    if (grid.length < 2) throw new Error('La hoja «' + sheetName + '» no contiene filas de calendario.');
    const explicitDay = dayOverride === 'saturday' || dayOverride === 'sunday' ? dayOverride : '';
    let activeDay = detectDay(sheetName, file.name, '');
    const sections = [];
    grid.forEach((row, rowIndex) => {
      const rowDay = detectDay(row.join(' '), '', '');
      if (rowDay) activeDay = rowDay;
      const timeColumns = row.map((value, index) => ['HORA', 'TIME', 'HOUR', 'INICIO'].includes(normalized(value).replace(/ /g, '')) ? index : -1).filter(index => index >= 0);
      row.forEach((value, columnIndex) => {
        const heading = parseSessionTitle(text(value).split(/\s+/).map(token => ({ text: token })));
        if (!heading) return;
        const timeColumn = timeColumns.filter(index => index < columnIndex).at(-1);
        if (timeColumn === undefined) return;
        const nextTimeColumn = timeColumns.find(index => index > timeColumn);
        const endColumn = nextTimeColumn ?? row.length;
        const day = rowDay || activeDay || detectDay('', file.name, explicitDay);
        sections.push({ rowIndex, timeColumn, endColumn, day, heading });
      });
    });
    if (!sections.length) throw new Error('No encontré encabezados de sesión en la hoja «' + sheetName + '».');
    const sessions = [];
    sections.forEach(section => {
      if (!section.day) throw new Error('No detecté el día en la hoja «' + sheetName + '». Selecciónalo en «Día si la página no lo indica».');
      const nextSection = sections.find(other => other.rowIndex > section.rowIndex && other.timeColumn === section.timeColumn);
      const endRow = nextSection?.rowIndex ?? grid.length;
      const heats = [];
      for (let rowIndex = section.rowIndex + 1; rowIndex < endRow; rowIndex += 1) {
        const row = grid[rowIndex], time = spreadsheetTime(row[section.timeColumn]);
        if (!time) continue;
        const label = row.slice(section.timeColumn + 1, section.endColumn).join(' '), run = normalizeRunLabel(label);
        if (run) heats.push({ ...run, time, order: 0 });
      }
      const unique = new Map();
      heats.forEach(heat => unique.set([heat.time, normalized(heat.category), normalized(heat.group)].join('|'), heat));
      const cleanHeats = [...unique.values()].sort((a, b) => clockMinutes(a.time) - clockMinutes(b.time));
      if (!cleanHeats.length) return;
      cleanHeats.forEach((heat, index) => { heat.order = index + 1; });
      sessions.push({ day: section.day, name: section.heading.name, phaseKey: section.heading.phaseKey, round: section.heading.round, start: cleanHeats[0].time, heats: cleanHeats });
    });
    const days = new Map();
    sessions.forEach(session => {
      const day = days.get(session.day) || { key: session.day, label: dayLabel(session.day), sessions: [], notes: [] };
      day.sessions.push(session); days.set(session.day, day);
    });
    if (!days.size) throw new Error('No encontré horarios con hora y categoría en la hoja «' + sheetName + '».');
    return { days: [...days.values()].map(day => ({ ...day, sessions: day.sessions.sort((a, b) => clockMinutes(a.start) - clockMinutes(b.start)) })) };
  }
  function normalizeJsonProgram(value, file, dayOverride) {
    const input = value?.program || value;
    if (Array.isArray(input)) return parseCsvProgram(arrayToCsv(input), file, dayOverride);
    if (!Array.isArray(input?.days)) throw new Error('El JSON necesita una lista «days» con sesiones y salidas.');
    const days = input.days.map(day => {
      const key = day.key === 'saturday' || day.key === 'sunday' ? day.key : detectDay(day.label || day.name || '', file.name, dayOverride);
      if (!key) return null;
      const sessions = (day.sessions || []).map(session => {
        const heading = parseSessionTitle(text(session.name).split(/\s+/).map(token => ({ text: token }))) || { name: text(session.name), phaseKey: session.phaseKey || 'other', round: Number(session.round) || 1 };
        const heats = (session.heats || []).map((heat, index) => {
          const time = timeValue(heat.time || heat.start), run = normalizeRunLabel([heat.label || heat.category, heat.group].filter(Boolean).join(' '));
          return time && run ? { ...run, time, order: Number(heat.order) || index + 1 } : null;
        }).filter(Boolean);
        return heats.length ? { name: heading.name, phaseKey: session.phaseKey || heading.phaseKey, round: Number(session.round) || heading.round, start: heats[0].time, heats } : null;
      }).filter(Boolean);
      return sessions.length ? { key, label: dayLabel(key), sessions, notes: Array.isArray(day.notes) ? day.notes.map(text) : [] } : null;
    }).filter(Boolean);
    if (!days.length) throw new Error('El JSON no contiene jornadas con salidas válidas.');
    return { days };
  }
  function arrayToCsv(rows) {
    const headers = ['dia', 'sesion', 'hora', 'categoria', 'grupo'];
    const output = [headers.join(',')];
    rows.forEach(row => output.push([row.day || row.dayKey || '', row.session || row.sessionName || '', row.time || '', row.category || '', row.group || ''].map(value => '"' + text(value).replace(/"/g, '""') + '"').join(',')));
    return output.join('\n');
  }
  function mergePrograms(previous, additions, title) {
    const map = new Map();
    const addDay = (day, replace = false) => {
      const prior = map.get(day.key);
      if (!prior || replace) { map.set(day.key, { ...day, sessions: [...(day.sessions || [])] }); return; }
      const sessions = new Map((prior.sessions || []).map(session => [[session.phaseKey, session.round, normalized(session.name)].join('|'), { ...session, heats: [...(session.heats || [])] }]));
      (day.sessions || []).forEach(session => {
        const key = [session.phaseKey, session.round, normalized(session.name)].join('|'), current = sessions.get(key);
        if (!current) { sessions.set(key, { ...session, heats: [...(session.heats || [])] }); return; }
        const heats = new Map((current.heats || []).map(heat => [[normalized(heat.category), normalized(heat.group)].join('|'), heat]));
        (session.heats || []).forEach(heat => heats.set([normalized(heat.category), normalized(heat.group)].join('|'), heat));
        current.heats = [...heats.values()].sort((a, b) => clockMinutes(a.time) - clockMinutes(b.time));
        current.start = current.heats[0]?.time || current.start;
        sessions.set(key, current);
      });
      map.set(day.key, { ...prior, ...day, sessions: [...sessions.values()].sort((a, b) => clockMinutes(a.start) - clockMinutes(b.start)) });
    };
    (previous?.days || []).forEach(day => addDay(day));
    (additions?.days || []).forEach(day => addDay(day));
    const days = [...map.values()].sort((a, b) => (a.key === 'saturday' ? -1 : 1) - (b.key === 'saturday' ? -1 : 1));
    const totalHeats = days.reduce((sum, day) => sum + (day.sessions || []).reduce((part, session) => part + (session.heats || []).length, 0), 0);
    return { id: 'calendar-' + Date.now(), title: title || 'Horario de carrera', source: 'CALENDARIO CARGADO', days, totalHeats };
  }
  async function loadOcrLibrary() {
    if (window.Tesseract) return window.Tesseract;
    if (!ocrScriptPromise) ocrScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = OCR_SCRIPT;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('No pude iniciar el lector de fotos.'));
      script.onerror = () => reject(new Error('No se pudo cargar el lector de fotos. Comprueba la conexión e inténtalo de nuevo.'));
      document.head.appendChild(script);
    });
    return ocrScriptPromise;
  }
  async function loadPdfLibrary() {
    if (!pdfModulePromise) pdfModulePromise = import(PDFJS_MODULE).then(pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return pdfjs;
    }).catch(() => { pdfModulePromise = null; throw new Error('No se pudo abrir el PDF. Prueba con una foto o exporta sus páginas como imagen.'); });
    return pdfModulePromise;
  }
  async function loadXlsxLibrary() {
    if (window.XLSX) return window.XLSX;
    if (!xlsxScriptPromise) xlsxScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = XLSX_SCRIPT; script.async = true; script.crossOrigin = 'anonymous';
      script.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error('No se pudo iniciar el lector de Excel.'));
      script.onerror = () => reject(new Error('No se pudo cargar el lector de Excel. Comprueba la conexión e inténtalo de nuevo.'));
      document.head.appendChild(script);
    });
    return xlsxScriptPromise;
  }
  async function openPdf(file) {
    const pdfjs = await loadPdfLibrary();
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    if (pdf.numPages > 16) { await pdf.destroy(); throw new Error('El PDF tiene más de 16 páginas. Sube las páginas del calendario en grupos más pequeños.'); }
    return pdf;
  }
  async function renderPdfPage(pdf, pageNumber) {
    const page = await pdf.getPage(pageNumber), base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.2, 2200 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale: Math.max(1.2, scale) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d', { willReadFrequently: true }), viewport }).promise;
    return canvas;
  }
  function readTextFile(file) {
    if (typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '')); reader.onerror = () => reject(new Error('No pude leer ' + file.name + '.')); reader.readAsText(file); });
  }
  async function importFiles(files, options = {}) {
    const input = [...files].filter(Boolean);
    if (!input.length) throw new Error('Selecciona una foto, CSV o JSON.');
    if (input.some(file => file.size > 20 * 1024 * 1024)) throw new Error('Cada archivo debe pesar menos de 20 MB.');
    const additions = { days: [] }, imageFiles = input.filter(file => file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name)), pdfFiles = input.filter(file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name)), spreadsheetFiles = input.filter(file => /\.(xlsx|xls)$/i.test(file.name) || /spreadsheetml|ms-excel/i.test(file.type));
    const textFiles = input.filter(file => !imageFiles.includes(file) && !pdfFiles.includes(file) && !spreadsheetFiles.includes(file));
    if (spreadsheetFiles.length) {
      const XLSX = await loadXlsxLibrary();
      for (const file of spreadsheetFiles) {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
        for (const sheetName of workbook.SheetNames) {
          const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '', blankrows: false });
          const program = parseSpreadsheetProgram(rows, file, options.dayOverride, sheetName);
          additions.days.push(...program.days);
        }
      }
    }
    for (const file of textFiles) {
      if (!/\.(csv|tsv|json)$/i.test(file.name) && !/json|csv|tab-separated/i.test(file.type)) throw new Error('Formato no compatible: ' + file.name + '. Sube un PDF, una foto, CSV o JSON.');
      const content = await readTextFile(file);
      const program = /\.json$/i.test(file.name) || /json/i.test(file.type)
        ? normalizeJsonProgram(JSON.parse(content), file, options.dayOverride)
        : parseCsvProgram(content, file, options.dayOverride);
      additions.days.push(...program.days);
    }
    if (imageFiles.length || pdfFiles.length) {
      options.onProgress?.('Preparando lectura de las fotos…');
      const Tesseract = await loadOcrLibrary();
      const pdfDocuments = [];
      for (const file of pdfFiles) pdfDocuments.push({ file, pdf: await openPdf(file) });
      const totalPages = imageFiles.length + pdfDocuments.reduce((sum, item) => sum + item.pdf.numPages, 0);
      let fileIndex = 0;
      const worker = await Tesseract.createWorker('eng+spa', 1, {
        workerPath: OCR_WORKER,
        corePath: OCR_CORE,
        langPath: OCR_LANG,
        logger: message => {
          if (message.status === 'recognizing text') options.onProgress?.('Leyendo página ' + (fileIndex + 1) + ' de ' + totalPages + ' · ' + Math.round((message.progress || 0) * 100) + '%');
          else if (message.status === 'loading language traineddata') options.onProgress?.('Cargando reconocimiento de texto…');
          else if (message.status === 'loading tesseract core') options.onProgress?.('Preparando reconocimiento de texto…');
        },
      });
      try {
        const readImage = async(image, file, pageOverride) => {
          fileIndex += 1;
          options.onProgress?.('Leyendo página ' + fileIndex + ' de ' + totalPages + '…');
          const result = await worker.recognize(image, {}, { blocks: true });
          const day = parseOcrProgram(result.data, file, pageOverride);
          additions.days.push(day);
          return day.key;
        };
        for (const file of imageFiles) await readImage(file, file, options.dayOverride);
        for (const item of pdfDocuments) {
          let inheritedPdfDay = '';
          try {
            for (let pageNumber = 1; pageNumber <= item.pdf.numPages; pageNumber += 1) {
              const canvas = await renderPdfPage(item.pdf, pageNumber);
              try {
                fileIndex += 1;
                options.onProgress?.('Leyendo página ' + fileIndex + ' de ' + totalPages + '…');
                const result = await worker.recognize(canvas, {}, { blocks: true });
                const detected = detectDay(result.data?.text || '', item.file.name, options.dayOverride);
                const pageOverride = options.dayOverride === 'saturday' || options.dayOverride === 'sunday' ? options.dayOverride : (detected || inheritedPdfDay);
                const day = parseOcrProgram(result.data, item.file, pageOverride);
                inheritedPdfDay = day.key;
                additions.days.push(day);
              } finally { canvas.width = 0; canvas.height = 0; }
            }
          } finally { await item.pdf.destroy(); }
        }
      } finally {
        await worker.terminate();
        for (const item of pdfDocuments) await item.pdf.destroy().catch(() => {});
      }
    }
    if (!additions.days.length) throw new Error('No pude extraer jornadas del archivo.');
    const byDay = new Map();
    additions.days.forEach(day => {
      const current = byDay.get(day.key);
      if (!current) { byDay.set(day.key, day); return; }
      const combined = mergePrograms({ days: [current] }, { days: [day] }).days[0];
      byDay.set(day.key, combined);
    });
    return { days: [...byDay.values()] };
  }
  window.GoScheduleImport = { importFiles, mergePrograms };
})();
