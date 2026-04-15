const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const { launchBrowser, IS_CLOUD } = require('../utils/browser');


const router = express.Router();

const SAT_URL = 'https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc';
const SOAP_ACTION = 'http://tempuri.org/IConsultaCFDIService/Consulta';

function buildSoapEnvelope(re, rr, tt, id) {
  const totalFormatted = parseFloat(tt).toFixed(6);
  const expresion = `?re=${encodeURIComponent(re)}&rr=${encodeURIComponent(rr)}&tt=${totalFormatted}&id=${id}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:Consulta>
      <tem:expresionImpresa><![CDATA[${expresion}]]></tem:expresionImpresa>
    </tem:Consulta>
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function parseSoapResponse(xmlResponse) {
  const result = await xml2js.parseStringPromise(xmlResponse, { explicitArray: false });
  const body = result['s:Envelope']['s:Body'];
  const cr = body['ConsultaResponse']['ConsultaResult'];
  return {
    codigoEstatus: cr['a:CodigoEstatus'] || '',
    estado: cr['a:Estado'] || '',
    esCancelable: cr['a:EsCancelable'] || '',
    estatusCancelacion: cr['a:EstatusCancelacion'] || '',
    efos: cr['a:ValidezEFOS'] || ''
  };
}

// POST /api/sat/verificar
router.post('/verificar', async (req, res) => {
  console.log('📡 [SAT] Recibida solicitud de verificación:', req.body.uuid);
  const { uuid, rfcEmisor, rfcReceptor, total } = req.body;
  
  if (!uuid || !rfcEmisor || !rfcReceptor || !total) {
    console.error('❌ [SAT] Faltan campos:', req.body);
    return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
  }

  try {
    const soap = buildSoapEnvelope(rfcEmisor, rfcReceptor, total, uuid);
    console.log('📤 [SAT] Enviando SOAP a:', SAT_URL);
    
    const response = await axios.post(SAT_URL, soap, {
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': SOAP_ACTION },
      });
    
    console.log('📥 [SAT] Respuesta SOAP recibida');
    const satResult = await parseSoapResponse(response.data);
    console.log('✅ [SAT] Resultado:', satResult.estado);
    
    return res.json({ ok: true, ...satResult });
  } catch (err) {
    console.error('🔥 [SAT] Error en verificación:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
