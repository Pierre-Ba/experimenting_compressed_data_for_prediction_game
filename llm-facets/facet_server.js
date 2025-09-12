// facet_server.js
// Express API to serve facets: POST /get_facet { gameId, start, end, facet }
// Now reads from Supabase database instead of source files

const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const {
  facet_PTF, facet_PAD, facet_SPT, facet_FTT, facet_PCS, facet_KH, facet_MMH, facet_NCMS
} = require('./facets');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL || 'http://127.0.0.1:54321',
  process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
);

const app = express();
app.use(bodyParser.json());

async function readRawWindow(gameId, start, end) {
  console.log(`Looking for database windows in range ${start}-${end} for game ${gameId}`);
  
  try {
    // Query database for windows that overlap with the requested range
    // A window overlaps if: window.start < end AND window.end > start
    const { data: windows, error: windowsError } = await supabase
      .from('windows')
      .select('*')
      .eq('game_id', gameId)
      .lt('start_sec', end)
      .gt('end_sec', start)
      .order('start_sec', { ascending: true });
    
    if (windowsError) {
      console.error('Database error fetching windows:', windowsError.message);
      return null;
    }
    
    if (!windows || windows.length === 0) {
      console.error('MISS: No database windows found for range', start, '-', end);
      return null;
    }
    
    console.log(`Found ${windows.length} database windows for range ${start}-${end}`);
    
    // Get raw snapshots for these windows
    const allEvents = [];
    for (const window of windows) {
      const { data: snapshots, error: snapshotsError } = await supabase
        .from('snapshots')
        .select('raw_json')
        .eq('window_id', window.id)
        .eq('compressed_kind', 'raw')
        .single();
      
      if (snapshotsError) {
        console.error(`Error fetching raw snapshot for window ${window.start_sec}-${window.end_sec}:`, snapshotsError.message);
        continue;
      }
      
      if (snapshots?.raw_json && Array.isArray(snapshots.raw_json)) {
        allEvents.push(...snapshots.raw_json);
        console.log(`Read window ${window.start_sec}-${window.end_sec}: ${snapshots.raw_json.length} events`);
      } else {
        console.log(`Window ${window.start_sec}-${window.end_sec}: no raw events`);
      }
    }
    
    console.log(`MERGED: Found ${windows.length} windows for range ${start}-${end}, total events: ${allEvents.length}`);
    return allEvents;
    
  } catch (error) {
    console.error('Error in readRawWindow:', error.message);
    return null;
  }
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

app.post('/get_facet', async (req, res) => {
  try {
    const { gameId, start, end, facet } = req.body || {};
    if (!gameId || typeof start!=='number' || typeof end!=='number' || !facet) {
      return res.status(400).json({ error: 'Missing gameId/start/end/facet' });
    }
    const fn = facetMap[facet];
    if (!fn) return res.status(400).json({ error: 'Unknown facet' });
    
    const events = await readRawWindow(gameId, start, end);
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
