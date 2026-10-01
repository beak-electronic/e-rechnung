import { dateToCcyymmdd } from './parse.js';

const GUIDELINES = {
  minimum: 'urn:factur-x.eu:1p0:minimum',
  basic: 'urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic',
  en16931: 'urn:cen.eu:en16931:2017',
  xrechnung: 'urn:cen.eu:en16931:2017#compliant#urn:xechnung.de:kosit:xrechnung_3.0',
};

export function guidelineUrn(profile) {
  return GUIDELINES[profile] || GUIDELINES.en16931;
}

export function xmlAttachmentName(profile) {
  // Factur-X spec: factur-x.xml (also used for XRechnung profile embeds here)
  return 'factur-x.xml';
}

export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * EN 16931 VAT category from rate.
 * 0% → Z (zero rated); positive → S (standard). Prefer Z over E for 0%.
 */
export function vatCategoryCode(rate) {
  const n = Number(String(rate ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n === 0) return 'Z';
  return 'S';
}

function amt(v) {
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

function splitZipCity(zipCity) {
  const s = String(zipCity || '').trim();
  const m = s.match(/^(\d{4,5})\s+(.+)$/);
  if (m) return { zip: m[1], city: m[2].trim() };
  if (/^\d{4,5}$/.test(s)) return { zip: s, city: '' };
  return { zip: '', city: s };
}

function sanitizeInvoiceId(id) {
  const s = String(id ?? '').trim();
  if (!s) return 'UNKNOWN';
  // Strip characters that break CII ID / FX schematron
  return s.replace(/[\u0000-\u001f\u007f]/g, '');
}

function sanitizeIban(iban) {
  return String(iban || '').replace(/\s+/g, '').toUpperCase();
}

/**
 * CII TradeParty child order:
 * Name → PostalTradeAddress → URIUniversalCommunication → SpecifiedTaxRegistration(s)
 */
function tradePartyXml(party, roleTag) {
  const p = party || {};
  const { zip, city } = splitZipCity(p.zipCity);
  const country = (p.country || 'DE').slice(0, 2).toUpperCase();
  let xml = `<ram:${roleTag}>`;
  if (p.name) xml += `<ram:Name>${escapeXml(p.name)}</ram:Name>`;
  // CII TradeAddress order (ZUGFeRD FAQ): PostcodeCode → LineOne → (LineTwo) → CityName → CountryID
  if (p.street || zip || city) {
    xml += '<ram:PostalTradeAddress>';
    if (zip) xml += `<ram:PostcodeCode>${escapeXml(zip)}</ram:PostcodeCode>`;
    if (p.street) xml += `<ram:LineOne>${escapeXml(p.street)}</ram:LineOne>`;
    if (city) xml += `<ram:CityName>${escapeXml(city)}</ram:CityName>`;
    xml += `<ram:CountryID>${escapeXml(country)}</ram:CountryID>`;
    xml += '</ram:PostalTradeAddress>';
  }
  if (p.email) {
    xml += `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${escapeXml(p.email)}</ram:URIID></ram:URIUniversalCommunication>`;
  }
  // Separate SpecifiedTaxRegistration blocks for VA and FC (after address/URI); only if non-empty
  const vatId = String(p.vatId || '').trim();
  const taxNumber = String(p.taxNumber || '').trim();
  if (vatId) {
    xml += `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${escapeXml(vatId)}</ram:ID></ram:SpecifiedTaxRegistration>`;
  }
  if (taxNumber) {
    xml += `<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">${escapeXml(taxNumber)}</ram:ID></ram:SpecifiedTaxRegistration>`;
  }
  xml += `</ram:${roleTag}>`;
  return xml;
}

function lineXml(line, idx, currency) {
  const qty = amt(line.qty || '1');
  const total = amt(line.lineTotal || '0');
  const unit = amt(line.unitPrice || '0');
  const vat = amt(line.vatPercent ?? '19');
  const cat = vatCategoryCode(vat);
  return (
    `<ram:IncludedSupplyChainTradeLineItem>` +
    `<ram:AssociatedDocumentLineDocument><ram:LineID>${idx}</ram:LineID></ram:AssociatedDocumentLineDocument>` +
    `<ram:SpecifiedTradeProduct><ram:Name>${escapeXml(line.name || `Position ${idx}`)}</ram:Name></ram:SpecifiedTradeProduct>` +
    `<ram:SpecifiedLineTradeAgreement>` +
    `<ram:NetPriceProductTradePrice><ram:ChargeAmount>${unit}</ram:ChargeAmount></ram:NetPriceProductTradePrice>` +
    `</ram:SpecifiedLineTradeAgreement>` +
    `<ram:SpecifiedLineTradeDelivery>` +
    `<ram:BilledQuantity unitCode="C62">${qty}</ram:BilledQuantity>` +
    `</ram:SpecifiedLineTradeDelivery>` +
    `<ram:SpecifiedLineTradeSettlement>` +
    `<ram:ApplicableTradeTax>` +
    `<ram:TypeCode>VAT</ram:TypeCode>` +
    `<ram:CategoryCode>${cat}</ram:CategoryCode>` +
    `<ram:RateApplicablePercent>${vat}</ram:RateApplicablePercent>` +
    `</ram:ApplicableTradeTax>` +
    `<ram:SpecifiedTradeSettlementLineMonetarySummation>` +
    `<ram:LineTotalAmount>${total}</ram:LineTotalAmount>` +
    `</ram:SpecifiedTradeSettlementLineMonetarySummation>` +
    `</ram:SpecifiedLineTradeSettlement>` +
    `</ram:IncludedSupplyChainTradeLineItem>`
  );
}

/**
 * Build UN/CEFACT CII CrossIndustryInvoice XML.
 * @param {object} inv
 * @param {string} profile minimum|basic|en16931|xrechnung
 */
export function buildCiiXml(inv, profile = 'en16931') {
  const guideline = guidelineUrn(profile);
  const issue = dateToCcyymmdd(inv.issueDate) || dateToCcyymmdd(new Date().toLocaleDateString('de-DE'));
  const due = dateToCcyymmdd(inv.dueDate);
  const delivery = dateToCcyymmdd(inv.deliveryDate);
  const currency = escapeXml(inv.currency || 'EUR');
  const includeLines = profile !== 'minimum';

  // Resolve document VAT rate fallback (used when no lines / single-rate document)
  const rawVatRate = String(inv.vatRate ?? '').trim().replace(',', '.');
  let docVatRateNum = rawVatRate === '' ? NaN : Number(rawVatRate);
  if (Array.isArray(inv.lines) && inv.lines.length) {
    const allZero = inv.lines.every((l) => {
      const r = Number(String(l.vatPercent ?? '').replace(',', '.'));
      return Number.isFinite(r) && r === 0;
    });
    if (allZero) docVatRateNum = 0;
  }
  const hasFormNet = String(inv.net ?? '').trim() !== '';
  const hasFormVat = String(inv.vatAmount ?? '').trim() !== '';
  const formNet = hasFormNet ? Number(String(inv.net).replace(',', '.')) : NaN;
  const formVat = hasFormVat ? Number(String(inv.vatAmount).replace(',', '.')) : NaN;
  if (Number.isFinite(formNet) && formNet > 0 && Number.isFinite(formVat) && formVat === 0 &&
      (rawVatRate === '0' || rawVatRate === '0.0' || docVatRateNum === 0)) {
    docVatRateNum = 0;
  }
  if (!Number.isFinite(docVatRateNum)) docVatRateNum = 19;

  // Prefer sum of line totals as TaxBasis/LineTotal when lines exist (BR-CO-14/15)
  const resolvedLines = Array.isArray(inv.lines) && inv.lines.length
    ? inv.lines
    : null;
  let taxBasisNum;
  if (resolvedLines) {
    taxBasisNum = resolvedLines.reduce((s, l) => {
      const t = Number(String(l.lineTotal ?? '').replace(',', '.'));
      return s + (Number.isFinite(t) ? t : 0);
    }, 0);
  } else {
    taxBasisNum = Number.isFinite(formNet)
      ? formNet
      : Number(String(inv.gross ?? '').replace(',', '.')) -
        (Number.isFinite(formVat) ? formVat : 0);
    if (!Number.isFinite(taxBasisNum)) taxBasisNum = 0;
  }
  const net = amt(taxBasisNum);

  // One header ApplicableTradeTax per VAT rate/category
  const taxBuckets = new Map(); // key: rate string "19.00" -> { basis, calculated, cat, rate }
  function addTaxBucket(rateNum, basisNum) {
    const rateStr = amt(rateNum);
    const cat = vatCategoryCode(rateNum);
    const calc = Math.round(basisNum * Number(rateStr) / 100 * 100) / 100;
    const prev = taxBuckets.get(rateStr);
    if (prev) {
      prev.basis += basisNum;
      prev.calculated = Math.round(prev.basis * Number(rateStr) / 100 * 100) / 100;
    } else {
      taxBuckets.set(rateStr, { basis: basisNum, calculated: calc, cat, rate: rateStr });
    }
  }

  if (resolvedLines) {
    for (const l of resolvedLines) {
      const r = Number(String(l.vatPercent ?? docVatRateNum).replace(',', '.'));
      const rateNum = Number.isFinite(r) ? r : docVatRateNum;
      const basis = Number(String(l.lineTotal ?? '').replace(',', '.'));
      addTaxBucket(rateNum, Number.isFinite(basis) ? basis : 0);
    }
  } else {
    // Document-level single bucket; prefer form vatAmount when present for exact match
    const basis = taxBasisNum;
    const rateStr = amt(docVatRateNum);
    const cat = vatCategoryCode(docVatRateNum);
    let calculated;
    if (hasFormVat && Number.isFinite(formVat)) {
      calculated = formVat;
    } else {
      calculated = Math.round(basis * Number(rateStr) / 100 * 100) / 100;
    }
    taxBuckets.set(rateStr, { basis, calculated, cat, rate: rateStr });
  }

  const taxEntries = [...taxBuckets.values()];
  const taxTotalNum = taxEntries.reduce((s, e) => s + e.calculated, 0);
  const vatAmount = amt(taxTotalNum);
  const grandTotalNum = Math.round((taxBasisNum + taxTotalNum) * 100) / 100;
  const gross = amt(grandTotalNum);

  const headerTaxXml = taxEntries
    .map(
      (e) =>
        `<ram:ApplicableTradeTax>` +
        `<ram:CalculatedAmount>${amt(e.calculated)}</ram:CalculatedAmount>` +
        `<ram:TypeCode>VAT</ram:TypeCode>` +
        `<ram:BasisAmount>${amt(e.basis)}</ram:BasisAmount>` +
        `<ram:CategoryCode>${e.cat}</ram:CategoryCode>` +
        `<ram:RateApplicablePercent>${e.rate}</ram:RateApplicablePercent>` +
        `</ram:ApplicableTradeTax>`
    )
    .join('');

  let linesXml = '';
  if (includeLines) {
    const lines = resolvedLines || [
      { qty: '1', name: 'Rechnungssumme', unitPrice: net, vatPercent: amt(docVatRateNum), lineTotal: net },
    ];
    linesXml = lines.map((l, i) => lineXml(l, i + 1, currency)).join('');
  }

  let paymentXml = '';
  const iban = sanitizeIban(inv.seller?.iban);
  if (iban) {
    paymentXml =
      `<ram:SpecifiedTradeSettlementPaymentMeans>` +
      `<ram:TypeCode>58</ram:TypeCode>` +
      `<ram:PayeePartyCreditorFinancialAccount>` +
      `<ram:IBANID>${escapeXml(iban)}</ram:IBANID>` +
      `</ram:PayeePartyCreditorFinancialAccount>` +
      (inv.seller.bic
        ? `<ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>${escapeXml(inv.seller.bic)}</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>`
        : '') +
      `</ram:SpecifiedTradeSettlementPaymentMeans>`;
  }

  let dueXml = '';
  if (due) {
    dueXml =
      `<ram:SpecifiedTradePaymentTerms>` +
      `<ram:DueDateDateTime><udt:DateTimeString format="102">${due}</udt:DateTimeString></ram:DueDateDateTime>` +
      `</ram:SpecifiedTradePaymentTerms>`;
  }

  let deliveryXml =
    `<ram:ApplicableHeaderTradeDelivery>` +
    (delivery
      ? `<ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime><udt:DateTimeString format="102">${delivery}</udt:DateTimeString></ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent>`
      : '') +
    `</ram:ApplicableHeaderTradeDelivery>`;

  // FX-SCH-A-556: omit BusinessProcess for Factur-X (en16931/basic/minimum);
  // Peppol URN is often rejected. Also omit for xrechnung — Guideline ID alone is enough.
  const businessProcessXml = '';

  const invoiceId = sanitizeInvoiceId(inv.invoiceNumber);

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rsm:CrossIndustryInvoice` +
    ` xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"` +
    ` xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"` +
    ` xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"` +
    ` xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100">` +
    `<rsm:ExchangedDocumentContext>` +
    businessProcessXml +
    `<ram:GuidelineSpecifiedDocumentContextParameter>` +
    `<ram:ID>${escapeXml(guideline)}</ram:ID>` +
    `</ram:GuidelineSpecifiedDocumentContextParameter>` +
    `</rsm:ExchangedDocumentContext>` +
    `<rsm:ExchangedDocument>` +
    `<ram:ID>${escapeXml(invoiceId)}</ram:ID>` +
    `<ram:TypeCode>380</ram:TypeCode>` +
    `<ram:IssueDateTime><udt:DateTimeString format="102">${issue}</udt:DateTimeString></ram:IssueDateTime>` +
    `</rsm:ExchangedDocument>` +
    `<rsm:SupplyChainTradeTransaction>` +
    linesXml +
    `<ram:ApplicableHeaderTradeAgreement>` +
    tradePartyXml(inv.seller, 'SellerTradeParty') +
    tradePartyXml(inv.buyer, 'BuyerTradeParty') +
    `</ram:ApplicableHeaderTradeAgreement>` +
    deliveryXml +
    `<ram:ApplicableHeaderTradeSettlement>` +
    `<ram:InvoiceCurrencyCode>${currency}</ram:InvoiceCurrencyCode>` +
    paymentXml +
    headerTaxXml +
    dueXml +
    `<ram:SpecifiedTradeSettlementHeaderMonetarySummation>` +
    `<ram:LineTotalAmount>${net}</ram:LineTotalAmount>` +
    `<ram:TaxBasisTotalAmount>${net}</ram:TaxBasisTotalAmount>` +
    `<ram:TaxTotalAmount currencyID="${currency}">${vatAmount}</ram:TaxTotalAmount>` +
    `<ram:GrandTotalAmount>${gross}</ram:GrandTotalAmount>` +
    `<ram:DuePayableAmount>${gross}</ram:DuePayableAmount>` +
    `</ram:SpecifiedTradeSettlementHeaderMonetarySummation>` +
    `</ram:ApplicableHeaderTradeSettlement>` +
    `</rsm:SupplyChainTradeTransaction>` +
    `</rsm:CrossIndustryInvoice>`;

  return xml;
}

export function conformanceLevel(profile) {
  switch (profile) {
    case 'minimum':
      return 'MINIMUM';
    case 'basic':
      return 'BASIC';
    case 'xrechnung':
      return 'EN 16931';
    default:
      return 'EN 16931';
  }
}
