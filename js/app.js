import * as pdfjsLib from '../vendor/pdf.min.mjs';
import {
  loadSettings,
  saveSettings,
  DEFAULT_COMPANY,
  companyToTxt,
  parseCompanyTxt,
  exportCompanyFilename,
} from './settings.js';
import { parseInvoiceText, requiredMissing, emptyInvoice } from './parse.js';
import { buildCiiXml } from './zugferd.js';
import { embedZugferd } from './embed.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../vendor/pdf.worker.min.mjs',
  import.meta.url
).href;

const $ = (sel) => document.querySelector(sel);

const state = {
  settings: loadSettings(),
  profile: 'en16931',
  fileName: '',
  pdfBytes: null,
  invoice: emptyInvoice(),
  resultBlob: null,
  resultName: '',
  xmlText: '',
};

function setStatus(text, kind = '') {
  const el = $('#status');
  if (el) {
    el.textContent = text;
    el.dataset.kind = kind;
  }
  const r = $('#review-status');
  if (r) {
    r.textContent = text;
    r.dataset.kind = kind;
  }
}

function showToast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 3600);
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('SW register failed', err);
    });
  });
}

function syncThemeChrome() {
  const dark =
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const color = dark ? '#1c1c1e' : '#ffffff';
  let live = document.querySelector('meta[name="theme-color"]:not([media])');
  if (!live) {
    live = document.createElement('meta');
    live.name = 'theme-color';
    document.head.insertBefore(live, document.head.firstChild);
  }
  live.setAttribute('content', color);
}

/* ---------- Settings dialog ---------- */

function syncSettingsForm() {
  const s = state.settings;
  const saveMode = $('#settings-save-mode');
  if (saveMode) saveMode.value = s.saveMode || 'auto';
  const c = s.company || DEFAULT_COMPANY;
  const set = (id, v) => {
    const el = $(id);
    if (el) el.value = v || '';
  };
  set('#settings-company-name', c.name);
  set('#settings-company-street', c.street);
  set('#settings-company-zipCity', c.zipCity);
  set('#settings-company-vatId', c.vatId);
  set('#settings-company-iban', c.iban);
  set('#settings-company-bic', c.bic);
  set('#settings-company-email', c.email);
}

function readSettingsFromForm() {
  const saveMode = $('#settings-save-mode');
  if (saveMode) state.settings.saveMode = saveMode.value || 'auto';
  state.settings.company = {
    name: $('#settings-company-name')?.value?.trim() || '',
    street: $('#settings-company-street')?.value?.trim() || '',
    zipCity: $('#settings-company-zipCity')?.value?.trim() || '',
    vatId: $('#settings-company-vatId')?.value?.trim() || '',
    iban: $('#settings-company-iban')?.value?.trim() || '',
    bic: $('#settings-company-bic')?.value?.trim() || '',
    email: $('#settings-company-email')?.value?.trim() || '',
  };
}

function openSettings() {
  const dlg = $('#home-settings-dialog');
  syncSettingsForm();
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function closeSettings() {
  const dlg = $('#home-settings-dialog');
  readSettingsFromForm();
  saveSettings(state.settings);
  if (typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
}

/* ---------- PDF text extract ---------- */

async function extractPdfText(bytes) {
  const loadingTask = pdfjsLib.getDocument({ data: bytes.slice() });
  const pdf = await loadingTask.promise;
  const parts = [];
  const Y_JUMP = 3; // PDF units — new line when vertical gap exceeds this
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const items = (tc.items || []).filter((it) => it && String(it.str || '').length);
    // Reading order: top→bottom (y desc), then left→right (x asc)
    items.sort((a, b) => {
      const ay = a.transform?.[5] ?? 0;
      const by = b.transform?.[5] ?? 0;
      const ax = a.transform?.[4] ?? 0;
      const bx = b.transform?.[4] ?? 0;
      if (Math.abs(by - ay) > Y_JUMP) return by - ay;
      return ax - bx;
    });
    let pageText = '';
    let lastY = null;
    for (const it of items) {
      const y = it.transform?.[5] ?? 0;
      const str = String(it.str || '');
      if (lastY !== null && Math.abs(lastY - y) > Y_JUMP) {
        pageText += '\n';
      } else if (
        pageText.length &&
        !/\s$/.test(pageText) &&
        !/^\s/.test(str) &&
        !pageText.endsWith('\n')
      ) {
        pageText += ' ';
      }
      pageText += str;
      lastY = y;
    }
    parts.push(pageText);
  }
  return parts.join('\n');
}

/* ---------- Review form ---------- */

function partyToForm(prefix, party) {
  const p = party || {};
  const set = (key, val) => {
    const el = $(`#f-${prefix}-${key}`);
    if (el) el.value = val || '';
  };
  set('name', p.name);
  set('street', p.street);
  set('zipCity', p.zipCity);
  set('country', p.country || 'DE');
  set('vatId', p.vatId);
  set('taxNumber', p.taxNumber);
  if (prefix === 'seller') {
    set('iban', p.iban);
    set('bic', p.bic);
    set('email', p.email);
  }
}

function partyFromForm(prefix) {
  const get = (key) => $(`#f-${prefix}-${key}`)?.value?.trim() || '';
  const out = {
    name: get('name'),
    street: get('street'),
    zipCity: get('zipCity'),
    country: get('country') || 'DE',
    vatId: get('vatId'),
    taxNumber: get('taxNumber'),
    iban: '',
    bic: '',
    email: '',
  };
  if (prefix === 'seller') {
    out.iban = get('iban');
    out.bic = get('bic');
    out.email = get('email');
  }
  return out;
}

function renderLines(lines) {
  const host = $('#lines-host');
  if (!host) return;
  const rows = lines && lines.length ? lines : [];
  if (!rows.length) {
    host.innerHTML = '<p class="hint">Keine Positionen erkannt – optional hinzufügen.</p>';
    return;
  }
  host.innerHTML =
    `<div class="lines-scroll"><table class="lines-table"><thead><tr>` +
    `<th class="col-qty">Menge</th><th class="col-name">Bezeichnung</th>` +
    `<th class="col-price">Einzelpreis</th><th class="col-vat">MwSt%</th>` +
    `<th class="col-sum">Summe</th><th class="col-rm"></th>` +
    `</tr></thead><tbody>` +
    rows
      .map(
        (l, i) =>
          `<tr data-i="${i}">` +
          `<td class="col-qty"><input data-k="qty" inputmode="decimal" value="${escAttr(l.qty)}" /></td>` +
          `<td class="col-name"><textarea data-k="name" rows="2">${escHtml(l.name)}</textarea></td>` +
          `<td class="col-price"><input data-k="unitPrice" inputmode="decimal" value="${escAttr(l.unitPrice)}" /></td>` +
          `<td class="col-vat"><input data-k="vatPercent" inputmode="decimal" value="${escAttr(l.vatPercent)}" /></td>` +
          `<td class="col-sum"><input data-k="lineTotal" inputmode="decimal" value="${escAttr(l.lineTotal)}" /></td>` +
          `<td class="col-rm"><button type="button" class="btn btn-text btn-rm-line" data-i="${i}">×</button></td>` +
          `</tr>`
      )
      .join('') +
    `</tbody></table></div>`;
  host.querySelectorAll('.btn-rm-line').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i);
      state.invoice.lines = linesFromDom();
      state.invoice.lines.splice(i, 1);
      renderLines(state.invoice.lines);
      highlightMissing(readReviewForm());
    });
  });
}

function escAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function linesFromDom() {
  const rows = [...document.querySelectorAll('#lines-host tbody tr')];
  return rows.map((tr) => {
    const get = (k) =>
      tr.querySelector(`input[data-k="${k}"], textarea[data-k="${k}"]`)?.value?.trim() || '';
    return {
      qty: get('qty'),
      name: get('name'),
      unitPrice: get('unitPrice'),
      vatPercent: get('vatPercent'),
      lineTotal: get('lineTotal'),
    };
  });
}

function fillReviewForm(inv) {
  $('#f-invoiceNumber').value = inv.invoiceNumber || '';
  $('#f-issueDate').value = inv.issueDate || '';
  $('#f-dueDate').value = inv.dueDate || '';
  $('#f-deliveryDate').value = inv.deliveryDate || '';
  $('#f-currency').value = inv.currency || 'EUR';
  partyToForm('seller', inv.seller);
  partyToForm('buyer', inv.buyer);
  $('#f-net').value = inv.net || '';
  $('#f-vatRate').value = inv.vatRate || '';
  $('#f-vatAmount').value = inv.vatAmount || '';
  $('#f-gross').value = inv.gross || '';
  renderLines(inv.lines || []);
  highlightMissing(inv);
}

function readReviewForm() {
  const inv = emptyInvoice();
  inv.invoiceNumber = $('#f-invoiceNumber')?.value?.trim() || '';
  inv.issueDate = $('#f-issueDate')?.value?.trim() || '';
  inv.dueDate = $('#f-dueDate')?.value?.trim() || '';
  inv.deliveryDate = $('#f-deliveryDate')?.value?.trim() || '';
  inv.currency = $('#f-currency')?.value?.trim() || 'EUR';
  inv.seller = partyFromForm('seller');
  inv.buyer = partyFromForm('buyer');
  inv.net = $('#f-net')?.value?.trim() || '';
  inv.vatRate = $('#f-vatRate')?.value?.trim() || '';
  inv.vatAmount = $('#f-vatAmount')?.value?.trim() || '';
  inv.gross = $('#f-gross')?.value?.trim() || '';
  inv.lines = linesFromDom();
  return inv;
}

function highlightMissing(inv) {
  const miss = requiredMissing(inv);
  const map = {
    invoiceNumber: '#f-invoiceNumber',
    issueDate: '#f-issueDate',
    dueDate: '#f-dueDate',
    currency: '#f-currency',
    'seller.name': '#f-seller-name',
    'seller.street': '#f-seller-street',
    'seller.zipCity': '#f-seller-zipCity',
    'seller.country': '#f-seller-country',
    'seller.vatId': '#f-seller-vatId',
    'buyer.name': '#f-buyer-name',
    'buyer.street': '#f-buyer-street',
    'buyer.zipCity': '#f-buyer-zipCity',
    'buyer.country': '#f-buyer-country',
    gross: '#f-gross',
  };
  document
    .querySelectorAll('.review-card input.is-missing, .review-card textarea.is-missing')
    .forEach((el) => {
      el.classList.remove('is-missing');
    });
  document.querySelectorAll('.review-card.is-missing').forEach((el) => {
    el.classList.remove('is-missing');
  });
  for (const key of miss) {
    if (key === 'lines') {
      $('#card-lines')?.classList.add('is-missing');
      continue;
    }
    const sel = map[key];
    if (!sel) continue;
    const el = $(sel);
    if (el) {
      el.classList.add('is-missing');
      el.closest('.review-card')?.classList.add('is-missing');
    }
  }
  const hint = $('#missing-hint');
  if (hint) {
    if (miss.length) {
      hint.hidden = false;
      hint.textContent =
        'Pflichtfelder fehlen (markiert). Erzeugen ist möglich nach Bestätigung.';
    } else {
      hint.hidden = true;
      hint.textContent = '';
    }
  }
  return miss;
}

function hideResult() {
  state.resultBlob = null;
  state.resultName = '';
  state.xmlText = '';
  $('#result-card')?.classList.add('hidden');
}

function showHome() {
  hideResult();
  $('#home')?.classList.remove('hidden');
  $('#review')?.classList.add('hidden');
}

function showReview() {
  $('#home')?.classList.add('hidden');
  $('#review')?.classList.remove('hidden');
}

function profileLabel(v) {
  const map = {
    en16931: 'EN 16931 (Comfort)',
    xrechnung: 'XRechnung',
    basic: 'BASIC',
    minimum: 'MINIMUM',
  };
  return map[v] || v;
}

function applyCompanyFallback(inv) {
  const c = state.settings.company || DEFAULT_COMPANY;
  const companyName = String(c.name || '').trim();
  const seller = inv.seller || (inv.seller = {});
  const buyer = inv.buyer || (inv.buyer = {});
  const companyNameLower = companyName.toLowerCase();
  const companyPrefix = companyNameLower.slice(0, 12);
  const companyToken = companyNameLower.split(/\s+/)[0];
  const nameHit = (partyName) => {
    const name = String(partyName || '').trim().toLowerCase();
    return Boolean(
      companyName &&
        name &&
        (name === companyNameLower || name.includes(companyPrefix) || name.includes(companyToken))
    );
  };
  const preferFullCompanyName = (party, isCompany) => {
    if (isCompany && companyName && companyName.length > String(party.name || '').trim().length) {
      party.name = companyName;
    }
  };
  const fillCompanyAddress = (party) => {
    party.street = party.street || c.street || '';
    party.zipCity = party.zipCity || c.zipCity || '';
    party.vatId = party.vatId || c.vatId || '';
    if (c.taxNumber) party.taxNumber = party.taxNumber || c.taxNumber;
  };

  // Outgoing: our company is already the seller → never force it into buyer.
  const sellerIsCompany = nameHit(seller.name);
  const buyerIsCompany = nameHit(buyer.name);
  preferFullCompanyName(seller, sellerIsCompany);
  preferFullCompanyName(buyer, buyerIsCompany);
  const textHasCompany = sellerIsCompany || buyerIsCompany;

  if (!buyer.name && companyName && !sellerIsCompany) {
    buyer.name = companyName;
    fillCompanyAddress(buyer);
  } else if (!seller.name && companyName && !textHasCompany) {
    seller.name = companyName;
    fillCompanyAddress(seller);
    seller.iban = seller.iban || c.iban || '';
    seller.bic = seller.bic || c.bic || '';
    seller.email = seller.email || c.email || '';
  }

  if (sellerIsCompany) {
    // Footer images may hide these values from PDF text; complete only blanks.
    fillCompanyAddress(seller);
    seller.iban = seller.iban || c.iban || '';
    seller.bic = seller.bic || c.bic || '';
    const sellerEmail = String(seller.email || '').trim();
    if (!sellerEmail || (/^info@beak-electronic\.de$/i.test(sellerEmail) && c.email)) {
      seller.email = c.email || seller.email || '';
    }
  } else {
    // Keep the existing fallback for invoices whose seller is not our company.
    if (!seller.iban && c.iban) seller.iban = c.iban;
    if (!seller.bic && c.bic) seller.bic = c.bic;
  }
  return inv;
}

/* ---------- File handling ---------- */

async function handlePdfFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    showToast('Bitte eine PDF-Datei wählen');
    return;
  }
  setStatus('PDF wird gelesen…');
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    state.pdfBytes = bytes;
    state.fileName = file.name;
    state.profile = $('#profile')?.value || 'en16931';
    hideResult();

    const text = await extractPdfText(bytes);
    let inv = parseInvoiceText(text, {
      companyName: state.settings.company?.name || '',
    });
    inv = applyCompanyFallback(inv);
    state.invoice = inv;

    $('#file-chip').textContent = file.name;
    $('#profile-chip').textContent = `Profil: ${profileLabel(state.profile)}`;
    fillReviewForm(inv);
    showReview();
    setStatus('Felder prüfen und ggf. korrigieren');
  } catch (err) {
    console.error(err);
    setStatus('Fehler beim Lesen der PDF', 'error');
    showToast('PDF konnte nicht gelesen werden');
  }
}

/* ---------- Save / share ---------- */

function canSharePdfFile(file) {
  if (typeof navigator.share !== 'function') return false;
  if (typeof navigator.canShare !== 'function') return true;
  try {
    return navigator.canShare({ files: [file] });
  } catch (_) {
    return false;
  }
}

function preferDownloadSave() {
  const saveMode = state.settings.saveMode || 'auto';
  if (saveMode === 'download') return true;
  if (saveMode === 'share') return false;
  const ua = navigator.userAgent || '';
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isMacSafari = /Macintosh/.test(ua) && !isIOS;
  return isMacSafari || (!isIOS && !/Android/i.test(ua));
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function finishSaveBlob(blob, name) {
  const file = new File([blob], name, { type: 'application/pdf' });

  if (preferDownloadSave()) {
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        showToast('PDF gespeichert');
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') {
          showToast('Speichern abgebrochen');
          return;
        }
        console.warn('showSaveFilePicker failed', err);
      }
    }
    downloadBlob(blob, name);
    showToast('Download gestartet');
    return;
  }

  if (canSharePdfFile(file)) {
    try {
      await navigator.share({ files: [file] });
      showToast('Über Teilen-Menü gespeichert');
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        showToast('Speichern abgebrochen');
        return;
      }
      console.warn('navigator.share failed', err);
    }
  }

  downloadBlob(blob, name);
  showToast('Download gestartet');
}

async function generateZugferd() {
  const inv = readReviewForm();
  state.invoice = inv;
  const miss = highlightMissing(inv);
  const hard = miss.filter((k) =>
    ['invoiceNumber', 'issueDate', 'seller.name', 'buyer.name', 'gross'].includes(k)
  );
  if (hard.length) {
    const ok = window.confirm(
      'Es fehlen Pflichtfelder (Nummer, Datum, Verkäufer, Käufer und/oder Brutto).\nTrotzdem ZUGFeRD erzeugen?'
    );
    if (!ok) return;
  }

  if (!state.pdfBytes) {
    showToast('Kein PDF geladen');
    return;
  }

  setStatus('ZUGFeRD wird erzeugt…');
  $('#btn-generate').disabled = true;
  try {
    const xml = buildCiiXml(inv, state.profile);
    const outBytes = await embedZugferd(state.pdfBytes, xml, state.profile);
    const stem = (state.fileName || 'rechnung').replace(/\.pdf$/i, '');
    const name = `${stem}_zugferd.pdf`;
    const blob = new Blob([outBytes], { type: 'application/pdf' });
    state.resultBlob = blob;
    state.resultName = name;
    state.xmlText = xml;
    const rc = $('#result-card');
    if (rc) {
      rc.classList.remove('hidden');
      const fn = $('#result-filename');
      if (fn) fn.textContent = name;
      rc.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setStatus('ZUGFeRD erzeugt – Datei unten im Fenster speichern');
  } catch (err) {
    console.error(err);
    setStatus('Fehler bei der Erzeugung', 'error');
    showToast(err?.message || 'Erzeugung fehlgeschlagen');
  } finally {
    $('#btn-generate').disabled = false;
  }
}

/* ---------- DnD + UI wire ---------- */

function wireDrop() {
  const btn = $('#btn-drop');
  const input = $('#file-input');
  if (!btn || !input) return;

  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    input.value = '';
    if (f) handlePdfFile(f);
  });

  const prevent = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((ev) => {
    btn.addEventListener(ev, prevent);
  });
  btn.addEventListener('dragenter', () => btn.classList.add('is-over'));
  btn.addEventListener('dragover', () => btn.classList.add('is-over'));
  btn.addEventListener('dragleave', () => btn.classList.remove('is-over'));
  btn.addEventListener('drop', (e) => {
    btn.classList.remove('is-over');
    const f = e.dataTransfer?.files?.[0];
    if (f) handlePdfFile(f);
  });
}

function wireUi() {
  $('#btn-home-settings')?.addEventListener('click', openSettings);
  $('#btn-home-settings-done')?.addEventListener('click', (e) => {
    e.preventDefault();
    closeSettings();
  });
  $('#home-settings-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    closeSettings();
  });
  $('#btn-company-export')?.addEventListener('click', (e) => {
    e.preventDefault();
    readSettingsFromForm();
    const txt = companyToTxt(state.settings.company);
    downloadBlob(new Blob([txt], { type: 'text/plain;charset=utf-8' }), exportCompanyFilename());
    showToast('Firmendaten exportiert');
  });
  $('#btn-company-import')?.addEventListener('click', (e) => {
    e.preventDefault();
    const input = $('#settings-company-import-file');
    if (!input) return;
    input.value = '';
    input.click();
  });
  $('#settings-company-import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const textContent = await file.text();
      const company = parseCompanyTxt(textContent);
      const saveMode = $('#settings-save-mode');
      if (saveMode) state.settings.saveMode = saveMode.value || 'auto';
      state.settings.company = company;
      saveSettings(state.settings);
      syncSettingsForm();
      showToast('Firmendaten importiert');
    } catch (err) {
      console.warn('company import failed', err);
      showToast('Import fehlgeschlagen');
    } finally {
      e.target.value = '';
    }
  });
  $('#profile')?.addEventListener('change', (e) => {
    state.profile = e.target.value || 'en16931';
  });
  $('#btn-back')?.addEventListener('click', () => {
    state.pdfBytes = null;
    state.invoice = emptyInvoice();
    showHome();
    setStatus('PDF auf den Button ziehen oder tippen');
  });
  $('#btn-generate')?.addEventListener('click', () => generateZugferd());
  $('#btn-download')?.addEventListener('click', async () => {
    if (!state.resultBlob) {
      showToast('Noch keine Datei erzeugt');
      return;
    }
    await finishSaveBlob(state.resultBlob, state.resultName);
  });
  $('#btn-download-xml')?.addEventListener('click', () => {
    if (!state.xmlText) {
      showToast('Noch keine XML erzeugt');
      return;
    }
    const xmlName = (state.resultName || 'rechnung_zugferd.pdf').replace(/\.pdf$/i, '.xml');
    downloadBlob(new Blob([state.xmlText], { type: 'application/xml' }), xmlName);
  });
  $('#btn-add-line')?.addEventListener('click', () => {
    if (!state.invoice.lines) state.invoice.lines = [];
    // sync current edits first
    state.invoice.lines = linesFromDom();
    state.invoice.lines.push({
      qty: '1',
      name: '',
      unitPrice: '0.00',
      vatPercent: '19',
      lineTotal: '0.00',
    });
    renderLines(state.invoice.lines);
    highlightMissing(readReviewForm());
  });

  // live missing highlight
  $('#review')?.addEventListener('input', () => {
    highlightMissing(readReviewForm());
  });

  wireDrop();
}

function init() {
  state.settings = loadSettings();
  syncThemeChrome();
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => syncThemeChrome();
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (_) {}

  setStatus('PDF auf den Button ziehen oder tippen');
  wireUi();
  registerSW();
}

init();
