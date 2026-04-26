import { auth, db, signOut, onAuthStateChanged, doc, getDoc, setDoc, updateDoc, onSnapshot } from './firebase-config.js';

// ==================== ثوابت ودوال مساعدة ====================
const TYPE_META = {
  PH: { label: "قوة جسدية", multiplier: 2.0 },
  IQ: { label: "ذكاء وتعلّم", multiplier: 1.7 },
  SP: { label: "انضباط وروحانية", multiplier: 1.5 },
  XX: { label: "عادة سيئة", multiplier: 0 },
};

const GLITCH_WORDS = ["الأبطال", "الأنمي", "قدوتك", "نفسك"];
const RANKS = [
  { key: "E", days: 0, label: "E" },
  { key: "D", days: 7, label: "D" },
  { key: "C", days: 30, label: "C" },
  { key: "B", days: 90, label: "B" },
  { key: "A", days: 180, label: "A" },
  { key: "S", days: 365, label: "S Elite" },
];
const RANK_PENALTY = { E:0, D:1, C:3, B:7, A:14, S:30 };
const QUOTES = [
  "أنت لا تبحث عن الحماس… أنت تبني الانضباط.",
  "اليوم ليس اختبارًا لقوتك… بل لالتزامك.",
  "خطوة واحدة يوميًا تُصنع منها الأساطير.",
  "كل مهمة تُنجزها = مستوى جديد في شخصيتك.",
  "لا تُفاوض على عاداتك الأساسية.",
  "النتائج لا تأتي بسرعة… لكنّها تأتي بثبات.",
];

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function pct(n) { return Math.round(n * 100); }
function todayKeyLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function randomQuote() { return QUOTES[Math.floor(Math.random() * QUOTES.length)]; }

function expToLevel(totalExp) {
  const a = 120;
  let level = 1;
  let expForNext = a;
  let remaining = totalExp;
  while (remaining >= expForNext && level <= 200) {
    remaining -= expForNext;
    level++;
    expForNext = Math.round(a * Math.pow(level, 1.15));
  }
  return { level, expIntoLevel: remaining, expForNext };
}

function rankFromStreak(days) {
  let cur = RANKS[0];
  for (const r of RANKS) if (days >= r.days) cur = r;
  return cur;
}

function msToMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime() - now.getTime();
}

function formatCountdown(ms) {
  const total = Math.max(0, ms);
  const s = Math.floor(total/1000);
  return `${String(Math.floor(s/3600)).padStart(2,"0")}:${String(Math.floor((s%3600)/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
}

function dailyMaxExpByLevel(level) {
  return Math.round(220 + 18 * Math.log2(level + 1) + 0.8 * Math.sqrt(level));
}

function expPenaltyByLevel(level) {
  return Math.round(dailyMaxExpByLevel(level) * (0.95 + (Math.max(1, level) - 1) * 0.03));
}

function computeToday(tasks, level) {
  const totals = {
    scoreDone: 0, scoreTotal: 0, completion: 0, exp: 0, expMax: 0,
    weightedProgress: 0, byType: {PH:0, IQ:0, SP:0}, byTypePotential: {PH:0, IQ:0, SP:0}, xxTriggered: false
  };
  const SCORE_UNIT = 10;
  let wSum = 0;

  for (const t of tasks) {
    const importance = Number(t.importance || 1);
    const weight = importance * SCORE_UNIT;
    const target = Math.max(1, Number(t.target || 1));
    const done = clamp(Number(t.done || 0), 0, target);
    const ratio = target > 0 ? (done / target) : 0;

    if (t.type === "XX") {
      if (done > 0) totals.xxTriggered = true;
      continue;
    }

    totals.scoreTotal += weight;
    totals.scoreDone += weight * ratio;
    totals.byType[t.type] += weight * ratio;
    totals.byTypePotential[t.type] += weight;
    wSum += importance * TYPE_META[t.type].multiplier;
  }

  totals.completion = totals.scoreTotal > 0 ? (totals.scoreDone / totals.scoreTotal) : 0;
  if (totals.xxTriggered) totals.completion = Math.max(0, totals.completion - 0.5);
  const dailyMax = dailyMaxExpByLevel(level);
  totals.expMax = dailyMax;
  totals.weightedProgress = wSum > 0 ? totals.completion : 0;
  totals.exp = Math.round(totals.weightedProgress * dailyMax);
  return totals;
}

function getDefaultState() {
  return {
    day: todayKeyLocal(),
    tasks: [
      { id: "t1", title: "صلاة", target: 5, importance: 5, type: "SP", done: 0 },
      { id: "t2", title: "Push-ups", target: 300, importance: 4, type: "PH", done: 0 },
      { id: "t3", title: "قراءة", target: 30, importance: 3, type: "IQ", done: 0 },
    ],
    totalExp: 0,
    hp: 100,
    commitDays: 0,
    shameDays: 0,
    perfectStreak: 0,
    lastCommitDay: null,
    lockedUntil: null,
    zeroLockUsed: true,
    lifetimeByType: { PH: 0, IQ: 0, SP: 0 },
    lifetimePotentialByType: { PH: 0, IQ: 0, SP: 0 },
    commitHistory: [],
    expHistory: []
  };
}

// ==================== دوال الرسم ====================
function drawRadar(canvas, values) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const cx = w/2, cy = h/2 + 10;
  const radius = Math.min(w, h) * 0.33;
  
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  for (let r=1; r<=4; r++) {
    ctx.beginPath();
    for (let i=0; i<3; i++) {
      const a = -Math.PI/2 + i*(2*Math.PI/3);
      const x = cx + Math.cos(a)*radius*(r/4);
      const y = cy + Math.sin(a)*radius*(r/4);
      if (i===0) ctx.moveTo(x,y);
      else ctx.lineTo(x,y);
    }
    ctx.closePath();
    ctx.stroke();
  }
  
  const angles = [-Math.PI/2, -Math.PI/2 + (2*Math.PI/3), -Math.PI/2 + (4*Math.PI/3)];
  ["PH","IQ","SP"].forEach((lab,i) => {
    const a = angles[i];
    ctx.beginPath();
    ctx.moveTo(cx,cy);
    ctx.lineTo(cx + Math.cos(a)*radius, cy + Math.sin(a)*radius);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    ctx.font = "16px 'IBM Plex Sans Arabic', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(lab, cx + Math.cos(a)*(radius+26), cy + Math.sin(a)*(radius+18));
  });
  
  const pPH = (values?.PH||0)/100, pIQ = (values?.IQ||0)/100, pSP = (values?.SP||0)/100;
  const points = [pPH,pIQ,pSP].map((v,i) => ({
    x: cx + Math.cos(angles[i])*radius*v,
    y: cy + Math.sin(angles[i])*radius*v
  }));
  
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  ctx.lineTo(points[1].x, points[1].y);
  ctx.lineTo(points[2].x, points[2].y);
  ctx.closePath();
  ctx.fillStyle = "rgba(0,229,255,0.20)";
  ctx.fill();
  ctx.strokeStyle = "rgba(0,229,255,0.88)";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawCommitChart(canvas, points) {
  if (!canvas || !points?.length) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const pad = 18;
  const innerW = w - pad*2, innerH = h - pad*2;
  
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  for (let i=0; i<=4; i++) {
    const y = pad + (innerH * (i/4));
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w-pad, y); ctx.stroke();
  }
  
  const maxY = Math.max(1, ...points.map(p=>p.v));
  const minY = Math.min(...points.map(p=>p.v));
  const range = Math.max(1, maxY - minY);
  
  const xs = points.map((p,i) => ({
    x: pad + (innerW * (i/(points.length-1))),
    y: pad + innerH - (((p.v - minY) / range) * innerH)
  }));
  
  ctx.beginPath();
  ctx.moveTo(xs[0].x, xs[0].y);
  for (let i=1; i<xs.length; i++) ctx.lineTo(xs[i].x, xs[i].y);
  ctx.strokeStyle = "rgba(0,229,255,0.92)";
  ctx.lineWidth = 2;
  ctx.stroke();
  
  ctx.fillStyle = "rgba(0,229,255,0.95)";
  xs.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI*2); ctx.fill(); });
}

function drawExpChart(canvas, points) {
  if (!canvas || !points?.length) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const pad = 18;
  const innerW = w - pad*2, innerH = h - pad*2;
  
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  for (let i=0; i<=4; i++) {
    const y = pad + (innerH * (i/4));
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w-pad, y); ctx.stroke();
  }
  
  const maxY = Math.max(1, ...points.map(p=>p.v));
  const minY = Math.min(...points.map(p=>p.v));
  const range = Math.max(1, maxY - minY);
  
  const xs = points.map((p,i) => ({
    x: pad + (innerW * (i/(points.length-1))),
    y: pad + innerH - (((p.v - minY) / range) * innerH)
  }));
  
  ctx.beginPath();
  ctx.moveTo(xs[0].x, xs[0].y);
  for (let i=1; i<xs.length; i++) ctx.lineTo(xs[i].x, xs[i].y);
  ctx.strokeStyle = "rgba(168,85,247,0.92)";
  ctx.lineWidth = 2;
  ctx.stroke();
  
  ctx.fillStyle = "rgba(168,85,247,0.95)";
  xs.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI*2); ctx.fill(); });
}

// ==================== main app ====================
let currentUser = null;
let currentState = null;
let unsubscribeFirestore = null;
let glitchInterval = null;
let countdownInterval = null;
let finalizeInterval = null;

async function saveToFirestore(state) {
  if (!currentUser) return;
  const userDocRef = doc(db, "users", currentUser.uid);
  await setDoc(userDocRef, {
    ...state,
    lastUpdated: new Date().toISOString()
  }, { merge: true });
}

function updateTask(taskId, patch) {
  if (!currentState) return;
  const newTasks = currentState.tasks.map(t => t.id === taskId ? { ...t, ...patch } : t);
  const newState = { ...currentState, tasks: newTasks };
  currentState = newState;
  saveToFirestore(newState);
  renderApp();
}

function removeTask(taskId) {
  if (!currentState) return;
  const newState = { ...currentState, tasks: currentState.tasks.filter(t => t.id !== taskId) };
  currentState = newState;
  saveToFirestore(newState);
  renderApp();
}

function addTask(title, target, importance, type) {
  if (!currentState || !title.trim()) return;
  const newTask = {
    id: `t${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    title: title.trim(),
    target: clamp(Number(target)||1, 1, 9999),
    importance: Number(importance),
    type: type,
    done: 0
  };
  const newState = { ...currentState, tasks: [...currentState.tasks, newTask] };
  currentState = newState;
  saveToFirestore(newState);
  renderApp();
}

function closeOneDay(prev, dayKeyToClose, totals, qualifies, completion) {
  const failHard = completion < 0.5;
  const delta = qualifies ? 6 : (failHard ? -12 : -4);
  const hp = clamp(prev.hp + delta, 0, 100);
  
  let lockedUntil = prev.lockedUntil;
  let zeroLockUsed = prev.zeroLockUsed === undefined ? true : prev.zeroLockUsed;
  
  if (hp > 0) {
    zeroLockUsed = false;
    if (lockedUntil && Date.now() >= lockedUntil) lockedUntil = null;
  } else if (!zeroLockUsed) {
    lockedUntil = Date.now() + 24*60*60*1000;
    zeroLockUsed = true;
  }
  
  const currentRank = rankFromStreak(prev.commitDays).key;
  const penaltyDays = qualifies ? 0 : (RANK_PENALTY[currentRank] ?? 0);
  const commitDays = qualifies ? (prev.commitDays + 1) : Math.max(0, prev.commitDays - penaltyDays);
  const lastCommitDay = qualifies ? dayKeyToClose : prev.lastCommitDay;
  
  const lifetimeByType = {
    PH: prev.lifetimeByType.PH + totals.byType.PH,
    IQ: prev.lifetimeByType.IQ + totals.byType.IQ,
    SP: prev.lifetimeByType.SP + totals.byType.SP
  };
  const lifetimePotentialByType = {
    PH: prev.lifetimePotentialByType.PH + totals.byTypePotential.PH,
    IQ: prev.lifetimePotentialByType.IQ + totals.byTypePotential.IQ,
    SP: prev.lifetimePotentialByType.SP + totals.byTypePotential.SP
  };
  
  const currLevel = expToLevel(prev.totalExp).level;
  const expPenalty = expPenaltyByLevel(currLevel);
  const totalExp = qualifies ? (prev.totalExp + Math.round(totals.exp)) : Math.max(0, prev.totalExp - expPenalty);
  
  let shameDays = Number(prev.shameDays || 0);
  let perfectStreak = Number(prev.perfectStreak || 0);
  
  if (completion <= 0) {
    shameDays += 1;
    perfectStreak = 0;
  } else if (completion >= 1) {
    perfectStreak += 1;
    if (perfectStreak >= 10) {
      shameDays = Math.max(0, shameDays - Math.floor(perfectStreak / 10));
      perfectStreak = perfectStreak % 10;
    }
  } else {
    perfectStreak = 0;
  }
  
  const tasks = prev.tasks.map(t => ({ ...t, done: 0 }));
  const commitHistory = [...(prev.commitHistory || []), { d: dayKeyToClose, v: commitDays }];
  const expHistory = [...(prev.expHistory || []), { d: dayKeyToClose, v: totalExp }];
  
  if (commitHistory.length > 365) commitHistory.shift();
  if (expHistory.length > 365) expHistory.shift();
  
  return {
    ...prev, hp, lockedUntil, zeroLockUsed, commitDays, shameDays, perfectStreak,
    lastCommitDay, lifetimeByType, lifetimePotentialByType, totalExp, tasks,
    commitHistory, expHistory
  };
}

function finalizeDay() {
  if (!currentState) return;
  const today = todayKeyLocal();
  if (currentState.day === today) return;
  
  let s = { ...currentState };
  const currLevel = expToLevel(s.totalExp).level;
  const totals = computeToday(s.tasks, currLevel);
  const qualifies = totals.completion >= 0.7;
  s = closeOneDay(s, s.day, totals, qualifies, totals.completion);
  s.day = today;
  
  currentState = s;
  saveToFirestore(s);
  renderApp();
}

function handleLogout() {
  if (unsubscribeFirestore) unsubscribeFirestore();
  if (glitchInterval) clearInterval(glitchInterval);
  if (countdownInterval) clearInterval(countdownInterval);
  if (finalizeInterval) clearInterval(finalizeInterval);
  signOut(auth).then(() => {
    sessionStorage.clear();
    window.location.href = 'index.html';
  });
}

function renderApp() {
  if (!currentState || !currentUser) return;
  
  const appDiv = document.getElementById('app');
  const level = expToLevel(currentState.totalExp);
  const computed = computeToday(currentState.tasks, level.level);
  const rank = rankFromStreak(currentState.commitDays);
  const isLocked = currentState.lockedUntil && Date.now() < currentState.lockedUntil;
  const countdownMs = msToMidnight();
  const quote = randomQuote();
  
  const radarLive = (() => {
    const g = currentState.lifetimeByType;
    const p = currentState.lifetimePotentialByType;
    const ph = (p.PH + computed.byTypePotential.PH) > 0 ? ((g.PH + computed.byType.PH) / (p.PH + computed.byTypePotential.PH)) : 0;
    const iq = (p.IQ + computed.byTypePotential.IQ) > 0 ? ((g.IQ + computed.byType.IQ) / (p.IQ + computed.byTypePotential.IQ)) : 0;
    const sp = (p.SP + computed.byTypePotential.SP) > 0 ? ((g.SP + computed.byType.SP) / (p.SP + computed.byTypePotential.SP)) : 0;
    return { PH: Math.round(ph*100), IQ: Math.round(iq*100), SP: Math.round(sp*100) };
  })();
  
  const html = `
    <div class="wrap">
      <header class="header">
        <div class="hero-glow"></div>
        <div class="top-row">
          <div>
            <div class="badge"><span class="dot"></span><span>RISE SYSTEM™</span><span>No-Mercy Mode</span></div>
            <h1 class="title">طوّر شخصيتك… مثل <span class="glitch-word" id="glitchWord" data-text="${GLITCH_WORDS[0]}">${GLITCH_WORDS[0]}</span></h1>
            <p class="subtitle">لوحة التطوير اليومية - حفظ تلقائي في السحابة</p>
            <div class="chips">
              <div class="chip">اليوم: <span class="chip-mono">${currentState.day}</span></div>
              ${currentState.lastCommitDay ? `<div class="chip">آخر يوم محسوب: <span class="chip-mono">${currentState.lastCommitDay}</span></div>` : ''}
            </div>
          </div>
          <div class="stats">
            <div class="stat stat-hp"><div class="stat-k">HP</div><div class="stat-v">${currentState.hp}/100</div></div>
            <div class="stat stat-level"><div class="stat-k">LEVEL</div><div class="stat-v">${level.level}</div><div class="stat-s">${Math.round(level.expIntoLevel)}/${level.expForNext}</div></div>
            <div class="stat stat-rank"><div class="stat-k">RANK</div><div class="stat-v">${rank.label}</div><div class="stat-s">${currentState.commitDays} يوم</div></div>
          </div>
        </div>
      </header>
      
      <main class="main">
        <section>
          <div class="card">
            <div class="progress-row">
              <div><div class="label">TODAY PROGRESS</div><div class="big">${pct(computed.completion)}%</div></div>
              <div class="progress-side"><div class="bar"><div class="fill" style="width:${pct(computed.completion)}%"></div></div></div>
            </div>
            <div class="task-list">
              ${currentState.tasks.map(t => {
                const target = Math.max(1, Number(t.target||1));
                const done = clamp(Number(t.done||0), 0, target);
                const itemPct = (done/target)*100;
                const typeClass = {PH:'ph',IQ:'iq',SP:'sp',XX:'xx'}[t.type];
                return `
                  <div class="task">
                    <div class="task-top">
                      <div><div class="tag ${typeClass}">${t.type} • imp ${t.importance}/5</div><div class="task-title">${t.title}</div>
                      <div class="task-meta"><span>Target: ${t.target}</span><span>Done: ${t.done}</span><span>Progress: ${Math.round(itemPct)}%</span></div></div>
                      <div class="task-controls">
                        <div class="bar" style="width:160px"><div class="fill" style="width:${itemPct}%"></div></div>
                        <input class="input small" type="number" min="0" step="1" value="${t.done}" data-id="${t.id}" data-field="done" ${isLocked ? 'disabled' : ''}>
                        <button class="btn" data-action="remove" data-id="${t.id}" ${isLocked ? 'disabled' : ''}>✕</button>
                      </div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
          
          <div class="card">
            <div class="label">ADD TASK</div>
            <div class="add-grid">
              <input class="input" id="newTitle" placeholder="مثال: دراسة / قرآن / جري" ${isLocked ? 'disabled' : ''}>
              <input class="input" type="number" id="newTarget" value="10" min="1" ${isLocked ? 'disabled' : ''}>
              <select class="input" id="newImportance" ${isLocked ? 'disabled' : ''}>${[1,2,3,4,5].map(v=>`<option value="${v}">${v}</option>`).join('')}</select>
              <select class="input" id="newType" ${isLocked ? 'disabled' : ''}><option>PH</option><option>IQ</option><option>SP</option><option>XX</option></select>
              <button class="btn btn-green" id="addTaskBtn" ${isLocked ? 'disabled' : ''}>+</button>
            </div>
          </div>
          
          <div class="card">
            <div class="label">COMMIT STATS</div>
            <div class="mini-stats">
              <div class="mini"><div class="mini-v">${currentState.commitDays}<span> يوم</span></div><div class="mini-l">Commit Days</div></div>
              <div class="mini"><div class="mini-v">${rank.label}</div><div class="mini-l">RANK الحالي</div></div>
            </div>
            <div class="chart-wrap"><canvas id="commitChart" width="720" height="280"></canvas></div>
          </div>
          
          <div class="card">
            <div class="label">NET EXP</div>
            <div class="mini-stats">
              <div class="mini"><div class="mini-v">${Math.round(currentState.totalExp)}</div><div class="mini-l">Net EXP</div></div>
              <div class="mini"><div class="mini-v">${level.level}</div><div class="mini-l">Level</div></div>
            </div>
            <div class="chart-wrap"><canvas id="expChart" width="720" height="280"></canvas></div>
          </div>
        </section>
        
        <aside>
          <div class="card">
            <div class="label">LIVE STATUS</div>
            <div class="countdown"><span>الحفظ التلقائي بعد:</span><span class="mono" id="countdown">${formatCountdown(countdownMs)}</span></div>
            ${isLocked ? `<div class="locked"><div class="locked-row"><span>تم قفل الدخول مؤقتًا بسبب HP = 0.</span></div></div>` : ''}
            <div class="radar-wrap"><canvas id="radarCanvas" width="520" height="420"></canvas></div>
            <div class="mini-stats">
              <div class="mini"><div class="mini-v">${radarLive.PH}%</div><div class="mini-l">${TYPE_META.PH.label}</div></div>
              <div class="mini"><div class="mini-v">${radarLive.IQ}%</div><div class="mini-l">${TYPE_META.IQ.label}</div></div>
              <div class="mini"><div class="mini-v">${radarLive.SP}%</div><div class="mini-l">${TYPE_META.SP.label}</div></div>
            </div>
          </div>
          
          <div class="shame-panel">
            <div class="shame-head"><span class="shame-title">SHAME DAYS</span><span class="shame-value">${currentState.shameDays || 0}</span></div>
            <div class="shame-sub">سلسلة 100%: ${currentState.perfectStreak || 0}/10</div>
          </div>
        </aside>
      </main>
      
      <footer class="footer">
        <div>${currentUser?.email || ''}</div>
        <div><button class="logout-btn" id="logoutBtn">تسجيل خروج</button></div>
      </footer>
    </div>
  `;
  
  appDiv.innerHTML = html;
  
  setTimeout(() => {
    const radarCanvas = document.getElementById('radarCanvas');
    if (radarCanvas) drawRadar(radarCanvas, radarLive);
    const commitCanvas = document.getElementById('commitChart');
    if (commitCanvas && currentState.commitHistory) drawCommitChart(commitCanvas, currentState.commitHistory);
    const expCanvas = document.getElementById('expChart');
    if (expCanvas && currentState.expHistory) drawExpChart(expCanvas, currentState.expHistory);
  }, 50);
  
  document.querySelectorAll('input[data-id]').forEach(inp => {
    inp.addEventListener('change', (e) => {
      if (isLocked) return;
      updateTask(inp.dataset.id, { done: parseInt(inp.value) || 0 });
    });
  });
  document.querySelectorAll('[data-action="remove"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (isLocked) return;
      removeTask(btn.dataset.id);
    });
  });
  const addBtn = document.getElementById('addTaskBtn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      if (isLocked) return;
      const title = document.getElementById('newTitle').value;
      const target = parseInt(document.getElementById('newTarget').value);
      const importance = parseInt(document.getElementById('newImportance').value);
      const type = document.getElementById('newType').value;
      addTask(title, target, importance, type);
      document.getElementById('newTitle').value = '';
    });
  }
  document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);
  
  let idx = 0;
  if (glitchInterval) clearInterval(glitchInterval);
  glitchInterval = setInterval(() => {
    const glitchSpan = document.getElementById('glitchWord');
    if (glitchSpan) {
      idx = (idx + 1) % GLITCH_WORDS.length;
      glitchSpan.textContent = GLITCH_WORDS[idx];
      glitchSpan.setAttribute('data-text', GLITCH_WORDS[idx]);
      glitchSpan.className = `glitch-word ${GLITCH_WORDS[idx] === 'نفسك' ? 'self-word' : ''}`;
    }
  }, 1800);
}

function initializeAppWithUser(user) {
  currentUser = user;
  const userDocRef = doc(db, "users", user.uid);
  
  unsubscribeFirestore = onSnapshot(userDocRef, async (docSnap) => {
    if (docSnap.exists()) {
      currentState = docSnap.data();
      const today = todayKeyLocal();
      if (currentState.day !== today) {
        finalizeDay();
      }
    } else {
      const defaultState = getDefaultState();
      currentState = defaultState;
      await setDoc(userDocRef, defaultState);
    }
    renderApp();
  });
  
  if (finalizeInterval) clearInterval(finalizeInterval);
  finalizeInterval = setInterval(() => {
    if (currentState && todayKeyLocal() !== currentState.day) {
      finalizeDay();
    }
  }, 60000);
  
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    const countdownSpan = document.getElementById('countdown');
    if (countdownSpan) countdownSpan.textContent = formatCountdown(msToMidnight());
  }, 1000);
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = 'index.html';
    return;
  }
  initializeAppWithUser(user);
});