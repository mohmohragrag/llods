// ===== Section properties for H/I in mm =====
function ISectionProps_mm(h, tw, bf, tf){
  const A  = h*tw + 2*bf*tf; // mm^2
  const Ix_web    = (tw*Math.pow(h,3))/12;
  const d         = h/2 + tf/2;
  const Ix_flange = (bf*Math.pow(tf,3))/12 + bf*tf*Math.pow(d,2);
  const Ix        = Ix_web + 2*Ix_flange; // mm^4
  const Iy_web    = (Math.pow(tw,3)*h)/12;
  const Iy_flange = (Math.pow(bf,3)*tf)/12;
  const Iy        = Iy_web + 2*Iy_flange;
  const y_max = h/2 + tf;
  const Zx = Ix / y_max; // mm^3
  return {A, Ix, Iy, Zx};
}

// Load combinations: coefficients for DL, LL, WL
const COMBOS = [
  {name:'1.4DL', DL:1.4, LL:0.0, WL:0.0},
  {name:'1.2DL+1.6LL', DL:1.2, LL:1.6, WL:0.0},
  {name:'1.2DL+1.6LL+0.5WL', DL:1.2, LL:1.6, WL:0.5},
  {name:'1.0DL+1.0LL+1.0WL', DL:1.0, LL:1.0, WL:1.0}
];

document.getElementById('calcBtn').addEventListener('click', run);
window.addEventListener('load', run);

function run(){
  // read inputs
  const H_mm = +g('colHeight',15000);
  const B_mm = +g('frameWidth',50000);
  const dead_kgpm = +g('deadLoad',10);
  const live_kgpm = +g('liveLoad',4);
  const wind_kg = +g('windPerCol',9600);
  const fy = +g('fy',325); // MPa
  const E = +g('E',210)*1e9; // Pa
  const K = +g('Kfactor',1.0);

  // member props (mm)
  const Col1 = ISectionProps_mm(+g('c1_h',200), +g('c1_tw',8), +g('c1_bf',150), +g('c1_tf',12));
  const Col2 = ISectionProps_mm(+g('c2_h',200), +g('c2_tw',8), +g('c2_bf',150), +g('c2_tf',12));
  const Beam1= ISectionProps_mm(+g('b1_h',200), +g('b1_tw',8), +g('b1_bf',150), +g('b1_tf',12));
  const Beam2= ISectionProps_mm(+g('b2_h',200), +g('b2_tw',8), +g('b2_bf',150), +g('b2_tf',12));

  const b1_conn = document.getElementById('b1_conn').value; // hinge | moment
  const b2_conn = document.getElementById('b2_conn').value;

  // geometry
  const H_m = H_mm/1000;
  const B_m = B_mm/1000;
  const Lbeam_m = Math.hypot(B_m/2, H_m); // each rafter length

  // convert loads to N/m (dead/live are kg/m → N/m). Wind is per column (kg) -> N
  const dead_Npm = dead_kgpm * 9.81;
  const live_Npm = live_kgpm * 9.81;
  const wind_N = wind_kg * 9.81;

  // function to get beam reaction quantities for a connection type
  function beamReactions(conn, q_total){
    // q_total in N/m
    let Mend = 0, Mmax = 0, V_react = q_total * Lbeam_m / 2; // shear at support approx
    if(conn === 'moment'){
      Mend = q_total * Math.pow(Lbeam_m,2) / 12;        // N·m (moment transmitted to column)
      Mmax = 0.10 * q_total * Math.pow(Lbeam_m,2);     // approximate fixed-pin max moment (N·m)
    } else { // hinge (pin-pin)
      Mend = 0;
      Mmax = q_total * Math.pow(Lbeam_m,2) / 8;        // N·m
    }
    return {Mend, Mmax, V_react};
  }

  // for each combo compute utilizations and pick worst
  function analyzeForCombo(combo){
    const q_total = combo.DL*dead_Npm + combo.LL*live_Npm; // N/m applied to each rafter
    const WL_factor = combo.WL;

    // beam forces
    const b1 = beamReactions(b1_conn, q_total);
    const b2 = beamReactions(b2_conn, q_total);

    // reactions at column (approx): vertical shear + wind axial
    // treat V_react as vertical reaction converted to axial on column (simplified)
    const N1 = b1.V_react + WL_factor*wind_N; // N
    const N2 = b2.V_react + WL_factor*wind_N; // N

    // moments at column head from rafter
    const M1 = b1.Mend; // N·m
    const M2 = b2.Mend;

    // beam checks (bending)
    const beam1_sigma = (b1.Mmax*1000) / Beam1.Zx; // MPa (N·mm / mm^3 = N/mm^2)
    const beam2_sigma = (b2.Mmax*1000) / Beam2.Zx;
    const beam1_util = beam1_sigma / fy;
    const beam2_util = beam2_sigma / fy;

    // column checks (P-M interaction + buckling)
    function colCheck(Col, N, M){
      // P-M interaction simplified: U = N/(fy*A_N) + |M|/(fy*Z_N)
      // convert: Col.A mm2 -> A_N = Col.A mm2 * (1 N/mm^2) gives N at fy? We'll compute consistently:
      // Nc = fy(MPa) * A (mm^2) -> N (since MPa = N/mm^2)
      const Nc = fy * Col.A; // N
      const Mc = fy * Col.Zx; // N·mm
      const U_int = (N / Nc) + (Math.abs(M*1000) / Mc); // dimensionless
      // Euler buckling (use worst axis)
      const Icrit_m4 = Math.min(Col.Ix, Col.Iy) * 1e-12; // mm4 -> m4
      const Le = K * H_m; // m
      const Pcr = (Math.PI**2 * E * Icrit_m4) / (Le*Le); // N
      const buckling_ratio = N / Pcr;
      const safe = (U_int <= 1.0) && (buckling_ratio <= 1.0);
      // also compute axial stress approx for info
      const sigma_axial = (N / (Col.A * 1e-6)) / 1e6; // MPa
      return {U_int, Pcr, buckling_ratio, safe, sigma_axial, N, M};
    }

    const col1 = colCheck(Col1, N1, M1);
    const col2 = colCheck(Col2, N2, M2);

    return {
      comboName: combo.name,
      q_total, WL_factor: combo.WL,
      beam1: {sigma: beam1_sigma, util: beam1_util},
      beam2: {sigma: beam2_sigma, util: beam2_util},
      col1, col2
    };
  }

  // run for all combos and pick worst (max util) for each member
  const allResults = COMBOS.map(analyzeForCombo);

  // pick worst for each element
  function pickWorstForBeam(key){
    let worst = null;
    allResults.forEach(r=>{
      const util = r[key].util;
      if(!worst || util > worst.util) worst = {combo:r.comboName, util, sigma:r[key].sigma};
    });
    return worst;
  }
  function pickWorstForCol(key){
    let worst = null;
    allResults.forEach(r=>{
      const obj = r[key];
      const util = obj.U_int; // interaction
      if(!worst || util > worst.util) worst = {combo:r.comboName, util, sigma_axial:obj.sigma_axial, buckling_ratio:obj.buckling_ratio, Pcr:obj.Pcr, N:obj.N, M:(key==='col1'? (r.col1? r.col1.M : null) : (r.col2? r.col2.M : null))};
    });
    return worst;
  }

  const worstBeam1 = pickWorstForBeam('beam1');
  const worstBeam2 = pickWorstForBeam('beam2');
  const worstCol1  = pickWorstForCol('col1');
  const worstCol2  = pickWorstForCol('col2');

  // Prepare results display
  const el = document.getElementById('results');
  el.innerHTML = `
    <h2>نتائج (تم فحص كل Combinations)</h2>
    <div class="list">
      <div class="item ${worstCol1.util<=1 && worstCol1.buckling_ratio<=1 ? 'safe':'unsafe'}">
        <h3>العمود الأيسر</h3>
        <div>أسوأ Combination: <b>${worstCol1.combo}</b></div>
        <div>تفاعل P–M U = <b>${worstCol1.util.toFixed(3)}</b> (≤1)</div>
        <div>انبعاج N/Pcr = <b>${worstCol1.buckling_ratio.toFixed(3)}</b> (≤1)</div>
        <div>σ محوري ≈ <b>${worstCol1.sigma_axial.toFixed(3)} MPa</b></div>
        <div>الحالة: <span class="${(worstCol1.util<=1 && worstCol1.buckling_ratio<=1)?'status-ok':'status-bad'}">${(worstCol1.util<=1 && worstCol1.buckling_ratio<=1)?'آمن ✅':'غير آمن ❌'}</span></div>
      </div>

      <div class="item ${worstCol2.util<=1 && worstCol2.buckling_ratio<=1 ? 'safe':'unsafe'}">
        <h3>العمود الأيمن</h3>
        <div>أسوأ Combination: <b>${worstCol2.combo}</b></div>
        <div>تفاعل P–M U = <b>${worstCol2.util.toFixed(3)}</b> (≤1)</div>
        <div>انبعاج N/Pcr = <b>${worstCol2.buckling_ratio.toFixed(3)}</b> (≤1)</div>
        <div>σ محوري ≈ <b>${worstCol2.sigma_axial.toFixed(3)} MPa</b></div>
        <div>الحالة: <span class="${(worstCol2.util<=1 && worstCol2.buckling_ratio<=1)?'status-ok':'status-bad'}">${(worstCol2.util<=1 && worstCol2.buckling_ratio<=1)?'آمن ✅':'غير آمن ❌'}</span></div>
      </div>

      <div class="item ${worstBeam1.util<=1 ? 'safe':'unsafe'}">
        <h3>الرافتر الأيسر</h3>
        <div>أسوأ Combination: <b>${worstBeam1.combo}</b></div>
        <div>σ انحناء = <b>${worstBeam1.sigma.toFixed(3)} MPa</b></div>
        <div>نسبة استغلال = <b>${worstBeam1.util.toFixed(3)}</b></div>
        <div>الحالة: <span class="${worstBeam1.util<=1?'status-ok':'status-bad'}">${worstBeam1.util<=1?'آمن ✅':'غير آمن ❌'}</span></div>
      </div>

      <div class="item ${worstBeam2.util<=1 ? 'safe':'unsafe'}">
        <h3>الرافتر الأيمن</h3>
        <div>أسوأ Combination: <b>${worstBeam2.combo}</b></div>
        <div>σ انحناء = <b>${worstBeam2.sigma.toFixed(3)} MPa</b></div>
        <div>نسبة استغلال = <b>${worstBeam2.util.toFixed(3)}</b></div>
        <div>الحالة: <span class="${worstBeam2.util<=1?'status-ok':'status-bad'}">${worstBeam2.util<=1?'آمن ✅':'غير آمن ❌'}</span></div>
      </div>
    </div>

    <hr>
    <h3>الخلاصة العامة</h3>
    <div>${( (worstCol1.util<=1 && worstCol1.buckling_ratio<=1) && (worstCol2.util<=1 && worstCol2.buckling_ratio<=1) && (worstBeam1.util<=1) && (worstBeam2.util<=1) ) ? '<span class="status-ok">الإطار آمن على جميع الحالات ✅</span>' : '<span class="status-bad">يوجد عناصر غير آمنة ❌</span>'}</div>
  `;

  // draw frame with colors based on worst states
  drawFrame({
    H_mm, B_mm,
    col1Safe: (worstCol1.util<=1 && worstCol1.buckling_ratio<=1),
    col2Safe: (worstCol2.util<=1 && worstCol2.buckling_ratio<=1),
    beam1Safe: (worstBeam1.util<=1),
    beam2Safe: (worstBeam2.util<=1)
  });
}

// helper to get value
function g(id, def){ const e=document.getElementById(id); return e? e.value : def; }

// draw simple SVG
function drawFrame({H_mm, B_mm, col1Safe, col2Safe, beam1Safe, beam2Safe}){
  const svg = document.getElementById('frameSVG'); svg.innerHTML='';
  const margin = 80, viewW = 1000 - margin*2, viewH = 480;
  const scale = Math.min(viewW/B_mm, viewH/H_mm);
  const baseY = 520, x0 = margin;
  const Bpx = B_mm*scale, Hpx = H_mm*scale;
  const topY = baseY - Hpx;
  const apexX = x0 + Bpx/2, apexY = topY - Math.min(Bpx*0.25, Hpx*0.6);
  const colW = 18, beamStroke = 14;

  function rect(x,y,w,h,color,name){ const r = document.createElementNS('http://www.w3.org/2000/svg','rect'); r.setAttribute('x',x); r.setAttribute('y',y); r.setAttribute('width',w); r.setAttribute('height',h); r.setAttribute('rx',3); r.setAttribute('fill',color); r.setAttribute('stroke','#333'); r.setAttribute('data-name',name); svg.appendChild(r); }
  function line(x1,y1,x2,y2,sw,color,name){ const l = document.createElementNS('http://www.w3.org/2000/svg','line'); l.setAttribute('x1',x1); l.setAttribute('y1',y1); l.setAttribute('x2',x2); l.setAttribute('y2',y2); l.setAttribute('stroke',color); l.setAttribute('stroke-width',sw); l.setAttribute('stroke-linecap','round'); l.setAttribute('data-name',name); svg.appendChild(l); }

  rect(x0, topY, colW, Hpx, col1Safe? '#2ca02c':'#d9534f', 'العمود الأيسر');
  rect(x0+Bpx-colW, topY, colW, Hpx, col2Safe? '#2ca02c':'#d9534f', 'العمود الأيمن');
  line(x0+colW/2, topY, apexX, apexY, beamStroke, beam1Safe? '#2ca02c':'#d9534f', 'الرافتر الأيسر');
  line(x0+Bpx-colW/2, topY, apexX, apexY, beamStroke, beam2Safe? '#2ca02c':'#d9534f', 'الرافتر الأيمن');
  line(0, baseY+6, 1000, baseY+6, 2, '#333', 'الأرضية');
}
