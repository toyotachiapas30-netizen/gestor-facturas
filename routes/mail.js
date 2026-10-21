const express = require('express');
const { execSync } = require('child_process');
const zlib = require('zlib');
const path = require('path');
const xml2js = require('xml2js');
const router = express.Router();
const { getAuthorizedClient, getGoogle } = require('./drive');
const { getDB, getGestorRole, backupDatabaseToDrive } = require('./gastos');

// ── Descompresor ZIP en Memoria (Nativo con zlib + Soporte Recursivo ZIP dentro de ZIP) ──
function extractZipBuffer(zipBuf, depth = 0, parentPath = '') {
  const entries = [];
  if (!Buffer.isBuffer(zipBuf) || zipBuf.length < 22 || depth > 3) return entries;

  try {
    // Buscar End of Central Directory (0x06054b50) desde el final
    let eocdOffset = -1;
    const minOffset = Math.max(0, zipBuf.length - 65557);
    for (let i = zipBuf.length - 22; i >= minOffset; i--) {
      if (zipBuf.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) return entries;

    const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
    let cdPos = zipBuf.readUInt32LE(eocdOffset + 16);

    for (let e = 0; e < totalEntries; e++) {
      if (cdPos + 46 > zipBuf.length) break;
      if (zipBuf.readUInt32LE(cdPos) !== 0x02014b50) break;

      const compressionMethod = zipBuf.readUInt16LE(cdPos + 10);
      const compressedSize = zipBuf.readUInt32LE(cdPos + 20);
      const uncompressedSize = zipBuf.readUInt32LE(cdPos + 24);
      const fileNameLen = zipBuf.readUInt16LE(cdPos + 28);
      const extraLen = zipBuf.readUInt16LE(cdPos + 30);
      const commentLen = zipBuf.readUInt16LE(cdPos + 32);
      const localHeaderOffset = zipBuf.readUInt32LE(cdPos + 42);

      const entryPath = zipBuf.subarray(cdPos + 46, cdPos + 46 + fileNameLen).toString('utf8');
      cdPos += 46 + fileNameLen + extraLen + commentLen;

      // Ignorar carpetas y metadatos de macOS/Windows
      if (!entryPath || entryPath.endsWith('/') || entryPath.includes('__MACOSX') || entryPath.endsWith('.DS_Store')) {
        continue;
      }

      const baseName = path.posix.basename(entryPath.replace(/\\/g, '/')).trim();
      if (!baseName || baseName.startsWith('._')) continue;

      if (localHeaderOffset + 30 > zipBuf.length) continue;
      if (zipBuf.readUInt32LE(localHeaderOffset) !== 0x04034b50) continue;

      const localNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      if (dataStart >= zipBuf.length) continue;

      // Soportar ZIP64 del portal del SAT (donde compressedSize = 0xFFFFFFFF)
      const isZip64OrStream = compressedSize === 0xFFFFFFFF || (dataStart + compressedSize > zipBuf.length);
      const compSlice = isZip64OrStream
        ? zipBuf.subarray(dataStart)
        : zipBuf.subarray(dataStart, dataStart + compressedSize);

      let fileBuffer = null;
      if (compressionMethod === 0 && !isZip64OrStream) {
        fileBuffer = Buffer.from(compSlice);
      } else if (compressionMethod === 8) {
        fileBuffer = zlib.inflateRawSync(compSlice);
      }

      if (fileBuffer) {
        const fullEntryPath = parentPath ? `${parentPath}::>${entryPath}` : entryPath;
        const realSize = (uncompressedSize && uncompressedSize !== 0xFFFFFFFF) ? uncompressedSize : fileBuffer.length;

        // Si dentro del ZIP viene otro ZIP (ej. ZIP del SAT dentro de carpeta comprimida), descomprimirlo recursivamente
        if (/\.zip$/i.test(baseName) && depth < 3) {
          const nestedEntries = extractZipBuffer(fileBuffer, depth + 1, fullEntryPath);
          for (const ne of nestedEntries) {
            entries.push(ne);
          }
          continue;
        }

        let mimeType = 'application/octet-stream';
        if (/\.pdf$/i.test(baseName)) mimeType = 'application/pdf';
        else if (/\.xml$/i.test(baseName)) mimeType = 'application/xml';
        else if (/\.png$/i.test(baseName)) mimeType = 'image/png';
        else if (/\.jpe?g$/i.test(baseName)) mimeType = 'image/jpeg';

        entries.push({
          entryPath: fullEntryPath,
          filename: baseName,
          mimeType,
          size: realSize,
          buffer: fileBuffer
        });
      }
    }
  } catch (err) {
    console.warn('⚠️ Error descomprimiendo ZIP en memoria:', err.message);
  }

  return entries;
}

// ── Helpers para Gmail & CFDI ──────────────────────────────

function isAuthorizedBandejaUser(req) {
  const cookies = req.headers.cookie || '';
  const found = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('gestor_emp='));
  const emp = found ? decodeURIComponent(found.split('=')[1]).trim() : '';
  return emp === '9997';
}

function getHeader(headers, name) {
  if (!Array.isArray(headers)) return '';
  const h = headers.find(x => (x.name || '').toLowerCase() === name.toLowerCase());
  return h ? (h.value || '') : '';
}

function parseSender(fromHeader) {
  if (!fromHeader) return { name: 'Desconocido', email: '' };
  const match = fromHeader.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/);
  if (match) {
    const name = (match[1] || '').trim() || match[2].trim();
    const email = (match[2] || '').trim();
    return { name, email };
  }
  return { name: fromHeader.trim(), email: fromHeader.trim() };
}

function extractPartsRecursive(payload, list = [], partPath = '0') {
  if (!payload) return list;
  const filename = (payload.filename || '').trim();
  const mimeType = (payload.mimeType || '').toLowerCase();
  const headers = payload.headers || [];
  const contentId = getHeader(headers, 'Content-ID');
  const disposition = getHeader(headers, 'Content-Disposition').toLowerCase();
  const size = payload.body?.size || 0;

  if (filename) {
    // Filtrar logos/iconos de firma de correo (ej. Firma-Chiapas-Yoni Ruiz.png, image001.png, outlook, etc.)
    const isSignatureImage =
      /\.(png|gif|jpg|jpeg)$/i.test(filename) &&
      (
        /^firma/i.test(filename) ||
        (contentId && disposition.includes('inline') && size > 0 && size < 25000 && /^(image\d+|outlook|logo|firma|banner|icon)/i.test(filename))
      );

    if (!isSignatureImage) {
      list.push({
        filename,
        mimeType: payload.mimeType || 'application/octet-stream',
        attachmentId: payload.body?.attachmentId || `INLINE_${partPath}`,
        inlineData: payload.body?.data || null,
        size
      });
    }
  }

  if (Array.isArray(payload.parts)) {
    payload.parts.forEach((sub, idx) => {
      extractPartsRecursive(sub, list, `${partPath}.${idx}`);
    });
  }
  return list;
}

function findInlinePartByPath(payload, targetPath, currentPath = '0') {
  if (!payload) return null;
  if (currentPath === targetPath) return payload;
  if (Array.isArray(payload.parts)) {
    for (let i = 0; i < payload.parts.length; i++) {
      const found = findInlinePartByPath(payload.parts[i], targetPath, `${currentPath}.${i}`);
      if (found) return found;
    }
  }
  return null;
}

async function fetchAttachmentBuffer(gmail, messageId, part) {
  if (part.inlineData) {
    return Buffer.from(part.inlineData, 'base64');
  }
  if (!part.attachmentId || part.attachmentId.startsWith('INLINE_')) {
    return null;
  }
  const attRes = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: part.attachmentId
  });
  if (!attRes?.data?.data) return null;
  return Buffer.from(attRes.data.data, 'base64');
}

function getAttr(obj, ...names) {
  if (!obj) return '';
  const attrs = obj.$ || obj;
  for (const n of names) {
    if (attrs[n] !== undefined && attrs[n] !== null && String(attrs[n]).trim() !== '') {
      return String(attrs[n]).trim();
    }
    const lowerKey = Object.keys(attrs).find(k => k.toLowerCase() === n.toLowerCase());
    if (lowerKey && attrs[lowerKey] !== undefined && String(attrs[lowerKey]).trim() !== '') {
      return String(attrs[lowerKey]).trim();
    }
  }
  return '';
}

async function parseCFDIXmlBuffer(buffer) {
  try {
    const xmlStr = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
    const parsed = await xml2js.parseStringPromise(xmlStr, {
      explicitArray: false,
      ignoreAttrs: false,
      tagNameProcessors: [xml2js.processors.stripPrefix]
    });

    const comp = parsed?.Comprobante;
    if (!comp) return null;

    const emisor = comp.Emisor;
    const receptor = comp.Receptor;

    // Buscar TimbreFiscalDigital dentro de Complemento
    let tfd = null;
    const complementos = Array.isArray(comp.Complemento) ? comp.Complemento : (comp.Complemento ? [comp.Complemento] : []);
    for (const c of complementos) {
      if (c && c.TimbreFiscalDigital) {
        tfd = Array.isArray(c.TimbreFiscalDigital) ? c.TimbreFiscalDigital[0] : c.TimbreFiscalDigital;
        break;
      }
    }

    const uuid = getAttr(tfd, 'UUID').toUpperCase();
    if (!uuid) return null;

    // Concepto principal
    let concepto = '';
    const conceptosWrap = comp.Conceptos;
    if (conceptosWrap && conceptosWrap.Concepto) {
      const lista = Array.isArray(conceptosWrap.Concepto) ? conceptosWrap.Concepto : [conceptosWrap.Concepto];
      if (lista.length > 0) {
        concepto = getAttr(lista[0], 'Descripcion');
      }
    }

    const serie = getAttr(comp, 'Serie');
    const folioRaw = getAttr(comp, 'Folio');
    const folio = folioRaw || (serie ? `${serie}${folioRaw}` : '') || uuid.slice(0, 8);
    const tipoCode = getAttr(comp, 'TipoDeComprobante').toUpperCase();
    const tipoMap = { I: 'Ingreso', E: 'Egreso', T: 'Traslado', N: 'Nómina', P: 'Pago' };

    return {
      uuid,
      rfcEmisor: getAttr(emisor, 'Rfc') || '—',
      nombreEmisor: getAttr(emisor, 'Nombre') || '—',
      rfcReceptor: getAttr(receptor, 'Rfc') || '—',
      nombreReceptor: getAttr(receptor, 'Nombre') || '—',
      fecha: getAttr(comp, 'Fecha') || '',
      total: parseFloat(getAttr(comp, 'Total') || '0') || 0,
      subTotal: parseFloat(getAttr(comp, 'SubTotal') || '0') || 0,
      moneda: getAttr(comp, 'Moneda') || 'MXN',
      tipoComprobante: tipoCode || 'I',
      tipo: tipoMap[tipoCode] || tipoCode || 'Ingreso',
      folio,
      concepto
    };
  } catch (err) {
    return null;
  }
}

function detectSucursal(cfdi, subject, toHeader, snippet) {
  const combined = `${cfdi?.nombreReceptor || ''} ${cfdi?.rfcReceptor || ''} ${subject || ''} ${toHeader || ''} ${snippet || ''}`.toUpperCase();
  if (combined.includes('PONIENTE')) {
    return 'Toyota Farrera Poniente';
  }
  return 'Toyota Chiapas';
}

function pairXmlsAndPdfs(xmlItems, pdfParts, otherParts) {
  const usedPdfIndices = new Set();
  const facturas = [];

  for (const item of xmlItems) {
    const xmlBase = item.part.filename.replace(/\.xml$/i, '').trim().toLowerCase();
    const folioClean = (item.cfdi?.folio || '').trim().toLowerCase();
    const uuidClean = (item.cfdi?.uuid || '').trim().toLowerCase();

    let matchedIdx = -1;

    // 1. Coincidencia exacta de nombre base (ej. F-4821.xml <-> F-4821.pdf)
    matchedIdx = pdfParts.findIndex((p, idx) => {
      if (usedPdfIndices.has(idx)) return false;
      const pdfBase = p.filename.replace(/\.pdf$/i, '').trim().toLowerCase();
      return pdfBase === xmlBase;
    });

    // 2. Coincidencia por UUID o Folio dentro del nombre del PDF
    if (matchedIdx === -1) {
      matchedIdx = pdfParts.findIndex((p, idx) => {
        if (usedPdfIndices.has(idx)) return false;
        const pdfBase = p.filename.replace(/\.pdf$/i, '').trim().toLowerCase();
        if (uuidClean && uuidClean.length > 8 && pdfBase.includes(uuidClean)) return true;
        if (folioClean && folioClean.length >= 2 && pdfBase.includes(folioClean)) return true;
        if (xmlBase.length >= 4 && (pdfBase.includes(xmlBase) || xmlBase.includes(pdfBase))) return true;
        return false;
      });
    }

    // 3. Si solo hay 1 XML y 1 PDF en el correo, emparejarlos
    if (matchedIdx === -1 && xmlItems.length === 1 && pdfParts.length === 1 && !usedPdfIndices.has(0)) {
      matchedIdx = 0;
    }

    // 4. Si hay PDFs disponibles que no parezcan anexos administrativos, tomar el primero libre
    if (matchedIdx === -1) {
      matchedIdx = pdfParts.findIndex((p, idx) => {
        if (usedPdfIndices.has(idx)) return false;
        return !/(cotizaci|presupuesto|orden|pedido|reporte|evidencia|opinion|constancia|estado.?de.?cuenta|caratula)/i.test(p.filename);
      });
    }

    // 5. Fallback al primer PDF libre
    if (matchedIdx === -1) {
      matchedIdx = pdfParts.findIndex((_, idx) => !usedPdfIndices.has(idx));
    }

    let matchedPdf = null;
    if (matchedIdx !== -1) {
      usedPdfIndices.add(matchedIdx);
      matchedPdf = {
        filename: pdfParts[matchedIdx].filename,
        attachmentId: pdfParts[matchedIdx].attachmentId,
        mimeType: pdfParts[matchedIdx].mimeType || 'application/pdf',
        size: pdfParts[matchedIdx].size
      };
    }

    facturas.push({
      idClave: item.cfdi?.uuid || `${item.messageId}_${item.part.filename}`,
      uuid: item.cfdi?.uuid || '',
      folio: item.cfdi?.folio || item.part.filename.replace(/\.xml$/i, ''),
      rfcEmisor: item.cfdi?.rfcEmisor || '—',
      nombreEmisor: item.cfdi?.nombreEmisor || '—',
      rfcReceptor: item.cfdi?.rfcReceptor || '—',
      nombreReceptor: item.cfdi?.nombreReceptor || '—',
      fechaFactura: item.cfdi?.fecha ? item.cfdi.fecha.slice(0, 10) : '',
      total: item.cfdi?.total || 0,
      moneda: item.cfdi?.moneda || 'MXN',
      tipo: item.cfdi?.tipo || 'Ingreso',
      tipoComprobante: item.cfdi?.tipoComprobante || 'I',
      concepto: item.cfdi?.concepto || '',
      sucursal: item.sucursal || 'Toyota Chiapas',
      xml: {
        filename: item.part.filename,
        attachmentId: item.part.attachmentId,
        mimeType: 'application/xml',
        size: item.part.size
      },
      pdf: matchedPdf
    });
  }

  // Los PDFs que no fueron emparejados con ningún XML pasan a Documentación Adicional
  const adjuntosExtra = [];
  pdfParts.forEach((p, idx) => {
    if (!usedPdfIndices.has(idx)) {
      adjuntosExtra.push({
        filename: p.filename,
        attachmentId: p.attachmentId,
        mimeType: p.mimeType || 'application/pdf',
        size: p.size
      });
    }
  });

  otherParts.forEach(p => {
    adjuntosExtra.push({
      filename: p.filename,
      attachmentId: p.attachmentId,
      mimeType: p.mimeType || 'application/octet-stream',
      size: p.size
    });
  });

  return { facturas, adjuntosExtra };
}

// ── GET /api/mail/inbox ───────────────────────────────────
// Lista correos de Gmail con facturas XML adjuntas, agrupados por correo
router.get('/inbox', async (req, res) => {
  try {
    if (!isAuthorizedBandejaUser(req)) {
      return res.status(403).json({ ok: false, error: 'La Bandeja de Entrada es exclusiva para el trabajador 9997.' });
    }
    const client = getAuthorizedClient();
    if (!client) {
      return res.status(401).json({
        ok: false,
        needsAuth: true,
        error: 'Google no está autorizado. Conecta tu cuenta para leer la Bandeja de Entrada.'
      });
    }

    const { mes = 'todos', anio = 'todos', limit = '35' } = req.query;
    const maxResults = Math.min(Math.max(parseInt(limit, 10) || 35, 5), 60);

    // Construir filtro de búsqueda para Gmail (incluyendo XML sueltos y archivos ZIP, excluyendo Google Payments)
    let gmailQuery = 'has:attachment (filename:xml OR filename:zip) -from:payments-noreply@google.com -"Google Payments"';
    if (anio && anio !== 'todos') {
      const y = parseInt(anio, 10);
      if (!isNaN(y)) {
        if (mes && mes !== 'todos') {
          const m = parseInt(mes, 10);
          if (!isNaN(m) && m >= 1 && m <= 12) {
            // Margen de 1 día en la consulta a Gmail por zonas horarias, luego filtramos exacto
            const startDate = new Date(Date.UTC(y, m - 1, 1));
            startDate.setUTCDate(startDate.getUTCDate() - 1);
            const endDate = new Date(Date.UTC(y, m, 2));
            const fmt = d => `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
            gmailQuery += ` after:${fmt(startDate)} before:${fmt(endDate)}`;
          }
        } else {
          gmailQuery += ` after:${y - 1}/12/31 before:${y + 1}/01/02`;
        }
      }
    }

    const gmail = getGoogle().gmail({ version: 'v1', auth: client });
    let listRes;
    try {
      listRes = await gmail.users.messages.list({
        userId: 'me',
        q: gmailQuery,
        maxResults
      });
    } catch (apiErr) {
      const msg = apiErr?.message || '';
      const status = apiErr?.code || apiErr?.response?.status;
      if (
        status === 403 ||
        status === 401 ||
        msg.toLowerCase().includes('insufficient permission') ||
        msg.toLowerCase().includes('scope') ||
        msg.toLowerCase().includes('invalid_grant')
      ) {
        return res.status(403).json({
          ok: false,
          needsGmailScope: true,
          error: 'Se requiere autorizar el permiso de lectura de Gmail por única vez.'
        });
      }
      throw apiErr;
    }

    const messages = listRes?.data?.messages || [];
    const db = getDB();

    // Preparar consultas de caché y cruces con gastos / bandeja_estado
    const getCacheStmt = db.prepare('SELECT data_json FROM bandeja_cache WHERE message_id = ?');
    const setCacheStmt = db.prepare(`
      INSERT INTO bandeja_cache (message_id, fecha_ms, data_json)
      VALUES (?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET fecha_ms = excluded.fecha_ms, data_json = excluded.data_json
    `);

    const gastosRows = db.prepare("SELECT uuid, id, estatus, sucursal, categoria, folio, sheet_url, factura_url, comprobante_pago_url FROM gastos WHERE uuid IS NOT NULL AND uuid != ''").all();
    const gastosByUuid = new Map();
    for (const g of gastosRows) {
      gastosByUuid.set(String(g.uuid).trim().toUpperCase(), g);
    }

    const estadosRows = db.prepare('SELECT id_clave, uuid, message_id, estatus FROM bandeja_estado').all();
    const estadoByClave = new Map();
    for (const e of estadosRows) {
      if (e.id_clave) estadoByClave.set(String(e.id_clave).trim().toUpperCase(), e.estatus);
      if (e.uuid) estadoByClave.set(String(e.uuid).trim().toUpperCase(), e.estatus);
    }

    const correos = [];

    // Procesar mensajes en lotes pequeños para máxima velocidad sin saturar Gmail API
    const BATCH_SIZE = 6;
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const slice = messages.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(slice.map(async (m) => {
        try {
          const cached = getCacheStmt.get(m.id);
          if (cached && cached.data_json) {
            const parsedCache = JSON.parse(cached.data_json);
            if (parsedCache && parsedCache.cacheVer === 4) {
              if (parsedCache.noInvoice) return null;
              if (Array.isArray(parsedCache.facturas) && parsedCache.facturas.length > 0) {
                return parsedCache;
              }
            }
          }

          const msgRes = await gmail.users.messages.get({
            userId: 'me',
            id: m.id,
            format: 'full'
          });
          const msgData = msgRes.data;
          const headers = msgData.payload?.headers || [];
          const subject = getHeader(headers, 'Subject') || '(Sin asunto)';
          const fromRaw = getHeader(headers, 'From');
          const toRaw = getHeader(headers, 'To');
          const dateHeader = getHeader(headers, 'Date');
          const internalDateMs = parseInt(msgData.internalDate || '0', 10) || Date.parse(dateHeader) || Date.now();
          const fechaCorreoIso = new Date(internalDateMs).toISOString();
          const sender = parseSender(fromRaw);

          const rawPartsAll = extractPartsRecursive(msgData.payload);
          const seenRawKeys = new Set();
          const rawParts = [];
          for (const rp of rawPartsAll) {
            const rKey = `${(rp.filename || '').toLowerCase()}::${rp.size || 0}`;
            if (!seenRawKeys.has(rKey)) {
              seenRawKeys.add(rKey);
              rawParts.push(rp);
            }
          }

          const allParts = [];
          const seenExtractedKeys = new Set();

          // Si hay archivos .zip adjuntos, descomprimirlos automáticamente en memoria (incluyendo ZIPs anidados)
          for (const p of rawParts) {
            if (/\.zip$/i.test(p.filename)) {
              const zipBuf = await fetchAttachmentBuffer(gmail, m.id, p);
              if (zipBuf) {
                const zipEntries = extractZipBuffer(zipBuf);
                for (const entry of zipEntries) {
                  const eKey = `${(entry.filename || '').toLowerCase()}::${entry.size || 0}`;
                  if (seenExtractedKeys.has(eKey)) continue;
                  seenExtractedKeys.add(eKey);
                  allParts.push({
                    filename: entry.filename,
                    mimeType: entry.mimeType,
                    attachmentId: `ZIP_${p.attachmentId}:::${encodeURIComponent(entry.entryPath)}`,
                    preloadedBuffer: entry.buffer,
                    size: entry.size,
                    fromZip: p.filename
                  });
                }
              }
            } else {
              const eKey = `${(p.filename || '').toLowerCase()}::${p.size || 0}`;
              if (!seenExtractedKeys.has(eKey)) {
                seenExtractedKeys.add(eKey);
                allParts.push(p);
              }
            }
          }

          const xmlParts = allParts.filter(p => /\.xml$/i.test(p.filename));
          const pdfParts = allParts.filter(p => /\.pdf$/i.test(p.filename));
          const otherParts = allParts.filter(p => !/\.xml$/i.test(p.filename) && !/\.pdf$/i.test(p.filename));

          if (xmlParts.length === 0) {
            try {
              setCacheStmt.run(m.id, internalDateMs, JSON.stringify({ cacheVer: 4, messageId: m.id, noInvoice: true, facturas: [] }));
            } catch (e) {}
            return null;
          }

          // Descargar y parsear cada XML adjunto (o usar buffer ya descomprimido del ZIP)
          const xmlItems = [];
          for (const xp of xmlParts) {
            const buf = xp.preloadedBuffer || await fetchAttachmentBuffer(gmail, m.id, xp);
            const cfdi = buf ? await parseCFDIXmlBuffer(buf) : null;
            const sucursal = detectSucursal(cfdi, subject, toRaw, msgData.snippet);
            xmlItems.push({
              messageId: m.id,
              part: xp,
              cfdi,
              sucursal
            });
          }

          const { facturas, adjuntosExtra } = pairXmlsAndPdfs(xmlItems, pdfParts, otherParts);
          if (facturas.length === 0) return null;

          const emailItem = {
            cacheVer: 4,
            messageId: m.id,
            threadId: msgData.threadId,
            subject,
            fromName: sender.name,
            fromEmail: sender.email,
            to: toRaw,
            snippet: msgData.snippet || '',
            fechaMs: internalDateMs,
            fechaIso: fechaCorreoIso,
            facturas,
            adjuntosExtra
          };

          try {
            setCacheStmt.run(m.id, internalDateMs, JSON.stringify(emailItem));
          } catch (cacheErr) {}

          return emailItem;
        } catch (msgErr) {
          console.warn(`⚠️ Error procesando correo ${m.id}:`, msgErr.message);
          return null;
        }
      }));

      for (const item of batchResults) {
        if (item) correos.push(item);
      }
    }

    const role = getGestorRole(req);

    // Enriquecer cada factura con su estatus actual (Automático por BD Gastos + Manual)
    const correosEnriquecidos = [];
    for (const c of correos) {
      // Excluir correos de Google Payments / Google Cloud México
      const senderCheck = `${c.fromName || ''} ${c.fromEmail || ''} ${c.subject || ''}`.toLowerCase();
      if (senderCheck.includes('google payments') || senderCheck.includes('payments-noreply@google.com')) {
        continue;
      }

      // Filtrado exacto por mes/año del correo si fue solicitado
      if (anio && anio !== 'todos') {
        const d = new Date(c.fechaMs);
        // Ajustar a hora de México (UTC-6) para evitar brincos de día
        const mxDate = new Date(d.getTime() - 6 * 60 * 60 * 1000);
        const itemYear = String(mxDate.getUTCFullYear());
        const itemMonth = String(mxDate.getUTCMonth() + 1).padStart(2, '0');
        if (itemYear !== String(anio)) continue;
        if (mes && mes !== 'todos' && itemMonth !== String(mes).padStart(2, '0')) continue;
      }

      const facturasSinGoogle = (c.facturas || []).filter(f => {
        const emisorStr = `${f.nombreEmisor || ''} ${f.rfcEmisor || ''}`.toUpperCase();
        return !emisorStr.includes('GOOGLE CLOUD') && !emisorStr.includes('GCM221031837');
      });
      if (facturasSinGoogle.length === 0) continue;

      const facturasConEstatus = facturasSinGoogle.map(f => {
        const uuidUpper = (f.uuid || '').toUpperCase();
        const claveUpper = (f.idClave || '').toUpperCase();
        const gastoMatch = uuidUpper ? gastosByUuid.get(uuidUpper) : null;
        const manualStatus = estadoByClave.get(uuidUpper) || estadoByClave.get(claveUpper) || null;

        let estatus = 'pendiente';
        let origenEstatus = 'pendiente';
        let sucursalFinal = f.sucursal || 'Toyota Chiapas';

        if (gastoMatch) {
          estatus = 'procesado';
          origenEstatus = 'gastos_db';
          if (gastoMatch.sucursal) {
            sucursalFinal = gastoMatch.sucursal;
          } else if (gastoMatch.categoria === 'TOYOTA PONIENTE') {
            sucursalFinal = 'Toyota Farrera Poniente';
          }
        } else if (manualStatus) {
          estatus = manualStatus;
          origenEstatus = 'manual';
        }

        return {
          ...f,
          sucursal: sucursalFinal,
          estatus,
          origenEstatus,
          gastoId: gastoMatch ? gastoMatch.id : null,
          estatusPagoGasto: gastoMatch ? gastoMatch.estatus : null
        };
      });

      // Si el usuario tiene rol restringido (oriente / poniente), adaptar o filtrar
      if (role === 'poniente') {
        facturasConEstatus.forEach(f => {
          if (!f.gastoId) f.sucursal = 'Toyota Farrera Poniente';
        });
      } else if (role === 'oriente') {
        facturasConEstatus.forEach(f => {
          if (!f.gastoId) f.sucursal = 'Toyota Chiapas';
        });
      }

      correosEnriquecidos.push({
        ...c,
        facturas: facturasConEstatus
      });
    }

    // Ordenar del más reciente al más antiguo
    correosEnriquecidos.sort((a, b) => b.fechaMs - a.fechaMs);

    return res.json({
      ok: true,
      correos: correosEnriquecidos
    });
  } catch (err) {
    console.error('🔥 Error en GET /api/mail/inbox:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/mail/attachment/:messageId/:attachmentId ─────
// Descarga o muestra en línea un archivo adjunto de Gmail (.xml, .pdf, imágenes, cotizaciones)
router.get('/attachment/:messageId/:attachmentId', async (req, res) => {
  try {
    if (!isAuthorizedBandejaUser(req)) {
      return res.status(403).send('Acceso exclusivo para el trabajador 9997.');
    }
    const client = getAuthorizedClient();
    if (!client) return res.status(401).send('Google no autorizado');

    const { messageId, attachmentId } = req.params;
    const { filename = 'archivo', mimeType = 'application/octet-stream', download = '0' } = req.query;
    const gmail = getGoogle().gmail({ version: 'v1', auth: client });

    let buffer = null;

    if (attachmentId.startsWith('ZIP_')) {
      // Archivo extraído de un .ZIP adjunto: ZIP_<zipAttId>:::<encodedEntryPath>
      const rawZipSpec = attachmentId.slice(4);
      const sepIdx = rawZipSpec.indexOf(':::');
      if (sepIdx !== -1) {
        const zipAttId = rawZipSpec.slice(0, sepIdx);
        const targetEntryPath = decodeURIComponent(rawZipSpec.slice(sepIdx + 3));
        let zipBuf = null;
        if (zipAttId.startsWith('INLINE_')) {
          const partPath = zipAttId.replace(/^INLINE_/, '');
          const msgRes = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
          const part = findInlinePartByPath(msgRes.data.payload, partPath);
          if (part && part.body && part.body.data) {
            zipBuf = Buffer.from(part.body.data, 'base64');
          }
        } else {
          const attRes = await gmail.users.messages.attachments.get({
            userId: 'me',
            messageId,
            id: zipAttId
          });
          if (attRes?.data?.data) {
            zipBuf = Buffer.from(attRes.data.data, 'base64');
          }
        }
        if (zipBuf) {
          const entries = extractZipBuffer(zipBuf);
          const foundEntry = entries.find(e => e.entryPath === targetEntryPath || e.filename === filename);
          if (foundEntry) {
            buffer = foundEntry.buffer;
          }
        }
      }
    } else if (attachmentId.startsWith('INLINE_')) {
      const partPath = attachmentId.replace(/^INLINE_/, '');
      const msgRes = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
      const part = findInlinePartByPath(msgRes.data.payload, partPath);
      if (part && part.body && part.body.data) {
        buffer = Buffer.from(part.body.data, 'base64');
      }
    } else {
      const attRes = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId
      });
      if (attRes?.data?.data) {
        buffer = Buffer.from(attRes.data.data, 'base64');
      }
    }

    if (!buffer) {
      return res.status(404).send('Archivo adjunto no encontrado en el correo.');
    }

    // Determinar Content-Type limpio
    let contentType = mimeType;
    if (/\.pdf$/i.test(filename)) contentType = 'application/pdf';
    else if (/\.xml$/i.test(filename)) contentType = 'application/xml; charset=utf-8';
    else if (/\.png$/i.test(filename)) contentType = 'image/png';
    else if (/\.jpe?g$/i.test(filename)) contentType = 'image/jpeg';

    const safeFilename = encodeURIComponent(filename).replace(/['()]/g, escape);
    const dispType = download === '1' ? 'attachment' : 'inline';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `${dispType}; filename*=UTF-8''${safeFilename}`);
    res.send(buffer);
  } catch (err) {
    console.error('🔥 Error descargando adjunto de Gmail:', err.message);
    res.status(500).send('Error al obtener adjunto: ' + err.message);
  }
});

// ── PATCH /api/mail/estatus ───────────────────────────────
// Cambia manualmente el estatus de una factura en la Bandeja (pendiente | procesado | descartado)
router.patch('/estatus', async (req, res) => {
  try {
    if (!isAuthorizedBandejaUser(req)) {
      return res.status(403).json({ ok: false, error: 'Acceso exclusivo para el trabajador 9997.' });
    }
    const { idClave, messageId, uuid, estatus } = req.body || {};
    if (!idClave && !uuid) {
      return res.status(400).json({ ok: false, error: 'Falta identificador de la factura (idClave o uuid).' });
    }
    const valid = ['pendiente', 'procesado', 'descartado'];
    if (!valid.includes(estatus)) {
      return res.status(400).json({ ok: false, error: 'Estatus inválido.' });
    }

    const clave = String(uuid || idClave).trim().toUpperCase();
    const db = getDB();

    db.prepare(`
      INSERT INTO bandeja_estado (id_clave, message_id, uuid, estatus, updated_at)
      VALUES (?, ?, ?, ?, datetime('now','localtime'))
      ON CONFLICT(id_clave) DO UPDATE SET
        estatus = excluded.estatus,
        updated_at = excluded.updated_at
    `).run(clave, messageId || '', (uuid || '').toUpperCase(), estatus);

    // Respaldar en segundo plano hacia Google Drive
    backupDatabaseToDrive().catch(e => console.warn('⚠️ Error respaldando estado de bandeja:', e.message));

    return res.json({ ok: true, idClave: clave, estatus });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Rutas Legacy Apple Mail ───────────────────────────────
function searchMailAppleScript(searchTerm) {
  const script = `
tell application "Mail"
  set results to {}
  set allBoxes to every mailbox of every account
  repeat with boxList in allBoxes
    repeat with aBox in boxList
      try
        set theMessages to (messages of aBox whose subject contains "${searchTerm}" or sender contains "${searchTerm}")
        repeat with aMsg in theMessages
          set end of results to {subject:(subject of aMsg), sender:(sender of aMsg), dateSent:(date sent of aMsg) as string, msgId:(message id of aMsg)}
        end repeat
      end try
    end repeat
  end repeat
  return results
end tell`;
  try {
    const out = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 20000 }).toString();
    return out.trim();
  } catch (e) {
    throw new Error('AppleScript falló: ' + e.message);
  }
}

function printMailAppleScript(subject) {
  const script = `
tell application "Mail"
  set targetMsg to missing value
  repeat with aAccount in accounts
    repeat with aBox in mailboxes of aAccount
      try
        set msgs to (messages of aBox whose subject contains "${subject}")
        if (count of msgs) > 0 then
          set targetMsg to item 1 of msgs
          exit repeat
        end if
      end try
    end repeat
    if targetMsg is not missing value then exit repeat
  end repeat
  if targetMsg is not missing value then
    set theWindow to open for reading targetMsg
    tell application "System Events"
      keystroke "p" using command down
      delay 2
      key code 36
    end tell
  end if
end tell`;
  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 30000 });
    return true;
  } catch (e) {
    throw new Error('No se pudo imprimir: ' + e.message);
  }
}

router.post('/buscar', (req, res) => {
  const { searchTerm } = req.body;
  if (!searchTerm) return res.status(400).json({ ok: false, error: 'Falta el término de búsqueda' });

  try {
    const raw = searchMailAppleScript(searchTerm);
    const found = raw.length > 10;
    return res.json({ ok: true, encontrado: found, raw, mensaje: found ? 'Correo encontrado en Apple Mail' : 'No se encontró ningún correo con ese término' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/imprimir', (req, res) => {
  const { subject } = req.body;
  if (!subject) return res.status(400).json({ ok: false, error: 'Falta el asunto del correo' });

  try {
    printMailAppleScript(subject);
    return res.json({ ok: true, mensaje: 'Correo enviado a impresión desde Apple Mail' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
