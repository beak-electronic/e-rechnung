/**
 * Heuristic DE/EN invoice field extraction from PDF text.
 * Language is auto-detected from keywords (Rechnung vs Invoice); one shared parser.
 */

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[●•]/g, ' ')
    .trim();
}

function emptyParty() {
  return {
    name: '',
    street: '',
    zipCity: '',
    country: 'DE',
    vatId: '',
    taxNumber: '',
    iban: '',
    bic: '',
    email: '',
  };
}

export function emptyInvoice() {
  return {
    invoiceNumber: '',
    issueDate: '',
    dueDate: '',
    deliveryDate: '',
    currency: 'EUR',
    seller: emptyParty(),
    buyer: emptyParty(),
    lines: [],
    net: '',
    vatRate: '',
    vatAmount: '',
    gross: '',
  };
}

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

/** Detect invoice language from keywords. Returns 'de' | 'en'. */
export function detectInvoiceLang(text) {
  const t = String(text || '');
  const deScore =
    (/(?:^|\b)Rechnung(?:s|$|\b|-)/im.test(t) ? 2 : 0) +
    (/Rechnungsdatum|Rechnungs-?Nummer|Warennettowert|Umsatzsteuer|Steuerpfl|Zahlungsbedingungen|Fälligkeit|Artikel-Bezeichnung/i.test(
      t
    )
      ? 3
      : 0) +
    (/Nettobetrag|Bruttobetrag|MwSt|USt-Id/i.test(t) ? 1 : 0);
  const enScore =
    (/\bInvoice\b/im.test(t) ? 2 : 0) +
    (/Invoice\s*(?:date|no\.?|number)|Net\s*price|Total\s*amount|\bVAT\s*\d|maturity|Customer\s*no/i.test(
      t
    )
      ? 3
      : 0) +
    (/\bBill\s*to\b|\bNet\s*amount\b/i.test(t) ? 1 : 0);
  if (enScore > deScore) return 'en';
  return 'de';
}

/** Parse German or ISO date → display TT.MM.JJJJ */
export function normalizeDateDisplay(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    let yyyy = m[3];
    if (yyyy.length === 2) yyyy = (parseInt(yyyy, 10) > 70 ? '19' : '20') + yyyy;
    return `${dd}.${mm}.${yyyy}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  return s;
}

/** Display date → CCYYMMDD */
export function dateToCcyymmdd(display) {
  const n = normalizeDateDisplay(display);
  const m = n.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return '';
  return `${m[3]}${m[2]}${m[1]}`;
}

function parseGermanAmount(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/[€\s]/g, '').replace(/EUR/gi, '');
  // 1.234,56 or 9.501,60 → 1234.56
  if (/\d+\.\d{3},\d{2}$/.test(s) || /^\d{1,3}(?:\.\d{3})+,\d{2}$/.test(s) || /^\d+,\d{2}$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+\.\d{2}$/.test(s)) {
    // already dot decimal
  } else if (s.includes(',') && !s.includes('.')) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2);
}

function findIban(text) {
  const labeled = text.match(/IBAN\s*[:.]?\s*([A-Z]{2}\d{2}(?:[\s]?[A-Z0-9]){10,30})/i);
  const m = labeled || text.replace(/\s+/g, ' ').match(/\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30})\b/i);
  if (!m) return '';
  let iban = m[1].replace(/\s+/g, '').toUpperCase();
  if (iban.startsWith('DE') && iban.length > 22) iban = iban.slice(0, 22);
  if (iban.startsWith('DE') && iban.length < 22) return '';
  return iban;
}

function findBic(text) {
  const m =
    text.match(/\bBIC[:\s]*([A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/i) ||
    text.match(/\b([A-Z]{4}DE[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/);
  return m ? m[1].toUpperCase() : '';
}

function findVatId(text) {
  const raw = firstMatch(text, [
    /USt[.\s-]*I\.?d\.?[.\s-]*(?:Nr\.?)?\s*[:.]?\s*((?:DE|AT|NL|FR|IT|BE|LU|PL|CZ|DK|SE|FI|IE|ES|PT|HU|RO|BG|HR|SK|SI|EE|LV|LT|CY|MT|GR)\s?[\d\s]{6,16})/i,
    /VAT\s*(?:ID|No\.?|Number|:)?\s*[:.]?\s*((?:DE|AT|NL|FR|IT|BE|LU|PL|CZ|DK|SE|FI|IE|ES|PT|HU|RO|BG|HR|SK|SI|EE|LV|LT|CY|MT|GR)\s?[\d\s]{6,16})/i,
    /\bVAT\s*:\s*((?:DK|DE|AT|NL|FR|IT|BE)\s?[\d\s]{6,16})/i,
    /\b((?:DK|DE)\s?(?:\d[\s]?){8,12})\b/i,
    /\b(DE\s?\d{9})\b/,
  ]);
  return raw.replace(/\s+/g, '').toUpperCase();
}

function findTaxNumber(text) {
  return firstMatch(text, [
    /Steuernummer\s*[:.]?\s*([\d\s\/]+)/i,
    /St\.?\s*-?\s*Nr\.?\s*[:.]?\s*([\d\s\/]+)/i,
  ])
    .replace(/\s+/g, ' ')
    .trim();
}

function findEmail(text) {
  const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : '';
}

function findZipCity(text) {
  // DK-2830 Virum
  let m = text.match(/\bDK[-\s]?(\d{4})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß\- ]{1,40})/i);
  if (m) return `DK-${m[1]} ${m[2].trim()}`;
  // D-12345 Musterstadt or 12345 Musterstadt
  m = text.match(/\bD[-\s]?(\d{5})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß\- ]{1,40})/i);
  if (m) return `${m[1]} ${m[2].trim()}`;
  m = text.match(/\b(\d{5})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß\- ]{1,40})/);
  if (m) return `${m[1]} ${m[2].trim()}`;
  // CN / intl 6-digit: 100028 Beijing, Chaoyang District (same line only)
  m = text.match(
    /\b(\d{6})[ \t]+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß\-]+(?:[, \t]+[A-Za-zÄÖÜäöüß\-]+){0,8})/
  );
  if (m) return `${m[1]} ${m[2].trim().replace(/[ \t]+/g, ' ')}`;
  return '';
}

function findStreet(text) {
  // Prefer real street names; never treat VAT country+digits (DK 23) as a street
  const candidates = [];
  const patterns = [
    // Musterstraße 1, Beispielweg 12
    /\b((?:[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\- ]{2,40}?)\s+(?:Str(?:aße|asse|\.)?|Weg|Platz|Allee|Ring|Gasse)\s*\d+(?:\s*\/\s*\d+)?[a-zA-Z]?)\b/gi,
    // Teknikerbyen 28-40 (street-like token + number range)
    /\b((?:[A-ZÄÖÜ][A-Za-zÄÖÜäöüß]{3,}(?:[\- ][A-Za-zÄÖÜäöüß]+)*)[ \t]+\d+(?:[ \t]*[-–][ \t]*\d+)?)\b/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const s = m[1].trim();
      if (/^(?:DE|DK|AT|NL|FR|IT|BE|SE|FI|PL|CZ)\s*\d/i.test(s)) continue;
      if (/^VAT\b/i.test(s)) continue;
      candidates.push(s);
    }
  }
  // Prefer Strasse/Straße matches, then longer tokens with a hyphen range
  candidates.sort((a, b) => {
    const score = (s) =>
      (/Str(?:aße|asse)/i.test(s) ? 100 : 0) +
      (/-|\//.test(s) ? 20 : 0) +
      s.length;
    return score(b) - score(a);
  });
  return candidates[0] || '';
}

/** Parse BEAK pipe header: BEAK | Musterstraße 1 | 12345 Musterstadt | Germany */
function parseBeakPipeHeader(text, companyName = '') {
  const m = text.match(
    /BEAK\s*[^|\n]{0,8}\|\s*([^|\n]+?)\s*\|\s*(\d{5}\s+[^|\n]+?)\s*\|\s*([A-Za-zÄÖÜäöüß ]+)/i
  );
  if (!m) return null;
  const party = emptyParty();
  party.name = String(companyName || '').trim() || 'BEAK';
  party.street = m[1].trim();
  party.zipCity = m[2].trim().replace(/\s+/g, ' ');
  const countryRaw = m[3].trim();
  if (/Germany|Deutschland/i.test(countryRaw)) party.country = 'DE';
  else if (/Denmark|Dänemark/i.test(countryRaw)) party.country = 'DK';
  else if (/^[A-Z]{2}$/i.test(countryRaw)) party.country = countryRaw.toUpperCase();
  return party;
}

/**
 * Extract buyer block that sits under the BEAK header (customer-block style).
 */
function parseBeakBuyerBlock(text) {
  const buyer = emptyParty();
  // Do not inherit emptyParty() default DE — seller header must not imply buyer country
  buyer.country = '';
  // From after BEAK header until Invoice/Rechnung meta block
  const blockMatch = text.match(
    /BEAK[^\n]*\n+([\s\S]{10,500}?)(?=\n\s*(?:Invoice|Rechnung)\b|(?:Invoice\s*date|Rechnungsdatum))/i
  );
  const block = blockMatch ? blockMatch[1] : '';
  if (!block) return buyer;

  const lines = block
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(
      (l) =>
        !/^(?:Shipment|terms of delivery|Versand|Lieferbedingungen|Phone|Fax|Telefon|Telefax|E-?mail|Page|Seite|Contact|Sachbearbeiter|Your contact|Ihr Sachbearbeiter|(?:Commercial\s+)?Invoice\b|Rechnung\b)/i.test(
          l
        )
    );

  const isContactLine = (l) =>
    /^(?:Account Payable|Abt\.|Frau|Herr|Mr\.?\s|Mrs\.?\s|Ms\.?\s|M\s*r\.?\s)/i.test(l);
  const isZipLine = (l) => /^\d{5,6}\b/.test(l) || /^D[K-]\s?\d/i.test(l) || !!findZipCity(l);
  const looksCompany = (l) =>
    /(?:GmbH|A\/S|AG|KG|Ltd|Inc|Oy|AB|Co\.?\s*,?\s*Ltd|International\s+Trade|Trade\s+\w+)/i.test(
      l
    );

  // Company name: first substantial line + optional Ltd/Co. continuation (CN multi-line)
  let nameIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^VAT\b|^USt/i.test(l)) continue;
    if (isZipLine(l)) continue;
    if (isContactLine(l)) continue;
    if (/^Building\b/i.test(l)) continue;
    if (findStreet(l) && !looksCompany(l)) {
      // street-only line — skip for name
      continue;
    }
    if (l.length >= 3 && l.length <= 120) {
      buyer.name = l.slice(0, 120);
      nameIdx = i;
      break;
    }
  }
  // Only merge continuation when first line is incomplete (no Ltd/GmbH yet)
  if (nameIdx >= 0 && nameIdx + 1 < lines.length && !looksCompany(buyer.name)) {
    const next = lines[nameIdx + 1];
    if (
      looksCompany(next) &&
      !isZipLine(next) &&
      !isContactLine(next) &&
      !/^Building\b/i.test(next) &&
      next.length <= 120
    ) {
      buyer.name = `${buyer.name} ${next}`.replace(/\s+/g, ' ').trim().slice(0, 160);
    }
  }

  // Prefer CN/intl building lines; findStreet can false-match across line breaks
  let buildingStreet = '';
  for (const l of lines) {
    if (!l || l === buyer.name || (buyer.name && buyer.name.includes(l))) continue;
    if (isZipLine(l) || isContactLine(l) || /^VAT\b|^USt/i.test(l)) continue;
    if (/Building\b|Real Estate|\bNo\.\s*\d/i.test(l)) {
      buildingStreet = l.slice(0, 120);
      break;
    }
  }
  buyer.street = buildingStreet || findStreet(block) || buyer.street;

  buyer.zipCity = findZipCity(block) || buyer.zipCity;
  buyer.vatId = findVatId(block) || buyer.vatId;
  buyer.email = findEmail(block) || buyer.email;

  if (/\bDK[-\s]?\d{4}\b|Denmark|\bVAT\s*:\s*DK/i.test(block)) buyer.country = 'DK';
  else if (
    /\bChina\b|\bPRC\b|\bBeijing\b|\bShanghai\b|\bGuangzhou\b|Chaoyang|\bCN\b/i.test(
      block
    ) ||
    /\b\d{6}\s+[A-Z]/i.test(block)
  )
    buyer.country = 'CN';
  else if (/Deutschland|Germany|\bD[-\s]?\d{5}\b|\bDE\b/i.test(block)) buyer.country = 'DE';

  return buyer;
}

/**
 * Split text into rough blocks for seller (top) / buyer (middle).
 */
function partyHints(text, companyName, lang) {
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  let seller = emptyParty();
  let buyer = emptyParty();

  const beakSeller = parseBeakPipeHeader(text, companyName);
  if (beakSeller) {
    seller = beakSeller;
    const beakBuyer = parseBeakBuyerBlock(text);
    if (beakBuyer.name) buyer = beakBuyer;
  }

  // Prefer labeled blocks
  const sellerBlock = firstMatch(text, [
    /(?:Absender|Verkäufer|Lieferant|Rechnungssteller|Leistender|From)\s*[:\n]\s*([\s\S]{10,220}?)(?=\n\s*(?:Empfänger|Rechnungsempfänger|Kunde|Bill\s*to|An:)|$)/i,
  ]);
  const buyerBlock = firstMatch(text, [
    /(?:Empfänger|Rechnungsempfänger|Kunde|Käufer|Bill\s*to|Rechnungsadresse)\s*[:\n]\s*([\s\S]{10,220}?)(?=\n\s*(?:Rechnung(?:s(?:nummer|nr|datum)|\s+Nr)|Invoice|USt|Position|Artikel|Summe)|$)/i,
  ]);

  function fillParty(party, block) {
    if (!block) return;
    const blines = block
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!party.name && blines[0] && !/^\d{5}/.test(blines[0])) party.name = blines[0].slice(0, 120);
    party.street = party.street || findStreet(block);
    party.zipCity = party.zipCity || findZipCity(block);
    party.vatId = party.vatId || findVatId(block);
    party.taxNumber = party.taxNumber || findTaxNumber(block);
    party.email = party.email || findEmail(block);
    party.iban = party.iban || findIban(block);
    party.bic = party.bic || findBic(block);
    if (/Denmark|\bDK[-\s]?\d{4}\b|\bVAT\s*:\s*DK/i.test(block)) party.country = 'DK';
    else if (/Deutschland|Germany|\bDE\b|\bD[-\s]?\d{5}\b/i.test(block)) party.country = 'DE';
  }

  if (!beakSeller) fillParty(seller, sellerBlock);
  if (!buyer.name) fillParty(buyer, buyerBlock);

  // Fallback: first non-empty line as seller name if still empty
  if (!seller.name) {
    for (const l of lines.slice(0, 8)) {
      if (/rechnung|invoice|page|seite/i.test(l)) continue;
      if (/^\d/.test(l)) continue;
      if (l.length < 3 || l.length > 80) continue;
      // BEAK pipe without full match
      if (/^BEAK\b/i.test(l)) {
        seller.name = String(companyName || '').trim() || 'BEAK';
        const street = findStreet(l);
        const zip = findZipCity(l);
        if (street) seller.street = street;
        if (zip) seller.zipCity = zip;
        break;
      }
      seller.name = l;
      break;
    }
  }

  // Company name from settings → buyer if present in text (incoming invoice)
  // Skip when BEAK/company is already seller (outgoing)
  const sellerIsCompany =
    companyName &&
    (seller.name || '').toLowerCase().includes(companyName.toLowerCase().slice(0, 12));
  if (
    companyName &&
    !sellerIsCompany &&
    text.toLowerCase().includes(companyName.toLowerCase().slice(0, 20))
  ) {
    if (!buyer.name) buyer.name = companyName;
  }

  // Address hints for unlabeled seller: only search the header (before buyer/meta)
  const headerCut = text.split(
    /(?:Empfänger|Rechnungsempfänger|Bill\s*to|Rechnungsadresse|\bInvoice\b|\bRechnung\b)/i
  )[0] || text.slice(0, 400);
  if (!seller.street) seller.street = findStreet(headerCut) || findStreet(text);
  if (!seller.zipCity) seller.zipCity = findZipCity(headerCut) || findZipCity(text);

  // Global IBAN/BIC/VAT/email often belong to seller (footer)
  if (!seller.iban) seller.iban = findIban(text);
  if (!seller.bic) seller.bic = findBic(text);
  // Prefer buyer DK VAT over stealing it for seller
  const globalVat = findVatId(text);
  if (!seller.vatId && globalVat && !/^DK/i.test(globalVat)) seller.vatId = globalVat;
  if (!seller.taxNumber) seller.taxNumber = findTaxNumber(text);
  if (!seller.email) seller.email = findEmail(text);

  // Buyer VAT: DK from text if buyer looks Nordic / HBK
  if (!buyer.vatId) {
    const dk = text.match(/\bVAT\s*:\s*(DK\s?[\d\s]{6,16})/i);
    if (dk) buyer.vatId = dk[1].replace(/\s+/g, '').toUpperCase();
  }

  void lang;
  return { seller, buyer };
}

/** True when the PDF looks like a BEAK article table (D/R/L note columns). */
function isBeakArticleTable(text) {
  return (
    /BEAK\b/i.test(text) &&
    /(?:D\s*=\s*Delivery\s*note|L\s*=\s*Lieferschein|R\s*=\s*Repair\s*note|R\s*=\s*Reparaturschein)/i.test(
      text
    )
  );
}

/** Reject summary labels and broken pdf.js date fragments — keep real product names. */
function isJunkLineName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n || n.length < 3) return true;
  // Pure summary / column labels (exact-ish)
  if (
    /^(?:netto(?:betrag)?|brutto(?:betrag)?|summe|gesamt|mwst\.?|ust\.?|zwischensumme|bezeichnung|artikel-?bezeichnung|menge|warennettowert|taxable(?:\s*amount)?|net\s*price|packaging|verpackung|delivery\s*charge|fracht(?:kosten)?|total\s*amount|rechnungsbetrag|invoice|rechnung|maturity|fälligkeit|terms of payment|zahlungsbedingungen|pos|item)$/i.test(
      n
    )
  )
    return true;
  // Payment / totals wording that slipped into a capture
  if (
    /(?:warennetto|taxable\s*amount|net\s*price|rechnungsbetrag|total\s*amount|zahlungsbetrag|payment\s*amount|terms of payment|zahlungsbedingungen)/i.test(
      n
    )
  )
    return true;
  // Broken pdf.js dates like "1.0 8 .2026 0,00%" or percent-only noise
  if (/%/.test(n)) return true;
  if (/^\d[\d.\s]*\d{4}\b/.test(n)) return true;
  return false;
}

/**
 * BEAK rows: optional article-no line, then
 *   Desc  D|R|L <nr> [-|v.] <date>  <order>  <qty>  <unit>€/<unit>  <amount>
 * D = Delivery note (was missing before → empty lines on many invoices).
 */
function parseBeakLineItems(text, defaultVat = '19') {
  const lines = [];
  const beakRe =
    /(?:^|\n)\s*(?:\d{1,3}\s+[\d.]+\s*\/[^\n]*\n\s*)?([A-Za-zÄÖÜäöüß&][^\n]{3,100}?)\s+[DRL]\s+\d+\s*(?:[-–]|v\.)\s*\d{1,2}\.\d{1,2}\.\d{2,4}\s+\S+\s+(\d+[.,]\d+|\d+)\s+(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})\s*€[^€\n]{0,30}?(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})(?!\s*%)/gim;
  let m;
  while ((m = beakRe.exec(text)) !== null && lines.length < 40) {
    let name = m[1].replace(/\s+/g, ' ').trim();
    // Safety: strip accidental note / long order leftovers
    name = name
      .replace(/\s+[DRL]\s+\d+.*$/i, '')
      .replace(/\s+\d{6,}.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (isJunkLineName(name)) continue;
    lines.push({
      qty: String(m[2]).replace(',', '.'),
      name: name.slice(0, 120),
      unitPrice: parseGermanAmount(m[3]),
      vatPercent: defaultVat,
      lineTotal: parseGermanAmount(m[4]),
    });
  }
  // Fallback: older optional-note BEAK layout (L/R only historically; keep D too)
  if (!lines.length) {
    const looseRe =
      /(?:^|\n)\s*(?:\d{1,3}\s+[\d.]+\s*\/[^\n]*\n\s*)?([A-Za-zÄÖÜäöüß&][^\n]{4,90}?)\s+(?:[DRL]\s+\d+[^\n]{0,80}?)?\s+(\d+[.,]\d+|\d+)\s+(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})\s*€[^€\n]{0,24}?(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})(?!\s*%)/gim;
    while ((m = looseRe.exec(text)) !== null && lines.length < 40) {
      let name = m[1].replace(/\s+/g, ' ').trim();
      name = name
        .replace(/\s+[DRL]\s+\d+.*$/i, '')
        .replace(/\s+\d{6,}.*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (isJunkLineName(name)) continue;
      lines.push({
        qty: String(m[2]).replace(',', '.'),
        name: name.slice(0, 120),
        unitPrice: parseGermanAmount(m[3]),
        vatPercent: defaultVat,
        lineTotal: parseGermanAmount(m[4]),
      });
    }
  }
  return lines;
}

function parseLineItems(text, defaultVat = '19') {
  const lines = [];
  let m;

  // Prefer BEAK article-table parser when markers are present (avoids payment-row false hits)
  if (isBeakArticleTable(text)) {
    const beakLines = parseBeakLineItems(text, defaultVat);
    if (beakLines.length) return beakLines;
  }

  // Classic DE fixture: "1    2      Sensor Modul A                 50,00        19     100,00"
  const rowRe =
    /(?:^|\n)\s*\d+\s+(\d+(?:[.,]\d+)?)\s+(.{3,60}?)\s+(\d+[.,]\d{2})\s+(\d+[.,]?\d*)\s*%?\s+(\d+[.,]\d{2})/gim;
  while ((m = rowRe.exec(text)) !== null && lines.length < 40) {
    const name = m[2].replace(/\s+/g, ' ').trim();
    if (isJunkLineName(name)) continue;
    if (/netto|brutto|summe|gesamt|mwst|ust|zwischensumme|bezeichnung|menge|warennetto|taxable|net price/i.test(name))
      continue;
    lines.push({
      qty: String(m[1]).replace(',', '.'),
      name,
      unitPrice: parseGermanAmount(m[3]),
      vatPercent: m[4] ? String(m[4]).replace(',', '.') : defaultVat,
      lineTotal: parseGermanAmount(m[5]),
    });
  }
  if (lines.length) return lines;

  // BEAK template even without strong header markers
  const beakLines = parseBeakLineItems(text, defaultVat);
  if (beakLines.length) return beakLines;

  // Fallback: qty name price total
  const rowRe2 =
    /(?:^|\n)\s*(\d+(?:[.,]\d+)?)\s+(.{5,60}?)\s+(\d+[.,]\d{2})\s+(?:€\s*)?(?:(\d+[.,]?\d{0,2})\s*%?\s+)?(\d+[.,]\d{2})\s*(?:€)?/gim;
  while ((m = rowRe2.exec(text)) !== null && lines.length < 40) {
    const name = m[2].replace(/\s+/g, ' ').trim();
    if (isJunkLineName(name)) continue;
    if (/netto|brutto|summe|gesamt|mwst|ust|zwischensumme|bezeichnung|menge/i.test(name)) continue;
    lines.push({
      qty: String(m[1]).replace(',', '.'),
      name,
      unitPrice: parseGermanAmount(m[3]),
      vatPercent: m[4] ? String(m[4]).replace(',', '.') : defaultVat,
      lineTotal: parseGermanAmount(m[5]),
    });
  }
  return lines;
}

function extractLabeledOrValueBefore(text, labelPatterns, valueBeforePatterns) {
  const labeled = firstMatch(text, labelPatterns);
  if (labeled) return labeled;
  return firstMatch(text, valueBeforePatterns || []);
}

/**
 * @param {string} text
 * @param {{ companyName?: string }} [opts]
 */
export function parseInvoiceText(text, opts = {}) {
  const raw = normalizeWhitespace(text);
  const inv = emptyInvoice();
  if (!raw) return inv;

  const lang = detectInvoiceLang(raw);

  // Invoice number — label:value and value-before-label
  inv.invoiceNumber = extractLabeledOrValueBefore(
    raw,
    [
      /Rechnungs[-\s]?(?:nummer|nr\.?|n[ur]\.?)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/.]{1,30})/i,
      /Rechnung\s*(?:Nr\.?|Nummer)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/.]{1,30})/i,
      /Invoice\s*(?:no\.?|number|#)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/.]{1,30})/i,
      /\bRE[- ]?(\d{4,})\b/i,
    ],
    [
      // 27728 … Invoice no.   OR   27722 … Rechnungs-Nummer
      /(?:^|\n)\s*(\d{4,8})\s*[:\s]*(?:\n[\s\S]{0,80}?)?(?:Invoice\s*no\.?|Rechnungs[-\s]?Nummer)/i,
      /(?:Invoice\s*no\.?|Rechnungs[-\s]?Nummer)[^\d]{0,40}(\d{4,8})/i,
    ]
  );

  const issueRaw = extractLabeledOrValueBefore(
    raw,
    [
      /Rechnungsdatum\s*[:.]?\s*(\d{1,2}\.\d{1,2}\.\d{2,4}|\d{4}-\d{2}-\d{2})/i,
      /Invoice\s*date\s*[:.]?\s*(\d{1,2}\.\d{1,2}\.\d{2,4}|\d{4}-\d{2}-\d{2})/i,
      /Datum\s*[:.]?\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
    ],
    [
      /(?:^|\n)\s*(\d{1,2}\.\d{1,2}\.\d{2,4})\s*[:\s]*(?:\n[\s\S]{0,80}?)?(?:Invoice\s*date|Rechnungsdatum)/i,
      /(?:Invoice\s*date|Rechnungsdatum)[^\d]{0,40}(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
    ]
  );
  inv.issueDate = normalizeDateDisplay(issueRaw);

  const dueRaw = extractLabeledOrValueBefore(
    raw,
    [
      /Fälligkeitsdatum\s*[:.]?\s*(\d{1,2}\.\d{1,2}\.\d{2,4}|\d{4}-\d{2}-\d{2})/i,
      /Fällig\s*(?:am)?\s*[:.]?\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
      /Due\s*Date\s*[:.]?\s*(\d{1,2}\.\d{1,2}\.\d{2,4}|\d{4}-\d{2}-\d{2})/i,
      // BEAK payment table: date under Fälligkeit / maturity (layout can put ~300+ chars between label and value)
      /(?:Fälligkeit|maturity)\b[\s\S]{0,500}?(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
      // Terms of payment block → first date (often on next lines after headers)
      /Terms\s+of\s+payment[\s\S]{0,400}?(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
      /Zahlungsbedingungen[\s\S]{0,400}?(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
    ],
    [
      // Payment row: due date + discount %  e.g. 31.08.2026  0,00%
      /(?:^|\n)\s*(\d{1,2}\.\d{1,2}\.\d{2,4})\s+\d+[.,]\d+\s*%/i,
      /(\d{1,2}\.\d{1,2}\.\d{2,4})\s+\d+[.,]\d+\s*%\s+[\d.\s]+,\d{2}\s*€/i,
    ]
  );
  inv.dueDate = normalizeDateDisplay(dueRaw);

  // Prefer an explicit delivery/service-date label. BEAK EN/DE line items instead
  // carry the date in the delivery/repair-note column, e.g. "R 23077 - 17.09.2026"
  // or "L 26764 v. 07.09.2026". Pick the earliest matching fallback in document order.
  const labeledDelivery = firstMatch(raw, [
    /(?:Liefer|Leistungs)datum\s*[:.]?\s*(\d{1,2}\.\d{1,2}\.\d{2,4}|\d{4}-\d{2}-\d{2})/i,
    /Lieferdatum\s*[:.]?\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
  ]);
  let delRaw = labeledDelivery;
  if (!delRaw) {
    const deliveryFallbacks = [
      // BEAK line-item note cells: D=delivery, R=repair, L=Lieferschein.
      /\b[DRL]\s*\d{3,}\s*(?:[-–]|v\.)\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
      // Some German layouts spell out the note number and date in one row.
      /\bLieferschein\s*[-]?\s*(?:Nr\.?|Nummer)\s*[:.]?\s*\d{3,}[^\n]{0,60}?\bDatum\b\s*[:.]?\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
      // Also accept spelled-out English note headers when the number is retained.
      /\b(?:Delivery\s+note|Repair\s+note)\s*[:.]?\s*\d{3,}\s*(?:[-–]|v\.)\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
    ];
    const matches = deliveryFallbacks
      .map((re) => {
        const match = re.exec(raw);
        return match ? { index: match.index, value: match[1] } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);
    delRaw = matches[0]?.value || '';
  }
  inv.deliveryDate = normalizeDateDisplay(delRaw);

  const cur = firstMatch(raw, [/\b(EUR|USD|CHF|GBP)\b/]);
  if (cur) inv.currency = cur.toUpperCase();

  const parties = partyHints(raw, opts.companyName || '', lang);
  inv.seller = parties.seller;
  inv.buyer = parties.buyer;

  inv.gross = parseGermanAmount(
    extractLabeledOrValueBefore(
      raw,
      [
        /(?:Brutto(?:betrag)?|Gesamtbetrag|Endbetrag|Rechnungsbetrag)\s*[:.€\s]*([\d.\s]+,\d{2}|\d+\.\d{2})/i,
        /Total\s*amount\s*[:.€\s]*([\d.\s]+,\d{2}|\d+\.\d{2})/i,
        /Summe\s*brutto\s*[:.]?\s*([\d.\s]+,\d{2})/i,
        /\bTotal\b\s*[:.]?\s*([\d.\s]+,\d{2}|\d+\.\d{2})\s*€?/i,
      ],
      [
        /([\d.\s]+,\d{2})\s*(?:\n\s*)?(?:Total\s*amount|Rechnungsbetrag)/i,
        /(?:Total\s*amount|Rechnungsbetrag)[^\d]{0,40}([\d.\s]+,\d{2})/i,
      ]
    )
  );

  inv.net = parseGermanAmount(
    extractLabeledOrValueBefore(
      raw,
      [
        /(?:Netto(?:betrag)?|Zwischensumme|Summe\s*netto|Warennettowert|Steuerpfl\.?\s*Betrag)\s*[:.]?\s*([\d.\s]+,\d{2}|\d+\.\d{2})/i,
        /Net\s*(?:price|amount)\s*[:.]?\s*([\d.\s]+,\d{2}|\d+\.\d{2})/i,
        /taxable\s*amount\s*[:.]?\s*([\d.\s]+,\d{2}|\d+\.\d{2})/i,
      ],
      [
        /([\d.\s]+,\d{2})\s*(?:\n\s*)?(?:Net\s*price|Warennettowert|taxable\s*amount|Steuerpfl)/i,
      ]
    )
  );

  // VAT amount + rate — "VAT 0% : 0,00" / "Umsatzsteuer 19% : 1.805,30" / "MwSt. 19%: 26,60"
  const vatCombo = raw.match(
    /(?:VAT|Umsatzsteuer|MwSt\.?|USt\.?)\s*(\d+[.,]?\d*)\s*%\s*[:.]?\s*([\d.\s]+,\d{2}|\d+\.\d{2})/i
  );
  if (vatCombo) {
    inv.vatRate = String(vatCombo[1]).replace(',', '.');
    inv.vatAmount = parseGermanAmount(vatCombo[2]);
  } else {
    inv.vatAmount = parseGermanAmount(
      firstMatch(raw, [
        /(?:MwSt\.?|USt\.?|Umsatzsteuer|VAT)\s*(?:\d+[.,]?\d*\s*%\s*)?[:.]?\s*([\d.\s]+,\d{2}|\d+\.\d{2})/i,
      ])
    );
    const vatRate = firstMatch(raw, [
      /(?:MwSt\.?|USt\.?|VAT|Umsatzsteuer)\s*[:.]?\s*(\d+[.,]?\d*)\s*%/i,
      /(\d+[.,]?\d*)\s*%\s*(?:MwSt\.?|USt\.?|VAT)/i,
    ]);
    if (vatRate) inv.vatRate = vatRate.replace(',', '.');
  }

  const defaultVat = inv.vatRate !== '' ? inv.vatRate : lang === 'en' ? '0' : '19';
  inv.lines = parseLineItems(raw, defaultVat);
  // If VAT rate known, apply to lines missing it
  if (inv.vatRate !== '' && inv.lines.length) {
    for (const line of inv.lines) {
      if (!line.vatPercent || line.vatPercent === '19' && inv.vatRate === '0') {
        // Prefer document VAT for BEAK EN 0% invoices
        if (inv.vatRate === '0') line.vatPercent = '0';
      }
    }
  }
  // EN BEAK 0% → force line VAT to 0 when document says so
  if (inv.vatRate === '0' || inv.vatRate === '0.0') {
    for (const line of inv.lines) line.vatPercent = '0';
  } else if (inv.vatRate && inv.lines.length) {
    for (const line of inv.lines) {
      if (!line.vatPercent) line.vatPercent = inv.vatRate;
    }
  }

  // Infer missing amounts
  if (!inv.vatRate && inv.net && inv.vatAmount) {
    const n = Number(inv.net);
    const v = Number(inv.vatAmount);
    if (n > 0 && v >= 0) inv.vatRate = ((v / n) * 100).toFixed(0);
  }
  if (!inv.gross && inv.net && inv.vatAmount) {
    inv.gross = (Number(inv.net) + Number(inv.vatAmount)).toFixed(2);
  }
  if (!inv.net && inv.gross && inv.vatAmount) {
    inv.net = (Number(inv.gross) - Number(inv.vatAmount)).toFixed(2);
  }
  // VAT 0% with net but no vat amount
  if ((inv.vatRate === '0' || inv.vatRate === '0.0') && inv.net && !inv.vatAmount) {
    inv.vatAmount = '0.00';
  }
  if ((inv.vatRate === '0' || inv.vatRate === '0.0') && inv.net && !inv.gross) {
    inv.gross = inv.net;
  }

  return inv;
}

export function requiredMissing(inv) {
  const miss = [];
  if (!inv.invoiceNumber) miss.push('invoiceNumber');
  if (!inv.issueDate) miss.push('issueDate');
  if (!inv.dueDate) miss.push('dueDate');
  if (!inv.currency) miss.push('currency');

  if (!inv.seller?.name) miss.push('seller.name');
  if (!inv.seller?.street) miss.push('seller.street');
  if (!inv.seller?.zipCity) miss.push('seller.zipCity');
  if (!inv.seller?.country) miss.push('seller.country');
  if (!inv.seller?.vatId) miss.push('seller.vatId');
  // seller.taxNumber optional — not required

  if (!inv.buyer?.name) miss.push('buyer.name');
  if (!inv.buyer?.street) miss.push('buyer.street');
  if (!inv.buyer?.zipCity) miss.push('buyer.zipCity');
  if (!inv.buyer?.country) miss.push('buyer.country');
  // buyer.vatId / buyer.taxNumber optional — not required

  if (!inv.gross && !(inv.net && inv.vatAmount)) miss.push('gross');

  const lines = Array.isArray(inv.lines) ? inv.lines : [];
  const hasUsableLine = lines.some(
    (l) => String(l?.name || '').trim() !== ''
  );
  if (!hasUsableLine) miss.push('lines');

  return miss;
}
