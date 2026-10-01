const STORAGE_KEY = 'e-rechnung-settings-v3';

export const COMPANY_KEYS = ['name', 'street', 'zipCity', 'vatId', 'iban', 'bic', 'email'];

export const DEFAULT_COMPANY = {
  name: '',
  street: '',
  zipCity: '',
  vatId: '',
  iban: '',
  bic: '',
  email: '',
};

export const DEFAULT_SETTINGS = {
  saveMode: 'auto',
  company: { ...DEFAULT_COMPANY },
};

export function loadSettings() {
  const out = {
    saveMode: DEFAULT_SETTINGS.saveMode,
    company: { ...DEFAULT_COMPANY },
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw);
    if (parsed.saveMode) out.saveMode = parsed.saveMode;
    if (parsed.company && typeof parsed.company === 'object') {
      out.company = { ...DEFAULT_COMPANY, ...parsed.company };
    }
  } catch (_) {}
  return out;
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        saveMode: settings.saveMode || 'auto',
        company: { ...DEFAULT_COMPANY, ...(settings.company || {}) },
      })
    );
  } catch (_) {}
}

export function getSaveMode(settings) {
  return (settings && settings.saveMode) || 'auto';
}

export function companyToTxt(company) {
  const c = company || {};
  const lines = ['# E-Rechnung Firmendaten'];
  for (const key of COMPANY_KEYS) {
    const val = c[key] == null ? '' : String(c[key]);
    lines.push(`${key}=${val}`);
  }
  return lines.join('\n') + '\n';
}

export function parseCompanyTxt(text) {
  const out = { ...DEFAULT_COMPANY };
  const keyMap = Object.fromEntries(COMPANY_KEYS.map((k) => [k.toLowerCase(), k]));
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const rawKey = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();
    const key = keyMap[rawKey];
    if (key) out[key] = value;
  }
  return out;
}

export function exportCompanyFilename() {
  return 'e-rechnung-firmendaten.txt';
}
