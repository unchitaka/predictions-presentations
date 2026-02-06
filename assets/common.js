
/* ---------------------------
   Assumptions for this HTML
   ---------------------------
   - The visuals are a toy model to explain the mechanism.
   - We keep the same core ideas used by the real script:
     cohorts by month, Weibull-like aging curve (alpha/beta),
     scaling (calibration), CM start date + effect, EOL, and spike filtering.
*/

/* ---------------------------
   Utility helpers
   --------------------------- */
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmt = (x, d=2) => (Number.isFinite(x) ? x.toFixed(d) : "—");
const fmtInt = (x) => (Number.isFinite(x) ? Math.round(x).toString() : "—");

function svgEl(id){ return document.getElementById(id); }
function setAttr(el, k, v){ el.setAttribute(k, v); }
function setText(el, t){ el.textContent = t; }

/* ---------------------------
   Toy data + model logic
   --------------------------- */
const state = {
  slide: 1,
  totalSlides: 13,

  // curve params (alpha, beta)
  alpha: 60,     // months
  beta: 3.5,

  // calibration
  scale: 1.0,

  // cohorts: last 18 months of production (toy values)
  cohorts: [],       // {monthIndex: -17..0, machines}
  moveMonths: 0,     // slide3

  // cm
  cmStartIdx: -6,    // cohort monthIndex threshold (after this => reduced)
  cmEff: 0.70,       // remaining risk proportion after CM
  cmDragging: false,

  // eol
  eolOn: false,
  eolRel: 18,        // months ahead where EOL happens (relative)

  // spike game
  spikeData: [],     // last 12 months counts
  spikeExcluded: new Set(),
};

function initToyData(){
  // Cohorts: monthIndex -17..0 (0 is most recent)
  const base = [780, 820, 760, 790, 810, 845, 870, 860, 830, 800, 790, 805, 820, 835, 860, 880, 900, 910];
  state.cohorts = base.map((m, i) => ({ monthIndex: i - (base.length - 1), machines: m }));

  // Spike game: 12 months, with one spike
  const normal = [8, 10, 9, 12, 11, 10, 9, 13, 12, 11, 10, 9];
  const spikeAt = 7;
  const spikeVal = 45;
  state.spikeData = normal.map((v, i) => i === spikeAt ? spikeVal : v);
  state.spikeExcluded = new Set();
}
initToyData();

// Weibull CDF: F(t) = 1 - exp(-(t/alpha)^beta), t>=0
function weibullCDF(t, alpha, beta){
  if (t <= 0) return 0;
  return 1 - Math.exp(-Math.pow(t/alpha, beta));
}
// Discrete probability of failing within month [m, m+1)
function pFailInMonth(m, alpha, beta){
  const a = weibullCDF(m, alpha, beta);
  const b = weibullCDF(m+1, alpha, beta);
  return clamp(b - a, 0, 1);
}
// Risk curve for visualization: scaled version of pFailInMonth across ages 0..60
function riskCurvePoints(alpha, beta, maxAge=60, n=61){
  const pts = [];
  let maxR = 0;
  for(let age=0; age<=maxAge; age++){
    const r = pFailInMonth(age, alpha, beta);
    maxR = Math.max(maxR, r);
    pts.push({age, r});
  }
  // normalize for plotting
  const denom = maxR > 0 ? maxR : 1;
  return pts.map(p => ({age:p.age, r:p.r/denom, raw:p.r}));
}

// Expected complaints for a target month offset (0=next month) using current cohorts
// - Existing cohorts age by (moveMonths + targetOffset) beyond their baseline age.
// - Apply CM reduction to cohorts made after cmStartIdx.
// - Apply scaling factor.
function expectedComplaintsForOffset(targetOffset, opts={}){
  const alpha = state.alpha;
  const beta = state.beta;
  const scale = opts.scale ?? state.scale;
  const cmEff = opts.cmEff ?? state.cmEff;
  const cmStartIdx = opts.cmStartIdx ?? state.cmStartIdx;
  const includeFutureCohorts = opts.includeFutureCohorts ?? true;
  const eolOn = opts.eolOn ?? state.eolOn;
  const eolRel = opts.eolRel ?? state.eolRel;

  // Build cohorts including future production if required
  const cohorts = buildCohortsForForecast(includeFutureCohorts, eolOn, eolRel);

  // compute expected for the month "targetOffset" ahead of "now"
  let total = 0;
  for(const c of cohorts){
    // Cohort age for the target month:
    // If c.monthIndex = 0 is most recent cohort month.
    // Age in months at "now" is -c.monthIndex (older -> bigger).
    // For a future month offset, add targetOffset.
    const ageNow = -c.monthIndex;
    const ageAtTarget = ageNow + targetOffset;

    if(ageAtTarget < 0) continue;

    const r = pFailInMonth(ageAtTarget, alpha, beta);

    // CM: cohorts made after CM start have reduced remaining risk
    const cmFactor = (c.monthIndex > cmStartIdx) ? cmEff : 1.0;

    total += c.machines * r * cmFactor;
  }
  return total * scale;
}

// Build cohorts for forecast window: existing + (optional) future cohorts
function buildCohortsForForecast(includeFuture, eolOn, eolRel){
  const existing = state.cohorts.map(x => ({...x}));

  if(!includeFuture) return existing;

  // average of last 6 months production for future
  const last6 = existing.slice(-6).map(c => c.machines);
  const avg = last6.reduce((a,b)=>a+b,0) / Math.max(1,last6.length);

  // Add future cohorts monthIndex = 1..30 (toy horizon)
  const horizon = 30;
  for(let mi=1; mi<=horizon; mi++){
    // If EOL ON, stop adding new cohorts after eolRel
    if(eolOn && mi > eolRel) break;
    const noise = (Math.sin(mi*0.7)*12); // deterministic small variation
    existing.push({ monthIndex: mi, machines: Math.max(0, Math.round(avg + noise)) });
  }
  return existing;
}

// Total machines in field at some offset: sum of all cohorts up to that time (excluding future beyond offset)
function machinesInFieldAtOffset(offset, opts={}){
  const eolOn = opts.eolOn ?? state.eolOn;
  const eolRel = opts.eolRel ?? state.eolRel;
  const cohorts = buildCohortsForForecast(true, eolOn, eolRel);
  // At offset months in future, cohorts with monthIndex <= offset exist
  return cohorts.filter(c => c.monthIndex <= offset).reduce((s,c)=>s+c.machines,0);
}

/* ---------------------------
   Rendering: Slide switching
   --------------------------- */
const slides = Array.from(document.querySelectorAll(".slide"));

function updateProgress(){
  const p = state.slide;
  const n = state.totalSlides;
  document.getElementById("ptext").textContent = `${p} / ${n}`;
  document.getElementById("pbar").style.width = `${(p-1)/(n-1)*100}%`;
  document.getElementById("prevBtn").disabled = (p === 1);
  document.getElementById("nextBtn").textContent = (p === n) ? "Done" : "Next";
}

function showSlide(n){
  state.slide = clamp(n, 1, state.totalSlides);
  slides.forEach(s => s.classList.remove("active"));
  const el = document.querySelector(`.slide[data-slide="${state.slide}"]`);
  if(el) el.classList.add("active");
  updateProgress();
  onEnterSlide(state.slide);
}

document.getElementById("prevBtn").addEventListener("click", ()=>showSlide(state.slide-1));
document.getElementById("nextBtn").addEventListener("click", ()=>{
  if(state.slide === state.totalSlides) return;
  showSlide(state.slide+1);
});

// keyboard navigation
window.addEventListener("keydown", (e)=>{
  if(e.key === "ArrowLeft") showSlide(state.slide-1);
  if(e.key === "ArrowRight") showSlide(state.slide+1);
  if(/^[1-9]$/.test(e.key)){
    const k = parseInt(e.key,10);
    // jump within range
    if(k <= state.totalSlides) showSlide(k);
  }
});

// Slide enter hook
function onEnterSlide(n){
  if(n === 1) animateIntro();
  if(n === 3) renderCohorts();
  if(n === 4) renderRiskDot();
  if(n === 5) renderRiskCurve5(true);
  if(n === 6) renderContrib();
  if(n === 7) renderCalibrationBars(false);
  if(n === 8) renderCM();
  if(n === 9) renderEOL();
  if(n === 10) renderSpike();
  if(n === 11) renderOutputExample();
}

// Slide 1 animation
function animateIntro(){
  const shade = svgEl("futureShade");
  const forecast = svgEl("forecastLine");
  shade.style.transition = "opacity 280ms ease";
  forecast.style.transition = "opacity 280ms ease";
  // reset then show
  shade.setAttribute("opacity","0");
  forecast.setAttribute("opacity","0");
  setTimeout(()=>{
    shade.setAttribute("opacity","1");
    forecast.setAttribute("opacity","1");
  }, 80);
}

/* ---------------------------
   Slide 2: tap boxes
   --------------------------- */
["tapHistory","tapCurve","tapCM"].forEach(id=>{
  const el = document.getElementById(id);
  if(!el) return;
  el.addEventListener("click", ()=> el.classList.toggle("open"));
});

/* ---------------------------
   Slide 3: cohorts bars
   --------------------------- */
const cohortMove = document.getElementById("cohortMove");
if(cohortMove) cohortMove.addEventListener("input", ()=>{
  state.moveMonths = parseInt(cohortMove.value,10);
  document.getElementById("cohortMoveLabel").textContent = state.moveMonths;
  renderCohorts();
});
function renderCohorts(){
  const g = svgEl("cohortBars");
  g.innerHTML = "";

  // Fixed x-axis domain for Page 3 (past -> future)
  const minIdx = -17;
  const maxIdx = 24;

  const xL = 90, xR = 810, yBase = 420, maxH = 240;

  // Build bins for stable layout
  const bins = [];
  for(let idx=minIdx; idx<=maxIdx; idx++) bins.push(idx);

  // Existing cohorts map (past production)
  const existingMap = new Map(state.cohorts.map(c => [c.monthIndex, c.machines]));

  // Simple production projection for future months:
  // average of last 6 existing months (monthIndex -5..0), with small deterministic variation
  const last6 = state.cohorts.slice(-6).map(c => c.machines);
  const avg = last6.length ? (last6.reduce((a,b)=>a+b,0) / last6.length) : 0;

  function projectedMachines(idx){
    // idx > 0: future cohort month
    // Keep deterministic but slightly varied so future bars aren't all identical
    const noise = Math.sin(idx * 0.55) * 12; // deterministic
    return Math.max(0, Math.round(avg + noise));
  }

  // Machines per bin (past from data, future from projection)
  const machinesPerBin = bins.map(idx => {
    if(existingMap.has(idx)) return existingMap.get(idx);
    if(idx > 0) return projectedMachines(idx);
    return 0;
  });

  const maxM = Math.max(...machinesPerBin, 1);
  const w = (xR - xL) / bins.length;

  // NOW position in "monthIndex space"
  const nowIdx = state.moveMonths; // 0..24 (slider)
  // Define how quickly cohorts "heat up" (months behind NOW to become fully red)
  const heatHorizon = 36;

  // Color helpers: interpolate from blue -> red
  const BLUE = { r: 96,  g: 165, b: 250 }; // #60A5FA
  const RED  = { r: 251, g: 113, b: 133 }; // #FB7185

  const lerp = (a,b,t) => a + (b-a)*t;
  function colorForAge(age){
    // age < 0: future relative to NOW => keep blue
    if(age < 0){
      return `rgba(${BLUE.r},${BLUE.g},${BLUE.b},0.55)`;
    }
    // age >= 0: past relative to NOW => blue -> red as age increases
    const t = clamp(age / heatHorizon, 0, 1);
    const r = Math.round(lerp(BLUE.r, RED.r, t));
    const g = Math.round(lerp(BLUE.g, RED.g, t));
    const b = Math.round(lerp(BLUE.b, RED.b, t));
    const a = lerp(0.55, 0.78, t); // slightly stronger as it reddens
    return `rgba(${r},${g},${b},${a})`;
  }

  // Draw bars
  bins.forEach((idx, i) => {
    const machines = machinesPerBin[i];
    const h = (machines / maxM) * maxH;
    const x = xL + i*w + 2;
    const y = yBase - h;

    // Age relative to NOW: cohorts become "past" once NOW passes them
    const age = nowIdx - idx; // months since this cohort's month, relative to NOW

    const fill = colorForAge(age);
    const stroke = "rgba(255,255,255,0.12)";

    const rect = document.createElementNS("http://www.w3.org/2000/svg","rect");
    rect.setAttribute("x", x);
    rect.setAttribute("y", y);
    rect.setAttribute("width", Math.max(2, w-4));
    rect.setAttribute("height", h);
    rect.setAttribute("rx", 6);
    rect.setAttribute("fill", fill);
    rect.setAttribute("stroke", stroke);
    rect.setAttribute("stroke-width","1");
    g.appendChild(rect);

    // Sparse labels to keep it readable
    if(idx % 6 === 0){
      const t = document.createElementNS("http://www.w3.org/2000/svg","text");
      t.setAttribute("x", x+2);
      t.setAttribute("y", 412);
      t.setAttribute("fill","rgba(156,163,175,0.9)");
      t.setAttribute("font-size","10");
      t.textContent = `M${idx}`;
      g.appendChild(t);
    }
  });

  // Move NOW line (requires the Page 3 SVG to include nowLine3 / nowLabel3 as in prior patch)
  const tNow = (nowIdx - minIdx) / (maxIdx - minIdx);
  const nowX = xL + clamp(tNow, 0, 1) * (xR - xL);

  const nowLine = svgEl("nowLine3");
  const nowLabel = svgEl("nowLabel3");
  if(nowLine && nowLabel){
    nowLine.setAttribute("x1", nowX);
    nowLine.setAttribute("x2", nowX);
    nowLabel.setAttribute("x", clamp(nowX+8, 90, 790));
  }
}



/* ---------------------------
   Slide 4: risk curve + dot
   --------------------------- */
const agePick = document.getElementById("agePick");
if(agePick) agePick.addEventListener("input", ()=>{
  const v = parseInt(agePick.value,10);
  document.getElementById("agePickLabel").textContent = v;
  renderRiskDot();
});
function renderRiskDot(){
  const alpha = state.alpha, beta = state.beta;
  const pts = riskCurvePoints(alpha,beta,60,61);

  const x0=90, x1=810, y0=420, y1=160;
  const path = pts.map((p,i)=>{
    const x = x0 + (p.age/60)*(x1-x0);
    const y = y0 - (p.r)*(y0-y1);
    return (i===0?`M${x},${y}`:`L${x},${y}`);
  }).join(" ");
  svgEl("riskPath").setAttribute("d", path);

  const age = parseInt(agePick.value,10);
  const p = pts.find(q=>q.age===age) || pts[0];
  const x = x0 + (age/60)*(x1-x0);
  const y = y0 - (p.r)*(y0-y1);

  const dot = svgEl("riskDot");
  dot.setAttribute("cx", x);
  dot.setAttribute("cy", y);

  // label
  const box = svgEl("dotLabelBox");
  const label = svgEl("dotLabel");
  const lx = clamp(x+10, 110, 650);
  const ly = clamp(y-58, 120, 390);
  box.setAttribute("x", lx);
  box.setAttribute("y", ly);
  label.setAttribute("x", lx+12);
  label.setAttribute("y", ly+20);
  label.innerHTML = "";
  label.textContent = `Age ${age} mo → risk ${fmt(p.raw*100,3)}%`;
  // second line
  const t2 = document.createElementNS("http://www.w3.org/2000/svg","tspan");
  t2.setAttribute("x", lx+12);
  t2.setAttribute("dy", 16);
  t2.setAttribute("fill","rgba(156,163,175,0.95)");
  t2.textContent = "(toy example)";
  label.appendChild(t2);
}

/* ---------------------------
   Slide 5: live curve with alpha/beta sliders
   --------------------------- */
const alphaEl = document.getElementById("alpha");
const betaEl = document.getElementById("beta");
if(alphaEl) alphaEl.addEventListener("input", ()=>{
  state.alpha = parseInt(alphaEl.value,10);
  document.getElementById("alphaLabel").textContent = state.alpha;
  renderRiskCurve5(false);
  // update slide4 too if user goes back
  renderRiskDot();
});
if(betaEl) betaEl.addEventListener("input", ()=>{
  state.beta = parseFloat(betaEl.value);
  document.getElementById("betaLabel").textContent = state.beta.toFixed(1);
  renderRiskCurve5(false);
  renderRiskDot();
});

let prevPath5 = "";
function renderRiskCurve5(first){
  const pts = riskCurvePoints(state.alpha,state.beta,60,61);
  const x0=90, x1=810, y0=420, y1=160;
  const newPath = pts.map((p,i)=>{
    const x = x0 + (p.age/60)*(x1-x0);
    const y = y0 - (p.r)*(y0-y1);
    return (i===0?`M${x},${y}`:`L${x},${y}`);
  }).join(" ");

  const dashed = svgEl("riskPath5b");
  const solid = svgEl("riskPath5");

  if(first){
    prevPath5 = newPath;
    dashed.setAttribute("d", newPath);
    solid.setAttribute("d", newPath);
    return;
  }

  dashed.setAttribute("d", prevPath5);
  solid.setAttribute("d", newPath);
  prevPath5 = newPath;
}

/* ---------------------------
   Slide 6: contributions + total bucket
   --------------------------- */
let showTop = false;
const __btnContrib = document.getElementById("btnContrib");
if(__btnContrib) __btnContrib.addEventListener("click", ()=>{
  showTop = !showTop;
  document.getElementById("btnContrib").textContent = showTop ? "Hide top contributors" : "Show top contributors";
  renderContrib();
});

function renderContrib(){
  const g = svgEl("contribBars");
  g.innerHTML = "";
  // Use a single target month (next month offset 0)
  const cohorts = buildCohortsForForecast(false,false,state.eolRel); // existing only
  const alpha=state.alpha, beta=state.beta;
  const cmEff=state.cmEff, cmStart=state.cmStartIdx;

  const contrib = cohorts.map(c=>{
    const age = -c.monthIndex; // at now
    const r = pFailInMonth(age,alpha,beta);
    const factor = (c.monthIndex > cmStart) ? cmEff : 1.0;
    const v = c.machines * r * factor;
    return {monthIndex:c.monthIndex, machines:c.machines, v};
  });

  // Sort contributions
  const sorted = [...contrib].sort((a,b)=>b.v-a.v);
  const topSet = new Set(sorted.slice(0,3).map(x=>x.monthIndex));

  const total = contrib.reduce((s,x)=>s+x.v,0) * state.scale;
  setText(document.getElementById("sumLabel"), `Expected this month: ${fmt(total,1)}`);

  // Bucket fill
  const fill = svgEl("bucketFill");
  const bucketText = svgEl("bucketText");
  bucketText.textContent = fmt(total,1);

  // scale fill height relative to a reference
  const ref = 120; // toy reference
  const h = clamp((total/ref)*240, 0, 240);
  fill.setAttribute("y", 418 - h);
  fill.setAttribute("height", h);

  // Draw bars (left panel)
  const x0=90, x1=560, yBase=420, maxH=240;
  const n = cohorts.length;
  const w = (x1-x0)/n;
  const maxV = Math.max(...contrib.map(d=>d.v)) || 1;

  contrib.forEach((d,i)=>{
    const h2 = (d.v/maxV)*maxH;
    const x = x0 + i*w + 2;
    const y = yBase - h2;

    const isTop = topSet.has(d.monthIndex);
    const fillc = isTop && showTop ? "rgba(251,191,36,0.75)" : "rgba(96,165,250,0.45)";
    const stroke = isTop && showTop ? "rgba(251,191,36,0.95)" : "rgba(255,255,255,0.12)";

    const rect = document.createElementNS("http://www.w3.org/2000/svg","rect");
    rect.setAttribute("x", x);
    rect.setAttribute("y", y);
    rect.setAttribute("width", Math.max(2, w-4));
    rect.setAttribute("height", h2);
    rect.setAttribute("rx", 6);
    rect.setAttribute("fill", fillc);
    rect.setAttribute("stroke", stroke);
    rect.setAttribute("stroke-width","1");
    g.appendChild(rect);
  });
}

/* ---------------------------
   Slide 7: calibration bars
   --------------------------- */
const __btnCalibrate = document.getElementById("btnCalibrate");
if(__btnCalibrate) __btnCalibrate.addEventListener("click", ()=>{
  // Toy: define "observed baseline" as recent average of spike data without spike exclusion
  // Here we emulate: scale so that expected next month aligns with baseline.
  // observed baseline (toy) = 11 (roughly)
  const observed = 11.0;
  const before = expectedComplaintsForOffset(0, {scale:1.0, includeFutureCohorts:false});
  const newScale = (before > 0) ? (observed / before) : 1.0;
  state.scale = clamp(newScale, 0.2, 5.0);
  document.getElementById("calibLabel").textContent = `Scale factor: ${state.scale.toFixed(2)}`;
  renderCalibrationBars(true);
  // update dependent visuals
  renderContrib();
  renderCM();
  renderEOL();
  renderOutputExample();
});

function renderCalibrationBars(animate){
  const observedH = 160;
  const before = expectedComplaintsForOffset(0, {scale:1.0, includeFutureCohorts:false});
  const after = before * state.scale;

  // Map values to bar heights
  const maxVal = Math.max(11, before, after, 0.001);
  const mapH = (v)=> clamp((v/maxVal)*160, 8, 160);

  const bObs = svgEl("barObserved");
  const bBefore = svgEl("barBefore");
  const bAfter = svgEl("barAfter");

  const hObs = mapH(11);
  const hB = mapH(before);
  const hA = mapH(after);

  // base y at 400, with max 160
  const yBase = 400;

  const setBar = (bar, h)=>{
    bar.setAttribute("y", yBase - h);
    bar.setAttribute("height", h);
  };

  if(animate){
    [bBefore,bAfter].forEach(el=>{ el.style.transition = "y 240ms ease, height 240ms ease"; });
  } else {
    [bBefore,bAfter].forEach(el=>{ el.style.transition = "none"; });
  }

  setBar(bObs, hObs);
  setBar(bBefore, hB);
  setBar(bAfter, hA);
}

/* ---------------------------
   Slide 8: countermeasure (drag line + forecast)
   --------------------------- */
const cmEffEl = document.getElementById("cmEff");
if(cmEffEl) cmEffEl.addEventListener("input", ()=>{
  state.cmEff = parseInt(cmEffEl.value,10)/100;
  document.getElementById("cmEffLabel").textContent = `${Math.round(state.cmEff*100)}%`;
  renderCM();
});

function renderCM(){
  const g = svgEl("cmCohorts");
  g.innerHTML = "";

  // Fixed x-axis domain so it is stable and interpretable
  const minIdx = -17, maxIdx = 12;
  const xL=90, xR=810, yBase=420, maxH=220;

  // Bins for stable layout
  const bins = [];
  for(let idx=minIdx; idx<=maxIdx; idx++) bins.push(idx);

  // Cohort machines: existing + a small future stub to the right (for context)
  const all = buildCohortsForForecast(true, false, state.eolRel);
  const map = new Map(all.map(c => [c.monthIndex, c.machines]));
  const maxM = Math.max(...bins.map(i => map.get(i) ?? 0), 1);
  const w = (xR-xL)/bins.length;

  bins.forEach((idx, i)=>{
    const machines = map.get(idx) ?? 0;
    const afterCM = idx > state.cmStartIdx;
    const effMachines = afterCM ? machines * state.cmEff : machines;

    const hBase = (machines/maxM)*maxH;
    const hEff  = (effMachines/maxM)*maxH;

    const x = xL + i*w + 2;

    // Base bar (original machines)
    const base = document.createElementNS("http://www.w3.org/2000/svg","rect");
    base.setAttribute("x", x);
    base.setAttribute("y", yBase - hBase);
    base.setAttribute("width", Math.max(2, w-4));
    base.setAttribute("height", hBase);
    base.setAttribute("rx", 6);
    base.setAttribute("fill", "rgba(229,231,235,0.08)");
    base.setAttribute("stroke", "rgba(255,255,255,0.10)");
    base.setAttribute("stroke-width","1");
    g.appendChild(base);

    // Effective bar (what actually contributes after CM)
    const eff = document.createElementNS("http://www.w3.org/2000/svg","rect");
    eff.setAttribute("x", x);
    eff.setAttribute("y", yBase - hEff);
    eff.setAttribute("width", Math.max(2, w-4));
    eff.setAttribute("height", hEff);
    eff.setAttribute("rx", 6);
    eff.setAttribute("fill", afterCM ? "rgba(52,211,153,0.60)" : "rgba(96,165,250,0.55)");
    eff.setAttribute("stroke", afterCM ? "rgba(52,211,153,0.85)" : "rgba(255,255,255,0.12)");
    eff.setAttribute("stroke-width","1");
    g.appendChild(eff);
  });

  // CM line position
  const t = (state.cmStartIdx - minIdx) / (maxIdx - minIdx);
  const lineX = xL + clamp(t,0,1)*(xR-xL);

  const cmLine = svgEl("cmLine");
  const cmHandle = svgEl("cmHandle");
  const cmLabel = svgEl("cmLineLabel");
  const cmShade = svgEl("cmShade");

  cmShade.setAttribute("x", lineX);
  cmShade.setAttribute("width", 840 - lineX);
  cmShade.setAttribute("y", 114);
  cmShade.setAttribute("height", 330);

  cmLine.setAttribute("x1", lineX);
  cmLine.setAttribute("x2", lineX);
  cmHandle.setAttribute("cx", lineX);
  cmHandle.setAttribute("cy", 124);
  cmLabel.setAttribute("x", clamp(lineX+8, 90, 780));

  // Forecast next 12 months (uses CM effect)
  const pts = [];
  for(let k=0;k<12;k++){
    const v = expectedComplaintsForOffset(k, {
      includeFutureCohorts:true,
      cmStartIdx: state.cmStartIdx,
      cmEff: state.cmEff,
      scale: state.scale
    });
    pts.push(v);
  }
  const maxV = Math.max(...pts, 0.001);
  const x0=110, x1=820, y0=410, y1=190;
  const d = pts.map((v,i)=>{
    const x = x0 + (i/11)*(x1-x0);
    const y = y0 - (v/maxV)*(y0-y1);
    return (i===0?`M${x},${y}`:`L${x},${y}`);
  }).join(" ");
  svgEl("cmForecast").setAttribute("d", d);

  const sum12 = pts.reduce((a,b)=>a+b,0);
  svgEl("cmForecastLabel").textContent = `Expected next 12 months: ${fmt(sum12,1)} (toy)`;
}

// Drag logic for CM line
(function setupCMDrag(){
  const svg = svgEl("viz8");
  const cmLine = svgEl("cmLine");
  const handle = svgEl("cmHandle");
  if(!svg || !cmLine || !handle) return;

  function clientToSvgX(evt){
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    const ctm = svg.getScreenCTM().inverse();
    const sp = pt.matrixTransform(ctm);
    return sp.x;
  }
  function setFromX(x){
    const minIdx=-17, maxIdx=12;
    const xL=90, xR=810;
    const t = clamp((x - xL)/(xR-xL), 0, 1);
    const idx = Math.round(minIdx + t*(maxIdx-minIdx));
    state.cmStartIdx = idx;
    renderCM();
  }

  function down(evt){
    state.cmDragging = true;
    setFromX(clientToSvgX(evt));
  }
  function move(evt){
    if(!state.cmDragging) return;
    setFromX(clientToSvgX(evt));
  }
  function up(){
    state.cmDragging = false;
  }

  cmLine.addEventListener("pointerdown", down);
  handle.addEventListener("pointerdown", down);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
})();

/* ---------------------------
   Slide 9: EOL logic
   --------------------------- */
const __btnEolToggle = document.getElementById("btnEolToggle");
if(__btnEolToggle) __btnEolToggle.addEventListener("click", ()=>{
  state.eolOn = !state.eolOn;
  document.getElementById("btnEolToggle").textContent = `EOL: ${state.eolOn ? "ON" : "OFF"}`;
  renderEOL();
  renderOutputExample();
});
const eolEl = document.getElementById("eol");
if(eolEl) eolEl.addEventListener("input", ()=>{
  state.eolRel = parseInt(eolEl.value,10);
  document.getElementById("eolLabel").textContent = `+${state.eolRel} months`;
  renderEOL();
  renderOutputExample();
});

function renderEOL(){
  const g = svgEl("eolCohorts");
  g.innerHTML = "";

  const minIdx=-17, maxIdx=30;
  const xL=90, xR=810, yBase=420, maxH=220;

  // Fixed bins for stable x-axis
  const bins = [];
  for(let idx=minIdx; idx<=maxIdx; idx++) bins.push(idx);

  // Base: existing production + future average production
  const baseCohorts = buildCohortsForForecast(true, false, state.eolRel);
  const baseMap = new Map(baseCohorts.map(c => [c.monthIndex, c.machines]));

  // Apply EOL by zeroing machines after eolRel (do not remove bins)
  const machinesAt = (idx) => {
    const m = baseMap.get(idx) ?? 0;
    if(state.eolOn && idx > state.eolRel) return 0;
    return m;
  };

  const maxM = Math.max(...bins.map(i => machinesAt(i)), 1);
  const w = (xR-xL)/bins.length;

  bins.forEach((idx,i)=>{
    const machines = machinesAt(idx);
    const h = (machines/maxM)*maxH;
    const x = xL + i*w + 2;
    const y = yBase - h;

    const isFuture = idx > 0;
    const beyondEol = state.eolOn && idx > state.eolRel;

    const fill = beyondEol
      ? "rgba(255,255,255,0.03)"
      : (isFuture ? "rgba(52,211,153,0.30)" : "rgba(96,165,250,0.38)");

    const rect = document.createElementNS("http://www.w3.org/2000/svg","rect");
    rect.setAttribute("x", x);
    rect.setAttribute("y", y);
    rect.setAttribute("width", Math.max(2, w-4));
    rect.setAttribute("height", h);
    rect.setAttribute("rx", 6);
    rect.setAttribute("fill", fill);
    rect.setAttribute("stroke", "rgba(255,255,255,0.12)");
    rect.setAttribute("stroke-width","1");
    g.appendChild(rect);
  });

  // EOL line marker (stable positioning)
  const eolLine = svgEl("eolLine");
  const eolLbl = svgEl("eolLineLabel");
  if(state.eolOn){
    eolLine.setAttribute("opacity","1");
    eolLbl.setAttribute("opacity","1");

    const t = (state.eolRel - minIdx) / (maxIdx - minIdx);
    const lineX = xL + clamp(t,0,1)*(xR-xL);
    eolLine.setAttribute("x1", lineX);
    eolLine.setAttribute("x2", lineX);
    eolLbl.setAttribute("x", clamp(lineX+8, 90, 780));
  }else{
    eolLine.setAttribute("opacity","0");
    eolLbl.setAttribute("opacity","0");
  }

  // Forecast line (still uses actual EOL logic)
  const pts = [];
  for(let k=0;k<12;k++){
    const v = expectedComplaintsForOffset(k, {
      includeFutureCohorts:true,
      eolOn: state.eolOn,
      eolRel: state.eolRel,
      cmStartIdx: state.cmStartIdx,
      cmEff: state.cmEff,
      scale: state.scale
    });
    pts.push(v);
  }

  const maxV = Math.max(...pts, 0.001);
  const x0=110, x1=820, y0=410, y1=190;
  const d = pts.map((v,i)=>{
    const x = x0 + (i/11)*(x1-x0);
    const y = y0 - (v/maxV)*(y0-y1);
    return (i===0?`M${x},${y}`:`L${x},${y}`);
  }).join(" ");
  svgEl("eolForecast").setAttribute("d", d);

  const sum12 = pts.reduce((a,b)=>a+b,0);
  svgEl("eolForecastLabel").textContent = `Expected next 12 months: ${fmt(sum12,1)} (toy)`;
}


/* ---------------------------
   Slide 10: spike mini-game
   --------------------------- */
const __btnResetSpike = document.getElementById("btnResetSpike");
if(__btnResetSpike) __btnResetSpike.addEventListener("click", ()=>{
  state.spikeExcluded = new Set();
  renderSpike();
});

function renderSpike(){
  const g = svgEl("spikePoints");
  g.innerHTML = "";

  const vals = state.spikeData.slice();
  const maxV = Math.max(...vals, 1);
  const x0=110, x1=820, y0=420, y1=180;

  // draw points (clickable)
  vals.forEach((v,i)=>{
    const x = x0 + (i/(vals.length-1))*(x1-x0);
    const y = y0 - (v/maxV)*(y0-y1);
    const excluded = state.spikeExcluded.has(i);

    const c = document.createElementNS("http://www.w3.org/2000/svg","circle");
    c.setAttribute("cx", x);
    c.setAttribute("cy", y);
    c.setAttribute("r", excluded ? 10 : 8);
    c.setAttribute("fill", excluded ? "rgba(251,113,133,0.35)" : "rgba(96,165,250,0.75)");
    c.setAttribute("stroke", excluded ? "rgba(251,113,133,0.95)" : "rgba(255,255,255,0.18)");
    c.setAttribute("stroke-width","2");
    c.style.cursor = "pointer";
    c.addEventListener("click", ()=>{
      if(state.spikeExcluded.has(i)) state.spikeExcluded.delete(i);
      else state.spikeExcluded.add(i);
      renderSpike();
    });
    g.appendChild(c);

    const t = document.createElementNS("http://www.w3.org/2000/svg","text");
    t.setAttribute("x", x);
    t.setAttribute("y", 448);
    t.setAttribute("fill","rgba(156,163,175,0.90)");
    t.setAttribute("font-size","10");
    t.setAttribute("text-anchor","middle");
    t.textContent = `${i-11}`;
    g.appendChild(t);
  });

	// compute filtered recent average on last 12 months (toy), excluding selected spikes
	const recentN = 12;
	const start = Math.max(0, vals.length - recentN);
	const recentIdx = [...Array(vals.length - start)].map((_,k)=>start+k);

	const included = recentIdx
	  .filter(i=>!state.spikeExcluded.has(i))
	  .map(i=>vals[i]);

	const avg = included.length ? (included.reduce((a,b)=>a+b,0)/included.length) : 0;

	document.getElementById("spikeLabel").textContent = `Filtered recent average (last ${recentN}): ${fmt(avg,2)}`;


  // draw avg line
  const yAvg = y0 - (avg/maxV)*(y0-y1);
  const line = svgEl("spikeAvgLine");
  const txt = svgEl("spikeAvgText");
  line.setAttribute("y1", yAvg);
  line.setAttribute("y2", yAvg);
  txt.setAttribute("y", yAvg-8);
  line.setAttribute("opacity","1");
  txt.setAttribute("opacity","1");
}

/* ---------------------------
   Slide 11: output example
   --------------------------- */
function renderOutputExample(){
  // choose a representative month offset
  const offset = 14; // toy: 14 months ahead
  const comps = expectedComplaintsForOffset(offset, {
    includeFutureCohorts:true,
    eolOn: state.eolOn, eolRel: state.eolRel,
    cmStartIdx: state.cmStartIdx, cmEff: state.cmEff,
    scale: state.scale
  });
  const machines = machinesInFieldAtOffset(offset, { eolOn: state.eolOn, eolRel: state.eolRel });
  const rate = (machines > 0) ? (comps / machines) : 0;

  setText(svgEl("outCompl"), fmt(comps,1));
  setText(svgEl("outMachines"), fmtInt(machines));
  setText(svgEl("outRate"), `${fmt(rate*100,3)}% per month`);

  // series
  const pts = [];
  for(let k=0;k<18;k++){
    pts.push(expectedComplaintsForOffset(k, {
      includeFutureCohorts:true,
      eolOn: state.eolOn, eolRel: state.eolRel,
      cmStartIdx: state.cmStartIdx, cmEff: state.cmEff,
      scale: state.scale
    }));
  }
  const maxV = Math.max(...pts, 0.001);
  const x0=460, x1=820, y0=380, y1=150;
  const d = pts.map((v,i)=>{
    const x = x0 + (i/(pts.length-1))*(x1-x0);
    const y = y0 - (v/maxV)*(y0-y1);
    return (i===0?`M${x},${y}`:`L${x},${y}`);
  }).join(" ");
  svgEl("outSeries").setAttribute("d", d);
}


/* ---------------------------
   Split-pages navigation + shared state
   --------------------------- */

/* State persistence (localStorage) */
const __PERSIST_KEY = "complaint_presentation_state_v1";

function __snapshotState(){
  return {
    moveMonths: state.moveMonths,
    alpha: state.alpha,
    beta: state.beta,
    scale: state.scale,
    cmEff: state.cmEff,
    cmStartIdx: state.cmStartIdx,
    eolOn: state.eolOn,
    eolRel: state.eolRel,
    spikeExcluded: Array.from(state.spikeExcluded || []),
    showTop: (typeof showTop !== "undefined") ? !!showTop : false
  };
}
let __saveTimer = null;
function saveState(){
  try{ localStorage.setItem(__PERSIST_KEY, JSON.stringify(__snapshotState())); }catch(_e){}
}
function saveStateDebounced(){
  if(__saveTimer) clearTimeout(__saveTimer);
  __saveTimer = setTimeout(saveState, 120);
}
function loadState(){
  try{
    const raw = localStorage.getItem(__PERSIST_KEY);
    if(!raw) return false;
    const snap = JSON.parse(raw);

    if(typeof snap.moveMonths === "number") state.moveMonths = snap.moveMonths;
    if(typeof snap.alpha === "number") state.alpha = snap.alpha;
    if(typeof snap.beta === "number") state.beta = snap.beta;
    if(typeof snap.scale === "number") state.scale = snap.scale;

    if(typeof snap.cmEff === "number") state.cmEff = snap.cmEff;
    if(typeof snap.cmStartIdx === "number") state.cmStartIdx = snap.cmStartIdx;

    if(typeof snap.eolOn === "boolean") state.eolOn = snap.eolOn;
    if(typeof snap.eolRel === "number") state.eolRel = snap.eolRel;

    if(Array.isArray(snap.spikeExcluded)) state.spikeExcluded = new Set(snap.spikeExcluded);

    if(typeof snap.showTop === "boolean" && (typeof showTop !== "undefined")) showTop = snap.showTop;

    return true;
  }catch(_e){ return false; }
}

function applyStateToControls(){
  const cohortMove = document.getElementById("cohortMove");
  if(cohortMove){
    cohortMove.value = String(state.moveMonths);
    const lbl = document.getElementById("cohortMoveLabel");
    if(lbl) lbl.textContent = state.moveMonths;
  }
  const alphaEl = document.getElementById("alpha");
  if(alphaEl){
    alphaEl.value = String(state.alpha);
    const lbl = document.getElementById("alphaLabel");
    if(lbl) lbl.textContent = state.alpha;
  }
  const betaEl = document.getElementById("beta");
  if(betaEl){
    betaEl.value = String(state.beta);
    const lbl = document.getElementById("betaLabel");
    if(lbl) lbl.textContent = Number(state.beta).toFixed(1);
  }
  const cmEffEl = document.getElementById("cmEff");
  if(cmEffEl){
    cmEffEl.value = String(Math.round(state.cmEff*100));
    const lbl = document.getElementById("cmEffLabel");
    if(lbl) lbl.textContent = `${Math.round(state.cmEff*100)}%`;
  }
  const btnEolToggle = document.getElementById("btnEolToggle");
  if(btnEolToggle){
    btnEolToggle.textContent = `EOL: ${state.eolOn ? "ON" : "OFF"}`;
  }
  const eolEl = document.getElementById("eol");
  if(eolEl){
    eolEl.value = String(state.eolRel);
    const lbl = document.getElementById("eolLabel");
    if(lbl) lbl.textContent = `+${state.eolRel} months`;
  }
  const calibLabel = document.getElementById("calibLabel");
  if(calibLabel){
    calibLabel.textContent = `Scale factor: ${Number(state.scale).toFixed(2)}`;
  }
  const btnContrib = document.getElementById("btnContrib");
  if(btnContrib && (typeof showTop !== "undefined")){
    btnContrib.textContent = (showTop ? "Hide top contributors" : "Show top contributors");
  }
}

function __attachAutoSave(){
  ["cohortMove","alpha","beta","cmEff","eol"].forEach(id=>{
    const el = document.getElementById(id);
    if(el){
      el.addEventListener("input", saveStateDebounced);
      el.addEventListener("change", saveStateDebounced);
    }
  });
  ["btnCalibrate","btnContrib","btnEolToggle","btnResetSpike"].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener("click", saveStateDebounced);
  });
  const svg10 = document.getElementById("viz10");
  if(svg10) svg10.addEventListener("click", saveStateDebounced);
}

/* Navigation */
function slideUrl(n){
  const nn = String(n).padStart(2,"0");
  return `./page${nn}.html`;
}
function showSlide(n){
  const p = clamp(n, 1, state.totalSlides);
  window.location.href = slideUrl(p);
}
function setProgressForPage(n){
  const p = clamp(n, 1, state.totalSlides);
  const nTot = state.totalSlides;

  const ptext = document.getElementById("ptext");
  const pbar = document.getElementById("pbar");
  if(ptext) ptext.textContent = `${p} / ${nTot}`;
  if(pbar) pbar.style.width = `${(p-1)/(nTot-1)*100}%`;

  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");

  if(prevBtn){
    prevBtn.disabled = (p === 1);
    prevBtn.onclick = () => { if(p>1) showSlide(p-1); };
  }
  if(nextBtn){
    nextBtn.textContent = (p === nTot) ? "Done" : "Next";
    nextBtn.onclick = () => { if(p<nTot) showSlide(p+1); };
  }
}
function setupKeyboardNav(n){
  window.addEventListener("keydown", (e)=>{
    if(e.key === "ArrowLeft" && n>1) showSlide(n-1);
    if(e.key === "ArrowRight" && n<state.totalSlides) showSlide(n+1);
    if(/^[1-9]$/.test(e.key)){
      const k = parseInt(e.key,10);
      if(k <= state.totalSlides) showSlide(k);
    }
  });
}

function bootPresentationPage(pageNumber){
  loadState();
  state.slide = pageNumber;

  setProgressForPage(pageNumber);
  setupKeyboardNav(pageNumber);

  applyStateToControls();
  __attachAutoSave();

  onEnterSlide(pageNumber);
  saveStateDebounced();
}
