import { xmlAttachmentName, conformanceLevel } from './zugferd.js';

/**
 * Embed Factur-X / ZUGFeRD CII XML into a PDF using pdf-lib.
 * Uses PDFDocument.attach when available; otherwise low-level EmbeddedFile + AF.
 * Optionally adds a minimal XMP packet (pdfaid + Factur-X).
 */

function buildXmp(profile, fileName) {
  const conf = conformanceLevel(profile);
  const now = new Date().toISOString();
  return (
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about=""` +
    ` xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"` +
    ` xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#"` +
    ` xmlns:xmp="http://ns.adobe.com/xap/1.0/">` +
    `<pdfaid:part>3</pdfaid:part>` +
    `<pdfaid:conformance>B</pdfaid:conformance>` +
    `<fx:DocumentType>INVOICE</fx:DocumentType>` +
    `<fx:DocumentFileName>${fileName}</fx:DocumentFileName>` +
    `<fx:Version>1.0</fx:Version>` +
    `<fx:ConformanceLevel>${conf}</fx:ConformanceLevel>` +
    `<xmp:CreateDate>${now}</xmp:CreateDate>` +
    `<xmp:ModifyDate>${now}</xmp:ModifyDate>` +
    `</rdf:Description>` +
    `</rdf:RDF>` +
    `</x:xmpmeta>` +
    `<?xpacket end="w"?>`
  );
}

async function attachLowLevel(pdfDoc, xmlBytes, fileName) {
  const PDFLib = globalThis.PDFLib;
  const { PDFName, PDFString, PDFHexString, PDFArray, PDFDict, PDFNumber } = PDFLib;
  const context = pdfDoc.context;

  const stream = context.flateStream(xmlBytes, {
    Type: 'EmbeddedFile',
    Subtype: PDFName.of('text#2Fxml'),
    Params: {
      ModDate: `D:${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}+00'00'`,
      Size: xmlBytes.length,
    },
  });
  const streamRef = context.register(stream);

  const efDict = context.obj({ F: streamRef });
  const fileSpecDict = context.obj({
    Type: 'Filespec',
    F: PDFString.of(fileName),
    UF: PDFString.of(fileName),
    EF: efDict,
    Desc: PDFString.of('Factur-X/ZUGFeRD Invoice'),
    AFRelationship: PDFName.of('Data'),
  });
  const fileSpecRef = context.register(fileSpecDict);

  // Names → EmbeddedFiles → Names [filename, filespec]
  const catalog = pdfDoc.catalog;
  let namesDict = catalog.lookup(PDFName.of('Names'));
  if (!namesDict) {
    namesDict = context.obj({});
    catalog.set(PDFName.of('Names'), namesDict);
  }
  let efNames = namesDict.lookup(PDFName.of('EmbeddedFiles'));
  if (!efNames) {
    efNames = context.obj({ Names: [] });
    namesDict.set(PDFName.of('EmbeddedFiles'), efNames);
  }
  let namesArr = efNames.lookup(PDFName.of('Names'));
  if (!namesArr) {
    namesArr = context.obj([]);
    efNames.set(PDFName.of('Names'), namesArr);
  }
  namesArr.push(PDFString.of(fileName));
  namesArr.push(fileSpecRef);

  // AF array on catalog
  let af = catalog.lookup(PDFName.of('AF'));
  if (!af) {
    af = context.obj([]);
    catalog.set(PDFName.of('AF'), af);
  }
  af.push(fileSpecRef);

  return fileSpecRef;
}

async function maybeSetXmp(pdfDoc, profile, fileName) {
  try {
    const PDFLib = globalThis.PDFLib;
    const { PDFName, PDFString } = PDFLib;
    const xmp = buildXmp(profile, fileName);
    const bytes = new TextEncoder().encode(xmp);
    const stream = pdfDoc.context.flateStream(bytes, {
      Type: 'Metadata',
      Subtype: 'XML',
    });
    const ref = pdfDoc.context.register(stream);
    pdfDoc.catalog.set(PDFName.of('Metadata'), ref);
  } catch (err) {
    console.warn('XMP metadata skipped', err);
  }
}

/**
 * @param {Uint8Array|ArrayBuffer} pdfBytes
 * @param {string} xmlString
 * @param {string} profile
 * @returns {Promise<Uint8Array>}
 */
export async function embedZugferd(pdfBytes, xmlString, profile = 'en16931') {
  const PDFLib = globalThis.PDFLib;
  if (!PDFLib || !PDFLib.PDFDocument) {
    throw new Error('pdf-lib nicht geladen');
  }
  const fileName = xmlAttachmentName(profile);
  const xmlBytes = new TextEncoder().encode(xmlString);
  const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true });

  let attached = false;
  if (typeof pdfDoc.attach === 'function') {
    try {
      const opts = {
        mimeType: 'text/xml',
        description: 'Factur-X/ZUGFeRD Invoice',
        creationDate: new Date(),
        modificationDate: new Date(),
      };
      if (PDFLib.AFRelationship && PDFLib.AFRelationship.Data) {
        opts.afRelationship = PDFLib.AFRelationship.Data;
      }
      await pdfDoc.attach(xmlBytes, fileName, opts);
      attached = true;
    } catch (err) {
      console.warn('pdfDoc.attach failed, falling back', err);
    }
  }
  if (!attached) {
    await attachLowLevel(pdfDoc, xmlBytes, fileName);
  }

  await maybeSetXmp(pdfDoc, profile, fileName);

  const out = await pdfDoc.save({ useObjectStreams: false });
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}
