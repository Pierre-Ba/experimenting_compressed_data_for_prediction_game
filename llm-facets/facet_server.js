// facet_server.js
// Express API to serve facets: POST /get_facet { gameId, start, end, facet }
// It expects snapshot files created by snapshotter.js under ./snapshots/<gameId>/raw/<start>-<end>.json

const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const {
  facet_PTF, facet_PAD, facet_SPT, facet_FTT, facet_PCS, facet_KH, facet_MMH, facet_NCMS
} = require('./facets');

const app = express();
app.use(bodyParser.json());

function readRawWindow(gameId, start, end) {
  const p = path.join(process.cwd(), 'snapshots', gameId, 'raw', `${start}-${end}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const facetMap = {
  PTF: facet_PTF,
  PAD: facet_PAD,
  SPT: facet_SPT,
  FTT: facet_FTT,
  PCS: facet_PCS,
  KH: facet_KH,
  MMH: facet_MMH,
  NCMS: facet_NCMS
};

app.post('/get_facet', (req, res) => {
  try {
    const { gameId, start, end, facet } = req.body || {};
    if (!gameId || typeof start!=='number' || typeof end!=='number' || !facet) {
      return res.status(400).json({ error: 'Missing gameId/start/end/facet' });
    }
    const fn = facetMap[facet];
    if (!fn) return res.status(400).json({ error: 'Unknown facet' });
    const events = readRawWindow(gameId, start, end);
    if (!events) return res.status(404).json({ error: 'Raw window not found' });
    const payload = fn(events);
    return res.json({ window: { start, end }, facet, data: payload });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal error', details: String(e) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Facet server on :${PORT}`));
