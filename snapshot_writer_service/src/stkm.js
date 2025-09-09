/**
 * Minimal STKM compressor:
 * - counts: shots, shots_on_target, goals, corners, fouls, yellows, reds
 * - first/last timestamps
 * - notable moments (simple heuristic)
 */
export function stkmCompress(events, windowMeta) {
    const counts = {
      shots: 0, shots_on_target: 0, goals: 0,
      corners: 0, fouls: 0, yellows: 0, reds: 0
    };
  
    const moments = [];
    let firstTs = null, lastTs = null;
  
    for (const e of events) {
      const t = (e.type || '').toLowerCase();
  
      if (firstTs === null) firstTs = e.tSec ?? null;
      lastTs = e.tSec ?? lastTs;
  
      if (t.includes('goal')) {
        counts.goals++;
        moments.push({ kind: 'goal', team: e.team, player: e.player, tSec: e.tSec });
      }
      if (t.includes('shot')) counts.shots++;
      if (t.includes('shot_on_target') || t.includes('on target')) counts.shots_on_target++;
      if (t.includes('corner')) counts.corners++;
      if (t.includes('foul')) counts.fouls++;
      if (t.includes('yellow')) { counts.yellows++; moments.push({ kind: 'yellow', team: e.team, player: e.player, tSec: e.tSec }); }
      if (t.includes('red'))    { counts.reds++;    moments.push({ kind: 'red',    team: e.team, player: e.player, tSec: e.tSec }); }
    }
  
    return {
      kind: 'STKM',
      window: windowMeta,           // { gameId, start, end }
      counts,
      first_event_tSec: firstTs,
      last_event_tSec: lastTs,
      notable_moments: moments.slice(0, 6) // cap for brevity
    };
  }
  