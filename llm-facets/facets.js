// facets.js
// Compute compressed facets from a raw window slice (array of normalized events).
// Event shape expected: { ts, type, team, player, data? }

function count(events, type, team=null) {
  return events.filter(e => e.type === type && (!team || e.team === team)).length;
}

function uniqTeams(events) {
  const set = new Set(events.map(e => e.team).filter(Boolean));
  const arr = Array.from(set);
  if (arr.length >= 2) return arr.slice(0,2);
  return [arr[0] || "Home", arr[1] || "Away"];
}

function finalThirdTimeApprox(events, team) {
  // Very rough proxy: time between PASS_INTO_BOX/KEY_PASS/SHOT clusters by team.
  // For MVP we count events as seconds proxies (each counts as 5s).
  const weightPerEventSec = 5;
  const n = events.filter(e => e.team===team && (
    e.type==='PASS_INTO_BOX' || e.type==='KEY_PASS' || e.type==='SHOT' || e.type==='GOAL' || e.type==='CORNER'
  )).length;
  return n * weightPerEventSec;
}

function shotOnTarget(e) {
  return e.type==='GOAL' || (e.type==='SHOT' && e.data && e.data.on_target);
}

function toChains(events) {
  // Extremely lightweight possession chain splitter:
  // group consecutive events by same team; summarize start_third (unknown->def/mid), end result.
  // MVP heuristic using event types only.
  const thirdsByType = (e)=>{
    if (e.type==='CORNER' || e.type==='PASS_INTO_BOX' || e.type==='SHOT' || e.type==='GOAL' || e.type==='KEY_PASS' || e.type==='ASSIST')
      return 'att';
    return 'mid'; // unknown -> mid
  };
  const chains = [];
  let cur = null;
  for (const e of events) {
    if (!e.team) continue;
    if (!cur || cur.team !== e.team) {
      if (cur) chains.push(cur);
      cur = { team: e.team, dur: 0, passes: 0, start_third: thirdsByType(e), end: 'lost' };
    }
    cur.dur += 3; // proxy duration
    if (e.type==='PASS_INTO_BOX') cur.passes++;
    // end markers
    if (e.type==='SHOT') cur.end = shotOnTarget(e) ? 'shot_on_target' : 'shot';
    if (e.type==='GOAL') cur.end = 'goal';
    if (e.type==='CORNER') cur.end = 'corner_won';
  }
  if (cur) chains.push(cur);
  return chains;
}

// --- Facets ---

function facet_PTF(events) {
  // Player Threat Focus
  const byPlayer = new Map();
  for (const e of events) {
    if (!e.player) continue;
    const key = `${e.team}::${e.player}`;
    const v = byPlayer.get(key) || { player: e.player, team: e.team, shots:0, sot:0, box_touches:0, key_passes:0 };
    if (e.type==='SHOT' || e.type==='GOAL') v.shots += 1;
    if (shotOnTarget(e)) v.sot += 1;
    if (e.type==='PASS_INTO_BOX') v.box_touches += 1;
    if (e.type==='KEY_PASS' || e.type==='ASSIST') v.key_passes += 1;
    byPlayer.set(key, v);
  }
  const arr = Array.from(byPlayer.values())
    .filter(p => p.shots || p.box_touches || p.key_passes)
    .sort((a,b)=> (b.sot*3 + b.shots*2 + b.box_touches + b.key_passes) - (a.sot*3 + a.shots*2 + a.box_touches + a.key_passes));
  return { top_attackers: arr.slice(0,3) };
}

function facet_PAD(events) {
  // Pressure & Discipline
  const teams = uniqTeams(events);
  const fouls = { [teams[0]]:0, [teams[1]]:0 };
  const cards = { [teams[0]]:0, [teams[1]]:0 };
  const repeat_by = new Map();
  for (const e of events) {
    if (e.type==='FOUL') {
      fouls[e.team] = (fouls[e.team]||0)+1;
      if (e.player) repeat_by.set(e.player, (repeat_by.get(e.player)||0)+1);
    }
    if (e.type==='CARD') {
      cards[e.team] = (cards[e.team]||0)+1;
      if (e.player) repeat_by.set(e.player, (repeat_by.get(e.player)||0)+1);
    }
  }
  const repeat_fouler = Array.from(repeat_by.entries()).filter(([_,c])=>c>=2).map(([player,c])=>({player, count:c}));
  return { fouls, cards, repeat_fouler };
}

function facet_SPT(events) {
  // Set-Piece Threat
  const teams = uniqTeams(events);
  const corners = { [teams[0]]:0, [teams[1]]:0 };
  const fk_dz = { [teams[0]]:0, [teams[1]]:0 }; // proxy via KEY_PASS/PASS_INTO_BOX
  for (const e of events) {
    if (e.type==='CORNER') corners[e.team] = (corners[e.team]||0)+1;
    if (e.type==='KEY_PASS' || e.type==='PASS_INTO_BOX') fk_dz[e.team] = (fk_dz[e.team]||0)+1;
  }
  return { corners, free_kicks_danger_zone: fk_dz };
}

function facet_FTT(events) {
  const teams = uniqTeams(events);
  const tilt = {
    [teams[0]]: finalThirdTimeApprox(events, teams[0]),
    [teams[1]]: finalThirdTimeApprox(events, teams[1])
  };
  const entries = {
    final_third: {
      [teams[0]]: events.filter(e=>e.team===teams[0] && (e.type==='KEY_PASS' || e.type==='PASS_INTO_BOX' || e.type==='CORNER')).length,
      [teams[1]]: events.filter(e=>e.team===teams[1] && (e.type==='KEY_PASS' || e.type==='PASS_INTO_BOX' || e.type==='CORNER')).length,
    },
    box: {
      [teams[0]]: events.filter(e=>e.team===teams[0] && (e.type==='PASS_INTO_BOX' || e.type==='SHOT' || e.type==='GOAL')).length,
      [teams[1]]: events.filter(e=>e.team===teams[1] && (e.type==='PASS_INTO_BOX' || e.type==='SHOT' || e.type==='GOAL')).length,
    }
  };
  return { tilt_seconds_proxy: tilt, entries };
}

function facet_PCS(events) {
  const chains = toChains(events);
  const byTeam = {};
  for (const ch of chains) {
    const T = ch.team;
    if (!byTeam[T]) byTeam[T] = { chains_total:0, reached_final_third:0, reached_box:0, shots:0 };
    byTeam[T].chains_total += 1;
    if (ch.end==='corner_won' || ch.end==='shot' || ch.end==='shot_on_target' || ch.end==='goal') byTeam[T].reached_final_third += 1;
    if (ch.end==='shot' || ch.end==='shot_on_target' || ch.end==='goal') byTeam[T].reached_box += 1;
    if (ch.end==='shot' || ch.end==='shot_on_target' || ch.end==='goal') byTeam[T].shots += 1;
  }
  return { counts: byTeam };
}

function facet_KH(events) {
  const teams = uniqTeams(events);
  const ka = {
    [teams[0]]: { saves:0, claims:0, punches:0 },
    [teams[1]]: { saves:0, claims:0, punches:0 }
  };
  for (const e of events) {
    if (e.type==='SAVE') ka[e.team].saves += 1;
    if (e.type==='CLAIM') ka[e.team].claims += 1;
    if (e.type==='PUNCH') ka[e.team].punches += 1;
  }
  return { keeper_actions: ka };
}

function facet_MMH(events) {
  // Minimal Market Hooks
  const teams = uniqTeams(events);
  const cap = (n, max)=> Math.max(0, Math.min(1, n/max));
  const shotsH = events.filter(e=>e.team===teams[0] && (e.type==='SHOT'||e.type==='GOAL')).length;
  const shotsA = events.filter(e=>e.team===teams[1] && (e.type==='SHOT'||e.type==='GOAL')).length;
  const sotH = events.filter(e=>e.team===teams[0] && (e.type==='GOAL' || (e.type==='SHOT' && e.data?.on_target))).length;
  const fouls = events.filter(e=>e.type==='FOUL').length;
  const corners = events.filter(e=>e.type==='CORNER').length;
  return {
    hooks: {
      goal_in_next_interval_score: {
        [teams[0]]: cap(shotsH + 0.5*sotH, 4),
        [teams[1]]: cap(shotsA, 4)
      },
      cards_in_next_interval_score: cap(fouls, 6),
      corners_in_next_interval_score: cap(corners, 4)
    }
  };
}

function facet_NCMS(events) {
  const teams = uniqTeams(events);
  const shots = {
    [teams[0]]: events.filter(e=>e.team===teams[0] && (e.type==='SHOT'||e.type==='GOAL')).length,
    [teams[1]]: events.filter(e=>e.team===teams[1] && (e.type==='SHOT'||e.type==='GOAL')).length
  };
  const sot = {
    [teams[0]]: events.filter(e=>e.team===teams[0] && (e.type==='GOAL' || (e.type==='SHOT' && e.data?.on_target))).length,
    [teams[1]]: events.filter(e=>e.team===teams[1] && (e.type==='GOAL' || (e.type==='SHOT' && e.data?.on_target))).length
  };
  const corners = {
    [teams[0]]: events.filter(e=>e.team===teams[0] && e.type==='CORNER').length,
    [teams[1]]: events.filter(e=>e.team===teams[1] && e.type==='CORNER').length
  };
  const cards = {
    [teams[0]]: events.filter(e=>e.team===teams[0] && e.type==='CARD').length,
    [teams[1]]: events.filter(e=>e.team===teams[1] && e.type==='CARD').length
  };
  const summary = `Shots ${teams[0]} ${shots[teams[0]]}/${sot[teams[0]]} on target, ${teams[1]} ${shots[teams[1]]}/${sot[teams[1]]}. Corners ${teams[0]} ${corners[teams[0]]}-${corners[teams[1]]} ${teams[1]}. Cards ${teams[0]} ${cards[teams[0]]}, ${teams[1]} ${cards[teams[1]]}.`;
  return { summary, stats: { shots, sot, corners, cards } };
}

module.exports = {
  facet_PTF, facet_PAD, facet_SPT, facet_FTT, facet_PCS, facet_KH, facet_MMH, facet_NCMS
};
