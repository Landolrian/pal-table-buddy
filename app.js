'use strict';

const KEY = 'tableBuddy.v1';
const COLORS = ['red', 'blue', 'green', 'purple', 'gray'];
const PHASES = [
  { name: 'Stand', hint: 'Stand up all your cards and souls.' },
  { name: 'Draw', hint: 'Draw 1 card.' },
  { name: 'Soul', hint: 'Move 2 souls from your soul deck to your soul area.' },
  { name: 'Main', hint: 'Play cards and attack. Once per turn you may rest 3 souls to draw 1.' },
  { name: 'End', hint: 'Damage on Pals and structures goes back to 0.' },
];
const GAME_KEYS = ['players', 'wins', 'night', 'turn', 'active', 'first', 'phase', 'stage', 'tossWinner', 'loser'];

const $ = (sel, root = document) => root.querySelector(sel);
const clone = o => JSON.parse(JSON.stringify(o));

function freshState(prev) {
  const minutes = prev ? prev.timerMin : 30;
  return {
    players: [0, 1].map(i => ({
      name: prev ? prev.players[i].name : (i ? 'Opponent' : 'You'),
      color: prev ? prev.players[i].color : (i ? 'red' : 'blue'),
      life: 10,
      material: 0,
      ingredient: 0,
    })),
    wins: prev ? prev.wins : [0, 0],
    night: false,
    turn: 0,
    active: null,
    first: null,
    phase: 0,
    stage: 'start', // start → toss → choose → play → over
    tossWinner: null,
    loser: null,
    timerMin: minutes,
    timerLeft: minutes * 60000,
    timerEnd: null,
    timerDone: false,
    sound: prev ? prev.sound : true,
    steps: prev ? prev.steps : true,
    nightTipShown: prev ? prev.nightTipShown : false,
  };
}

let state;
let history = [];
try {
  const saved = JSON.parse(localStorage.getItem(KEY));
  state = Object.assign(freshState(), saved.state);
  history = saved.history || [];
} catch {
  state = freshState();
}
if (state.stage === 'toss') state.stage = 'start';

function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ state, history: history.slice(-60) })); } catch {}
}

// ---------- Undo ----------
let lastCheckpoint = { key: null, at: 0 };
function checkpoint(key) {
  const now = Date.now();
  // Rapid taps on the same counter count as one change, so one Undo reverses them all.
  if (key && key === lastCheckpoint.key && now - lastCheckpoint.at < 1500) {
    lastCheckpoint.at = now;
    return;
  }
  const snap = {};
  for (const k of GAME_KEYS) snap[k] = clone(state[k]);
  history.push(snap);
  if (history.length > 60) history.shift();
  lastCheckpoint = { key, at: now };
}
function undo() {
  const snap = history.pop();
  if (!snap) return toast('Nothing to undo');
  // Keep names/colors as they are now; only the game numbers roll back.
  const names = state.players.map(p => ({ name: p.name, color: p.color }));
  Object.assign(state, snap);
  state.players.forEach((p, i) => Object.assign(p, names[i]));
  lastCheckpoint = { key: null, at: 0 };
  clearTimeout(overTimer);
  for (const d of deltas) { d.value = 0; }
  save();
  render();
  toast('Undone');
}

// ---------- Panels ----------
const panels = [0, 1].map(i => {
  const el = $(`.panel[data-p="${i}"]`);
  el.appendChild($('#panel-tpl').content.cloneNode(true));
  return {
    el,
    name: $('.name', el),
    wins: $('.wins', el),
    life: $('.life', el),
    delta: $('.delta', el),
    phase: $('.phase', el),
    steps: $('.phase-steps', el),
    hint: $('.phase-hint', el),
    cover: $('.cover', el),
    counters: {
      material: $('[data-k="material"] b', el),
      ingredient: $('[data-k="ingredient"] b', el),
    },
  };
});
const deltas = [{ value: 0, timer: 0 }, { value: 0, timer: 0 }];
let overTimer = 0;

panels.forEach((p, i) => {
  $('.minus', p.el).addEventListener('click', () => changeLife(i, -1));
  $('.plus', p.el).addEventListener('click', () => changeLife(i, 1));
  p.el.querySelectorAll('.counter').forEach(c => {
    c.querySelectorAll('.c-btn').forEach(b => b.addEventListener('click', () => {
      const k = c.dataset.k;
      const d = Number(b.dataset.d);
      if (state.players[i][k] + d < 0) return;
      checkpoint(`${k}${i}`);
      state.players[i][k] += d;
      save();
      render();
    }));
  });
  $('.phase-next', p.el).addEventListener('click', nextPhase);
  p.cover.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (b) coverAction(b.dataset.act, i);
  });
});

function changeLife(i, d) {
  if (state.stage !== 'play' && state.stage !== 'over') return;
  checkpoint(`life${i}`);
  state.players[i].life += d;
  const dl = deltas[i];
  dl.value += d;
  clearTimeout(dl.timer);
  dl.timer = setTimeout(() => { dl.value = 0; renderDelta(i); }, 1500);
  renderDelta(i);
  if (d < 0) blip(220, 0.05); else blip(520, 0.05);
  checkGameOver();
  save();
  render();
}

function checkGameOver() {
  clearTimeout(overTimer);
  const out = state.players.findIndex(p => p.life <= 0);
  if (state.stage === 'over' && out === -1) {
    // A correction brought the loser back above 0.
    state.wins[1 - state.loser] = Math.max(0, state.wins[1 - state.loser] - 1);
    state.stage = 'play';
    state.loser = null;
    return;
  }
  if (out === -1 || state.stage !== 'play') return;
  // Short pause so an accidental tap can be fixed before the game ends.
  overTimer = setTimeout(() => {
    if (state.players[out].life > 0 || state.stage !== 'play') return;
    state.stage = 'over';
    state.loser = out;
    state.wins[1 - out] += 1;
    pauseTimer();
    fanfare();
    save();
    render();
  }, 1600);
}

function renderDelta(i) {
  const { value } = deltas[i];
  const el = panels[i].delta;
  el.textContent = value > 0 ? `+${value}` : String(value);
  el.className = 'delta' + (value ? ' show' : '') + (value < 0 ? ' neg' : value > 0 ? ' pos' : '');
}

// ---------- Turns & phases ----------
function drawSkipped() {
  return state.turn === 1 && state.active === state.first;
}
function nextPhase() {
  if (state.stage !== 'play') return;
  checkpoint(null);
  if (state.phase < PHASES.length - 1) {
    state.phase += 1;
    if (state.phase === 1 && drawSkipped()) state.phase = 2;
  } else {
    state.active = 1 - state.active;
    state.turn += 1;
    state.phase = 0;
    blip(660, 0.08);
  }
  save();
  render();
}

function coverAction(act, i) {
  if (act === 'random') return coinToss();
  if (act === 'first0' || act === 'first1') return startGame(Number(act.slice(-1)));
  if (act === 'gofirst') return startGame(i);
  if (act === 'gosecond') return startGame(1 - i);
  if (act === 'rematch') return newGame();
  if (act === 'undo') return undo();
}

function coinToss() {
  state.stage = 'toss';
  render();
  const winner = Math.random() < 0.5 ? 0 : 1;
  let flips = 0;
  const total = 9 + winner; // ends on the winner
  const step = () => {
    panels.forEach((p, idx) => p.cover.classList.toggle('flash', idx === flips % 2));
    blip(400 + (flips % 2) * 120, 0.04);
    flips += 1;
    if (flips <= total) setTimeout(step, 110 + flips * 12);
    else {
      panels.forEach(p => p.cover.classList.remove('flash'));
      state.stage = 'choose';
      state.tossWinner = winner;
      save();
      render();
    }
  };
  step();
}

function startGame(first) {
  checkpoint(null);
  state.stage = 'play';
  state.first = first;
  state.active = first;
  state.turn = 1;
  state.phase = 0;
  if (state.timerMin > 0 && !state.timerDone) startTimer();
  save();
  render();
  toast(`${state.players[1 - first].name}: put 1 soul in your soul area. Everyone draws 5 (you may redraw once).`, 5200);
}

function newGame() {
  const keep = state;
  state = freshState(keep);
  history = [];
  clearTimeout(overTimer);
  save();
  render();
}

// ---------- Timer ----------
function startTimer() {
  if (state.timerMin <= 0 || state.timerDone) return;
  state.timerEnd = Date.now() + state.timerLeft;
}
function pauseTimer() {
  if (!state.timerEnd) return;
  state.timerLeft = Math.max(0, state.timerEnd - Date.now());
  state.timerEnd = null;
}
function resetTimer() {
  state.timerEnd = null;
  state.timerDone = false;
  state.timerLeft = state.timerMin * 60000;
}
function timeLeft() {
  return state.timerEnd ? Math.max(0, state.timerEnd - Date.now()) : state.timerLeft;
}
function tick() {
  const btn = $('#timer');
  const text = $('#timer-text');
  const ico = $('#timer-ico');
  if (state.timerMin <= 0) {
    btn.className = 'strip-btn timer off';
    text.textContent = 'No timer';
    ico.textContent = '⏱';
    return;
  }
  const left = timeLeft();
  if (state.timerEnd && left <= 0) {
    state.timerEnd = null;
    state.timerLeft = 0;
    state.timerDone = true;
    save();
    timesUp();
  }
  const secs = Math.ceil(left / 1000);
  text.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  ico.textContent = state.timerDone ? '⏰' : state.timerEnd ? '⏸' : '▶';
  btn.className = 'strip-btn timer' +
    (state.timerDone ? ' done' : state.timerEnd ? (left < 5 * 60000 ? ' warn running' : ' running') : '');
}
$('#timer').addEventListener('click', () => {
  if (state.timerMin <= 0) return toast('Timer is off. Turn it on in the menu.');
  if (state.timerDone) return toast('Time is up. Restart it from the menu.');
  if (state.timerEnd) pauseTimer(); else startTimer();
  save();
  tick();
});
function timesUp() {
  [0, 350, 700].forEach(t => setTimeout(() => blip(880, 0.25), t));
  toast("⏰ Time's up! Finish the current action. If nobody has won, both players lose.", 6500);
}
setInterval(tick, 250);

// ---------- Night ----------
$('#night').addEventListener('click', () => {
  checkpoint(null);
  state.night = !state.night;
  if (state.night && !state.nightTipShown) {
    state.nightTipShown = true;
    toast('🌙 It is night. Nocturnal Pals get +300 Power.', 3200);
  }
  blip(state.night ? 300 : 600, 0.08);
  save();
  render();
});

$('#undo').addEventListener('click', undo);

// ---------- Render ----------
function render() {
  const app = $('#app');
  app.className = state.night ? 'night' : 'day';
  $('#night-ico').textContent = state.night ? '🌙' : '☀️';
  $('#night-lbl').textContent = state.night ? 'Night' : 'Day';

  panels.forEach((p, i) => {
    const pl = state.players[i];
    p.el.dataset.color = pl.color;
    p.el.classList.toggle('active', state.stage === 'play' && state.active === i);
    p.el.classList.toggle('low', pl.life <= 3);
    p.name.textContent = pl.name;
    const bits = [];
    if (state.stage === 'play' && state.active === i) bits.push(`Turn ${state.turn}`);
    if (state.wins[0] + state.wins[1] > 0) bits.push(`🏆 ${state.wins[i]}`);
    p.wins.textContent = bits.join('  ·  ');
    p.life.textContent = pl.life;
    p.counters.material.textContent = pl.material;
    p.counters.ingredient.textContent = pl.ingredient;

    const showPhase = state.steps && state.stage === 'play' && state.active === i;
    p.phase.hidden = !showPhase;
    if (showPhase) {
      p.steps.innerHTML = PHASES.map((ph, n) => {
        const cls = n === 1 && drawSkipped() ? 'skip' : n === state.phase ? 'now' : n < state.phase ? 'done' : '';
        return `<span class="${cls}">${ph.name}</span>`;
      }).join('');
      const ph = PHASES[state.phase];
      const last = state.phase === PHASES.length - 1;
      p.hint.innerHTML = `<b>${ph.name}:</b> ${ph.hint}`;
      $('.phase-go', p.el).textContent = last ? 'End turn ✓' : 'Next ▸';
    }
    renderCover(p, i);
  });
}

// "You win" reads better than "You wins" when the default name is kept.
function wins(name) {
  return `${esc(name)} ${name.trim().toLowerCase() === 'you' ? 'win' : 'wins'}`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderCover(p, i) {
  const me = state.players[i];
  const them = state.players[1 - i];
  let html = '';
  if (state.stage === 'start' || state.stage === 'toss') {
    html = `
      <h2>Who goes first?</h2>
      <p>The rules pick a player at random, and that player decides.</p>
      <div class="row"><button class="pill primary" data-act="random">🎲 Pick at random</button></div>
      <div class="row">
        <button class="pill" data-act="first${i}">${esc(me.name)} first</button>
        <button class="pill" data-act="first${1 - i}">${esc(them.name)} first</button>
      </div>`;
  } else if (state.stage === 'choose') {
    html = state.tossWinner === i
      ? `<h2>🎲 ${esc(me.name)} won!</h2><p>Do you want to go first or second?</p>
         <div class="row"><button class="pill primary" data-act="gofirst">Go first</button>
         <button class="pill" data-act="gosecond">Go second</button></div>
         <p>First player skips their first draw. Second player starts with 1 soul.</p>`
      : `<h2>${esc(them.name)} won the toss</h2><p>Waiting for them to choose…</p>`;
  } else if (state.stage === 'over') {
    html = state.loser === i
      ? `<h2>Out of life</h2><p>${wins(them.name)} this game.</p>
         <div class="row"><button class="pill primary" data-act="rematch">Rematch</button>
         <button class="pill" data-act="undo">Oops, undo</button></div>`
      : `<div class="trophy">🏆</div><h2>${wins(me.name)}!</h2><p>Games won: ${state.wins[i]}</p>
         <div class="row"><button class="pill primary" data-act="rematch">Rematch</button></div>`;
  }
  p.cover.hidden = !html;
  if (p.cover.dataset.html !== html) {
    p.cover.innerHTML = html;
    p.cover.dataset.html = html;
  }
}

// ---------- Menu ----------
const sheet = $('#sheet');
function openSheet() {
  sheet.hidden = false;
  document.querySelectorAll('.player-edit').forEach(row => {
    const i = Number(row.dataset.p);
    $('input', row).value = state.players[i].name;
    $('.swatches', row).innerHTML = COLORS.map(c =>
      `<button class="swatch${state.players[i].color === c ? ' on' : ''}" data-c="${c}" style="background:var(--${c})" aria-label="${c}"></button>`).join('');
  });
  markSeg('#timer-seg', 'min', state.timerMin);
  markSeg('#sound-seg', 'sound', state.sound ? 1 : 0);
  markSeg('#steps-seg', 'steps', state.steps ? 1 : 0);
}
function markSeg(sel, key, val) {
  document.querySelectorAll(`${sel} button`).forEach(b => b.classList.toggle('on', Number(b.dataset[key]) === Number(val)));
}
$('#menu').addEventListener('click', openSheet);
$('#sheet-close').addEventListener('click', () => { sheet.hidden = true; });
sheet.addEventListener('click', e => { if (e.target === sheet) sheet.hidden = true; });

document.querySelectorAll('.player-edit').forEach(row => {
  const i = Number(row.dataset.p);
  $('input', row).addEventListener('input', e => {
    state.players[i].name = e.target.value.trim() || (i ? 'Opponent' : 'You');
    save();
    render();
  });
  $('input', row).addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  $('.swatches', row).addEventListener('click', e => {
    const b = e.target.closest('.swatch');
    if (!b) return;
    state.players[i].color = b.dataset.c;
    save();
    render();
    openSheet();
  });
});
$('#timer-seg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  state.timerMin = Number(b.dataset.min);
  resetTimer();
  if (state.stage === 'play' && state.timerMin > 0) startTimer();
  markSeg('#timer-seg', 'min', state.timerMin);
  save();
  tick();
});
$('#timer-reset').addEventListener('click', () => {
  resetTimer();
  if (state.stage === 'play' && state.timerMin > 0) startTimer();
  save();
  tick();
  sheet.hidden = true;
  toast('Timer restarted');
});
$('#sound-seg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  state.sound = b.dataset.sound === '1';
  markSeg('#sound-seg', 'sound', state.sound ? 1 : 0);
  save();
});
$('#steps-seg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  state.steps = b.dataset.steps === '1';
  markSeg('#steps-seg', 'steps', state.steps ? 1 : 0);
  save();
  render();
});
$('#new-game').addEventListener('click', () => { newGame(); sheet.hidden = true; });
$('#reset-wins').addEventListener('click', () => {
  state.wins = [0, 0];
  save();
  render();
  toast('Win count reset');
});

// ---------- Toast ----------
let toastTimer = 0;
function toast(msg, ms = 1600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
$('#toast').addEventListener('click', () => { $('#toast').hidden = true; });

// ---------- Sound ----------
let audio = null;
function blip(freq, dur) {
  if (!state.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = freq;
    o.type = 'triangle';
    g.gain.setValueAtTime(0.12, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur + 0.05);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + dur + 0.06);
  } catch {}
}
function fanfare() {
  [523, 659, 784, 1047].forEach((f, n) => setTimeout(() => blip(f, 0.14), n * 130));
}

// ---------- Keep the screen on while the phone sits on the table ----------
let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {}
}
document.addEventListener('pointerdown', keepAwake);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { keepAwake(); render(); tick(); }
});

// Block pinch-zoom and double-tap zoom so stray taps never shift the layout.
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });

render();
tick();
