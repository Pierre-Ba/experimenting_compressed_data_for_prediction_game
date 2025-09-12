// supabase_reader.js
// Simple service to fetch snapshots from Supabase in chronological order

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export async function getGameSnapshots(gameId) {
  try {
    // Get all windows for this game, ordered by start time
    const { data: windows, error: windowsError } = await supabase
      .from('windows')
      .select('*')
      .eq('game_id', gameId)
      .order('start_sec', { ascending: true });

    if (windowsError) throw windowsError;

    // Get snapshots for each window
    const snapshots = [];
    for (const window of windows) {
      const { data: windowSnapshots, error: snapshotsError } = await supabase
        .from('snapshots')
        .select('*')
        .eq('window_id', window.id);

      if (snapshotsError) throw snapshotsError;

      // Add window info to each snapshot
      windowSnapshots.forEach(snapshot => {
        snapshots.push({
          ...snapshot,
          window_start: window.start_sec,
          window_end: window.end_sec,
          minute_range: `${Math.floor(window.start_sec/60)}-${Math.floor(window.end_sec/60)}`
        });
      });
    }

    return snapshots;
  } catch (error) {
    console.error('Error fetching snapshots:', error);
    throw error;
  }
}

export async function getSnapshotsByTimeRange(gameId, startSec, endSec) {
  const allSnapshots = await getGameSnapshots(gameId);
  
  return allSnapshots.filter(snapshot => 
    snapshot.window_start >= startSec && snapshot.window_end <= endSec
  );
}

export async function getCompressedSnapshots(gameId, startSec, endSec) {
  const snapshots = await getSnapshotsByTimeRange(gameId, startSec, endSec);
  // The actual schema stores compressed data in compressed_json column
  // Only return snapshots that actually have compressed data (STKM kind)
  return snapshots
    .filter(s => s.compressed_kind === 'STKM' && s.compressed_json && Object.keys(s.compressed_json).length > 0)
    .map(s => ({
      ...s,
      kind: 'compressed',
      payload: s.compressed_json
    }));
}

export async function getRawSnapshots(gameId, startSec, endSec) {
  const snapshots = await getSnapshotsByTimeRange(gameId, startSec, endSec);
  // The actual schema stores raw data in raw_json column
  return snapshots.map(s => ({
    ...s,
    kind: 'raw', 
    payload: s.raw_json
  }));
}

// Test function
async function test() {
  const gameId = 'barcelona-atletico-2018-11-24';
  console.log('Testing Supabase reader...');
  
  try {
    const snapshots = await getGameSnapshots(gameId);
    console.log(`Found ${snapshots.length} snapshots for ${gameId}`);
    
    // Show first few snapshots
    snapshots.slice(0, 3).forEach(s => {
      console.log(`${s.minute_range}: ${s.compressed_kind || 'unknown'} snapshot`);
      console.log(`  - Raw data: ${s.raw_json ? 'yes' : 'no'}`);
      console.log(`  - Compressed data: ${s.compressed_json ? 'yes' : 'no'}`);
    });
  } catch (error) {
    console.error('Test failed:', error);
  }
}

// Run test if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  test();
}
