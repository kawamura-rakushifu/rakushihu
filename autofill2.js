// らくシフト 自動作成 v2（業務能力・必須配置条件・既存の必要人数設定に対応）
// ・計算専用：画面(DOM)・DB・既存のシフトデータには一切触れない。入力から「シフト案」を計算して返すだけ。
// 時刻はすべて「0:00からの分」。判定は15分単位。
//
// 必要な「枠」は3種類。1人が同じ時間に複数の枠を持てるのは、次の組み合わせだけ（人数の二重計上を防ぐ）。
//   業務の枠（skill）   … レジ・キッチン等。兼任できる業務同士なら1人で複数持てる
//   ポジションの枠（pos）… 既存の必要人数設定（社員・キッチン・ホール）。1人1つ。
//                          ポジション名と同じ名前の業務、またはそれと兼任できる業務とは同じ人が持てる
//                          （例：キッチンの必須条件とキッチンの人数は「多い方」の人数で満たせる）
//   時間帯責任者の枠（main）… 既存の「メイン担当」設定（名称を時間帯責任者に変更）。他の枠と同時に持てる。
//   店舗全体の人数（total）… 必須配置条件の「店舗全体の人数」。枠ではなく、その時間に勤務中（休憩中を除く）の人数で判定する
//                          （1人は1人として数える。ホール・キッチン・レジなどの担当と重ねて数えるが、同じ人を2人分にはしない）
//   業務の条件の「ポジションの人数に含める」（inPos）… 例：揚げ場（単独）をキッチンの人数に含める＝揚げ場の担当者はキッチンの枠も同時に持てる
//                          原則は社員が担当し、社員がいない時間は責任者に認定されたパート・アルバイト（canMain）が担当する
(function (root) {
  'use strict';
  const SLOT = 15;
  const DAILY_W = 8; // 「1日の基本人数」の不足1人を、時間帯の不足何枠分とみなすか（作成時の優先度）
  // スタッフの優先度（高・中・低）：希望者が必要人数より多いときの選び方に使う。
  // 「埋まる不足（必要な業務・ポジション）」の 1 枠（15分）＝1000 より小さく、「目標時間の超過」2時間分（8枠×50）と同じ大きさ。
  // そのため ①必要な業務を満たせる人が常に先 ②同じだけ埋まるなら優先度の高い人 ③ただし目標時間を2時間超えて入れてまでは優先しない。
  // 休み希望・勤務不可・契約上限・連続勤務などの制約は、候補を作る前に除外するため、優先度で破られることはない。
  const PRIORITY_W = { high: 400, mid: 0, low: -400 };
  const priorityOf = s => (s.priority === 'high' || s.priority === 'low') ? s.priority : 'mid';
  // 同点のときの順番：これまでの勤務日数が少ない人 → 日付ごとに入れ替わる順（いつも同じ人が先にならない）
  const tieHash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  // 同点の順番に使う番号：DB の ID（tieId）。画面の中の番号（読み込みの順）で順番が変わると、画面とサーバーで案が食い違うため
  const tieIdOf = (ctx, id) => { const s = ctx.staffById.get(id); return s && s.tieId != null ? s.tieId : id; };
  const DEFAULTS = {
    minShift: 180,             // 自動で作るシフトの最短（分）
    maxShift: 480,             // 自動で作るシフトの最長（分、休憩を含む拘束時間）
    dayStart: 7 * 60,          // 作成できる時間の範囲（既存のシフト表と同じ 7:00〜24:00）
    dayEnd: 24 * 60,
    breakRules: [{ overWork: 360, min: 45 }, { overWork: 480, min: 60 }], // 実働6時間超→45分以上、8時間超→60分以上
    maxConsecutiveDays: 6,     // 連続勤務の上限（日）。0なら判定しない
    unrequestedAvailable: false, // 希望（勤務可能時間）を出していない日は使わない
    fillAllRequests: false,      // true なら不足に関係なく希望どおり全員を入れる
    empBreakDefault: 120,        // 社員の基本の休憩（分）。社員ごと（breakMin）・日ごと（dayBreaks）に変えられる
    empBreakWindow: { start: 14 * 60, end: 17 * 60 },   // 社員の休憩を置く時間帯（平日・土日祝とも同じ）。この中に連続で（分けずに）取る
  };
  // 社員の出退勤の自動決定（勤務時間の扱い＝「範囲内で自動決定」の日）：30分単位。1日の実働は原則8時間以内、週40時間（通常の労働時間制度）
  const EMP_STEP = 30, LEGAL_DAY = 480, LEGAL_WEEK = 2400;
  const ceilStep = m => Math.ceil(m / EMP_STEP) * EMP_STEP, floorStep = m => Math.floor(m / EMP_STEP) * EMP_STEP;
  const sunKey = date => addDays(date, -dowOf(date));   // 法定の週（日曜始まり。集計 employeeResults と同じ）

  const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);   // [a,b].sort().join('|') と同じ結果（配列を作らない）
  const dowOf = date => new Date(date + 'T00:00:00').getDay();
  const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const addDays = (date, n) => { const d = new Date(date + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
  const weekKey = date => { const d = new Date(date + 'T00:00:00'); const w = d.getDay(); d.setDate(d.getDate() - (w === 0 ? 6 : w - 1)); return ymd(d); }; // 月曜始まり
  const breaksOf = sh => (sh.breaks || []).reduce((n, b) => n + b.end - b.start, 0);

  function prepare(input) {
    const opt = Object.assign({}, DEFAULTS, input.options || {});
    const compatMap = input.compat || {};
    const compat = (a, b) => a !== b && !!compatMap[pairKey(a, b)];
    const skillByName = {}, skillName = {};
    (input.skills || []).forEach(k => { skillByName[k.name] = k.id; skillName[k.id] = k.name; });
    const staff = (input.staff || []).map(s => Object.assign({ levels: {}, fixed: {}, contract: {} }, s,
      { positions: (s.positions && s.positions.length) ? s.positions : [s.role].filter(Boolean), priority: priorityOf(s) }));
    const staffById = new Map(staff.map(s => [s.id, s]));
    // 計算の高速化用（同じ入力の結果を使い回すだけで、結果は変わらない）
    // 時間帯責任者の不在の許容時間（分）：店舗の設定。未設定は0分（すべての不在を警告）。正式なルールは未決定のため固定値は持たない
    const leaderGap = (input.leaderGapMinutes != null && +input.leaderGapMinutes > 0) ? Math.floor(+input.leaderGapMinutes) : 0;
    return { input, opt, compat, skillByName, skillName, staff, staffById, leaderGap, unitCompatMemo: new Map(), slotMemo: new Map() };
  }

  // 枠同士を同じ人が同時に持てるか
  function unitCompat(ctx, a, b) {
    const mk = a.key + '\u0001' + b.key;
    const memo = ctx.unitCompatMemo || (ctx.unitCompatMemo = new Map());
    let v = memo.get(mk);
    if (v === undefined) { v = unitCompatRaw(ctx, a, b); memo.set(mk, v); }
    return v;
  }
  function unitCompatRaw(ctx, a, b) {
    if (a.key === b.key) return false;
    if (a.kind === 'main' || b.kind === 'main') return true;
    if (a.kind === 'pos' && b.kind === 'pos') return false;
    if (a.kind === 'skill' && b.kind === 'skill') {
      if (a.inPos && !unitCompat(ctx, { kind: 'pos', pos: a.inPos, key: 'pos:' + a.inPos }, b)) return false;
      if (b.inPos && !unitCompat(ctx, a, { kind: 'pos', pos: b.inPos, key: 'pos:' + b.inPos })) return false;
      return ctx.compat(a.skill, b.skill);
    }
    const p = a.kind === 'pos' ? a : b, k = a.kind === 'pos' ? b : a;
    if (k.inPos) return k.inPos === p.pos;   // 内数の業務は対象ポジションの配置として扱う（別ポジションとの同時担当は不可）
    const ps = ctx.skillByName[p.pos];
    if (!ps) return true; // 社員など業務と対応しないポジション
    return k.skill === ps || ctx.compat(k.skill, ps);
  }
  const isEmployee = s => s.empType === '社員' || s.role === '社員';
  function eligible(ctx, s, u) {
    if (u.kind === 'main') return !!s.canMain;
    if (u.kind === 'pos') return s.positions.includes(u.pos);
    if (u.inPos && !s.positions.includes(u.inPos)) return false;
    const lv = s.levels[u.skill];
    return u.level === 'assist' ? (lv === 'solo' || lv === 'assist') : lv === 'solo'; // 補助のみは「単独」枠に数えない
  }
  // 確定シフト等でポジションが決まっている人：そのポジションと両立できる枠だけ
  const lockOf = pos => pos ? { kind: 'pos', pos, key: 'pos:' + pos } : null;
  const allowedWithLock = (ctx, lock, u) => !lock || lock.key === u.key || unitCompat(ctx, lock, u);

  // その日の営業：日付ごとの臨時休業（closedDates）→ 曜日ごとの営業時間（hours）。未設定は null（推測しない）
  //   画面・サーバーが日付ごとに決めた営業時間（dayHours：臨時休業・特別営業時間 → 土日祝 → 通常平日）があればそれを使う
  //   periods：中休みのある日は複数（例 11:00〜15:00・17:00〜22:30）。state:'unknown'＝祝日データ未取得などで決められない日
  function hoursOn(inp, date) {
    if (inp.dayHours && Object.prototype.hasOwnProperty.call(inp.dayHours, date)) return inp.dayHours[date] || null;
    if ((inp.closedDates || []).includes(date)) return { state: 'closed', temporary: true };
    return (inp.hours || {})[dowOf(date)] || null;
  }
  const periodsOf = h => h && h.state === 'open' ? (h.periods && h.periods.length ? h.periods : [{ start: h.open, end: h.close }]) : [];
  // 時間帯別の必要人数の表（店舗ごと）：{start, end, weekday:{ポジション:{開始分:人数}}, weekend:{…}, holidayOn?, holiday?:{…}, totalOn?, total?:{weekday|weekend|holiday:{開始分:人数}}}。30分ごと
  //   マスの値：0 以上の数＝その人数（0＝その時間は不要）。値が無いマス＝未設定（未入力）
  //   holidayOn：祝日は holiday の表（使わない店舗は weekend＝土日祝の表）。祝日の表も、未入力が1マスでもあれば表は未完成
  //   totalOn：店舗全体の最低人数（total）。ホール・キッチンとは別の条件で、空欄は「条件なし」（未入力にはしない）。使う設定で区分の全体が1マスも無ければ知らせる
  const GRID_STEP = 30, GRID_POS = ['ホール', 'キッチン'], GRID_TYPES = ['weekday', 'weekend'], GRID_TYPE_LABEL = { weekday: '平日', weekend: '土日祝', holiday: '祝日' };
  const gridTypes = g => g && g.holidayOn ? GRID_TYPES.concat(['holiday']) : GRID_TYPES;
  const cellSet = v => v !== undefined && v !== null && v !== '' && +v >= 0;
  // 表の完成度：ok＝すべてのマスが入力済み／unset＝表が無い・終了時刻が未設定／incomplete＝未入力のマスがある
  function needGridStatus(g, positions) {
    const pos = positions || GRID_POS, missing = {}; let total = 0;
    if (!g || !(+g.end > +g.start)) return { state: 'unset', missing, missingTotal: 0, cells: 0, totalEmpty: [] };
    let cells = 0;
    gridTypes(g).forEach(ty => pos.forEach(p => {
      const m = ((g[ty] || {})[p]) || {}; let n = 0;
      for (let t = +g.start; t < +g.end; t += GRID_STEP) { cells++; if (!cellSet(m[t])) n++; }
      if (n) { (missing[ty] = missing[ty] || {})[p] = n; total += n; }
    }));
    const totalEmpty = g.totalOn ? gridTypes(g).filter(ty => !Object.values(((g.total || {})[ty]) || {}).some(cellSet)) : [];
    return { state: total ? 'incomplete' : 'ok', missing, missingTotal: total, cells, totalEmpty };
  }
  // その日に使う表の区分：祝日（holiday）は祝日の表があればそれ、無ければ土日祝。土・日は土日祝。ほかは平日
  function gridTypeOf(g, dow, holiday) { return holiday && g && g.holidayOn && g.holiday ? 'holiday' : (dow === 0 || dow === 6 || holiday) ? 'weekend' : 'weekday'; }
  // 表の「全体」（店舗全体の最低人数）→ 判定の区間（同じ人数が続く時間はまとめる。空欄・0 は条件なし）
  function needGridTotals(g, type) {
    const m = (g && g.totalOn && g.total && g.total[type]) || {}, out = [];
    let cur = null;
    for (let t = +g.start; t < +g.end; t += GRID_STEP) {
      const n = cellSet(m[t]) ? Math.floor(+m[t]) : 0, e = Math.min(t + GRID_STEP, +g.end);
      if (cur && cur.count === n && cur.end === t) { cur.end = e; continue; }
      if (cur) out.push(cur);
      cur = n > 0 ? { id: 'grid:total', label: '店舗全体の最低人数', start: t, end: e, count: n } : null;
    }
    if (cur) out.push(cur);
    return out;
  }
  // 表の設定不足の知らせ（作成・再評価の最初に1回）：全体を使う設定なのに、その区分の全体が1マスも無い（推測で人数を決めない）
  function gridNotices(inp) {
    const g = needGridOf(inp); if (!g || !g.totalOn) return [];
    const used = new Set((inp.dates || []).map(d => gridTypeOf(g, dowOf(d), !!((hoursOn(inp, d) || {}).holiday))));
    return needGridStatus(g).totalEmpty.filter(ty => used.has(ty)).map(ty => ({ date: null, staffId: null, type: 'needGridTotalUnset',
      msg: `店舗全体の最低人数（全体）を使う設定ですが、${GRID_TYPE_LABEL[ty]}の表の「全体」が1マスも入っていません（${GRID_TYPE_LABEL[ty]}は店舗全体の人数を判定していません。設定タブの30分ごとの必要人数で入力してください）` }));
  }
  // needGridPartial：未決定（空欄）のマスがある表。決まっているマス（0人を含む）だけを使い、空欄は 0人として扱わずに設定不足として警告する（画面の明示の操作のとき。サーバーの自動作成は渡さない）
  function needGridOf(inp) { const g = inp && (inp.needGrid || inp.needGridPartial); return g && +g.end > +g.start ? g : null; }
  // その区分の表の未決定（空欄）の時間：ホール・キッチンと、全体を使う設定のときの全体
  function gridUndecidedText(g, type) {
    const ranges = m => { const out = []; let s = null; for (let t = +g.start; t <= +g.end; t += GRID_STEP) { const blank = t < +g.end && !cellSet((m || {})[t]); if (blank && s === null) s = t; if (!blank && s !== null) { out.push(`${fmt(s)}〜${fmt(t)}`); s = null; } } return out; };
    const parts = GRID_POS.map(p => { const r = ranges(((g[type] || {})[p])); return r.length ? `${p} ${r.join('、')}` : ''; }).filter(Boolean);
    if (g.totalOn) { const r = ranges((((g.total || {})[type]))); if (r.length) parts.push(`全体 ${r.join('、')}`); }
    return parts.join('／');
  }
  // 表の1区分（weekday／weekend）→ 必要枠（同じ人数が続く時間はまとめる）
  function needGridSegments(g, type) {
    const set = (g && g[type]) || {}, out = [];
    Object.keys(set).forEach(pos => {
      const m = set[pos] || {}, u = { id: 'grid:' + pos, kind: 'pos', pos, key: 'pos:' + pos, label: `${pos}（時間帯別の必要人数）` };
      let cur = null;
      for (let t = +g.start; t < +g.end; t += GRID_STEP) {
        const n = Math.max(0, Math.floor(+m[t] || 0)), e = Math.min(t + GRID_STEP, +g.end);
        if (cur && cur.count === n && cur.end === t) { cur.end = e; continue; }
        if (cur) out.push(cur);
        cur = n > 0 ? { u, start: t, end: e, count: n } : null;
      }
      if (cur) out.push(cur);
    });
    return out;
  }
  // その日の必要枠
  function dayDemand(ctx, date) {
    const inp = ctx.input, dow = dowOf(date);
    const h = hoursOn(inp, date);
    const closed = !!(h && h.state === 'closed');
    const res = { closed, temporary: !!(h && h.temporary), hoursUnset: !h || h.state === 'unknown', holiday: !!(h && h.holiday), active: [], daily: [], totals: [], warnings: [] };
    if (h && h.state === 'unknown') {   // 祝日かどうか等が分からない日：平日扱いせず、条件の判定・作成をしない（要設定）
      res.warnings.push({ date, type: 'holidayUnknown', msg: `営業日の種類（祝日かどうか）を決められないため、必要人数の判定・作成をしていません（${h.reason || '要設定'}）` });
      return res;
    }
    const pers = periodsOf(h);
    // 条件の対象日：祝日は「祝日」の指定（rule.holiday）があればそれに従う。指定が無い（以前の条件）は曜日で判定
    const ruleOn = r => res.holiday && typeof r.holiday === 'boolean' ? r.holiday : (r.dows || []).includes(dow);
    // 時間帯別の必要人数の表（店舗ごと）がある場合、表にあるポジション（ホール・キッチン）の人数条件は使わない（二重に数えない）
    const ng = needGridOf(inp), ngPos = ng ? Object.keys(Object.assign({}, ng.weekday, ng.weekend)) : [];
    (inp.rules || []).filter(r => !r.deleted && ruleOn(r) && !(r.kind === 'pos' && ngPos.includes(r.pos))).forEach(r => {
      // 条件の対象：業務（skill・既定）／ポジションの人数（pos）／時間帯責任者（main）。店舗別・曜日別・時間帯別に設定できる
      const kind = r.kind || 'skill';
      if (kind === 'total') {   // 店舗全体の人数（勤務中の人数で判定）
        const t = { id: r.id, label: '店舗全体の人数', count: Math.max(1, r.count || 1) };
        if (r.span === 'business') {
          if (!h) { res.warnings.push({ date, type: 'hoursUnset', ruleId: r.id, msg: '営業時間が未設定のため、この条件は判定・作成していません' }); return; }
          if (!closed) pers.forEach(p => res.totals.push(Object.assign({ start: p.start, end: p.end }, t)));
        } else if (!closed && r.end > r.start) {
          const segs = pers.length ? pers.map(p => ({ start: Math.max(p.start, r.start), end: Math.min(p.end, r.end) })).filter(x => x.end > x.start) : [{ start: r.start, end: r.end }];
          segs.forEach(x => res.totals.push(Object.assign({ start: x.start, end: x.end }, t)));
        }
        return;
      }
      const u = kind === 'pos' ? { id: r.id, kind: 'pos', pos: r.pos, key: 'pos:' + r.pos, label: `${r.pos}（店舗別の必要人数）` }
        : kind === 'main' ? { id: r.id, kind: 'main', key: 'main', label: '時間帯責任者（店舗別）', gap: (r.gapMinutes != null && r.gapMinutes !== '' && +r.gapMinutes >= 0) ? +r.gapMinutes : null }
        : Object.assign({ id: r.id, kind: 'skill', skill: r.skill, level: r.level || 'solo', key: 'skill:' + r.skill + (r.inPos ? '@' + r.inPos : ''),
          label: `${ctx.skillName[r.skill] || r.skill}（${r.level === 'assist' ? '補助以上' : '単独'}${r.inPos ? '・' + r.inPos + 'の人数に含める' : ''}）` }, r.inPos ? { inPos: r.inPos } : {});
      if (r.span === 'business') {
        if (!h) { res.warnings.push({ date, type: 'hoursUnset', ruleId: r.id, msg: '営業時間が未設定のため、この条件は判定・作成していません' }); return; }
        if (closed) return;
        pers.forEach(p => res.active.push({ u, start: p.start, end: p.end, count: Math.max(1, r.count || 1) }));   // 営業時間中（中休みは除く）
      } else if (!closed && r.end > r.start) {
        // 時間を指定した条件：営業時間が分かる日は、営業時間内（中休みを除く）だけ
        const segs = pers.length ? pers.map(p => ({ start: Math.max(p.start, r.start), end: Math.min(p.end, r.end) })).filter(x => x.end > x.start) : [{ start: r.start, end: r.end }];
        segs.forEach(x => res.active.push({ u, start: x.start, end: x.end, count: Math.max(1, r.count || 1) }));
      }
    });
    // 時間帯別の必要人数（30分ごと・平日／土日祝）：開店前の準備・閉店後の片付けを含め、表の時刻のとおり（営業時間で切らない）
    //   土日祝＝土・日・祝日（振替休日・国民の休日を含む）。営業時間が未設定の日は、祝日かどうか等が分からないため作成しない
    if (inp.needGridPartial && !inp.needGrid && h && !closed && h.state !== 'unknown') {
      const txt = gridUndecidedText(inp.needGridPartial, gridTypeOf(inp.needGridPartial, dow, res.holiday));
      if (txt) res.warnings.push({ date, type: 'needGridUndecided', ruleId: 'needGrid', msg: `必要人数が未決定（設定不足）：${txt}。この時間の人数は判定していません（0人とは別です。設定タブで入力してください）` });
    } else if (inp.needGridState && inp.needGridState !== 'ok' && !closed && !(h && h.state === 'unknown'))
      res.warnings.push({ date, type: 'needGridUnset', ruleId: 'needGrid', msg: inp.needGridState === 'incomplete' ? '30分ごとの必要人数に未入力の時間があるため、ホール・キッチンの人数は判定していません（設定タブで入力してください）' : '30分ごとの必要人数が未設定のため、ホール・キッチンの人数は判定していません（設定タブで設定してください）' });
    if (ng && !closed) {
      if (!h) res.warnings.push({ date, type: 'hoursUnset', ruleId: 'needGrid', msg: '営業時間が未設定のため、時間帯別の必要人数（平日／土日／祝日）は判定・作成していません' });
      else {
        const ty = gridTypeOf(ng, dow, res.holiday);
        res.gridType = ty;
        needGridSegments(ng, ty).forEach(x => res.active.push(x));
        needGridTotals(ng, ty).forEach(x => res.totals.push(x));   // 店舗全体の最低人数（ホール・キッチンとは別の条件。勤務中の人数で判定）
      }
    }
    const pn = inp.positionNeeds;
    if (pn && !closed) {
      (pn.bands || []).forEach((b, bi) => {
        const pdow = res.holiday ? 0 : dow;   // 共通設定（曜日別）では、祝日は日曜と同じ
        Object.keys(pn.req || {}).forEach(pos => {
          const n = +((((pn.req[pos] || {})[pdow]) || {})[bi] || 0);
          if (n > 0) res.active.push({ u: { id: `need:${pos}:${bi}`, kind: 'pos', pos, key: 'pos:' + pos, label: `${pos}（${b.name}）` }, start: b.start, end: b.end, count: n });
        });
        const m = +((((pn.main || {})[pdow]) || {})[bi] || 0);
        if (m > 0) res.active.push({ u: { id: 'main:' + bi, kind: 'main', key: 'main', label: `時間帯責任者（${b.name}）` }, start: b.start, end: b.end, count: m });
      });
      const weekend = dow === 0 || dow === 6 || res.holiday;
      Object.entries(pn.daily || {}).forEach(([pos, v]) => { const n = +((v && (weekend ? v.weekend : v.weekday)) || 0); if (n > 0) res.daily.push({ pos, need: n }); });
    }
    return res;
  }
  // 同じ日（active）・同じ時刻なら同じ配列を返す（読み取り専用。探索結果の使い回しの目印にも使う）
  const unitsAtMemo = new WeakMap(), unitsKeyMemo = new WeakMap();
  function unitsAt(active, t) {
    let byT = unitsAtMemo.get(active);
    if (!byT) { byT = new Map(); unitsAtMemo.set(active, byT); }
    let out = byT.get(t);
    if (!out) { out = unitsAtRaw(active, t); byT.set(t, out); }
    return out;
  }
  function unitsKey(units) {
    let k = unitsKeyMemo.get(units);
    if (k === undefined) { k = units.map(u => u.key).join(','); unitsKeyMemo.set(units, k); }
    return k;
  }
  function unitsAtRaw(active, t) {
    const out = [];
    active.forEach(a => { if (a.start <= t && a.end >= t + SLOT) for (let i = 0; i < a.count; i++) out.push(a.u); });
    return out;
  }

  // 1スロット分の割り当て（全体で最大になる組み合わせを探索）。present: [{s, lock}]
  // prev: staffId -> 直前スロットの枠キー（担当がコロコロ変わらないように優先）
  // 同じ「枠・出勤者・直前の担当」の組み合わせは同じ結果になるため、計算済みの結果を使い回す（月単位の作成で同じ探索を何度も繰り返すため）
  function assignSlot(ctx, units, present, prev) {
    if (!units.length || !present.length) return { count: 0, pick: units.map(() => null) };
    let key = unitsKey(units) + (prev ? '#' : '#np');
    for (let i = 0; i < present.length; i++) {
      const p = present[i]; key += '\u0001' + p.s.id + '\u0002' + (p.lock ? p.lock.key : '');   // 区切りは名前に使われない制御文字
      if (prev) { const pv = prev.get(p.s.id); if (pv) key += '\u0003' + pv.join('\u0004'); }
    }
    const memo = ctx.slotMemo || (ctx.slotMemo = new Map());
    const hit = memo.get(key);
    if (hit) return { count: hit.count, pick: hit.pick.slice() };
    const r = assignSlotRaw(ctx, units, present, prev);
    if (memo.size > 200000) memo.clear();   // メモリの上限対策
    memo.set(key, { count: r.count, pick: r.pick.slice() });
    return r;
  }
  function assignSlotRaw(ctx, units, present, prev) {
    const elig = units.map(u => present.filter(p => eligible(ctx, p.s, u) && allowedWithLock(ctx, p.lock, u)).sort((a, b) => {
      const pa = prev && (prev.get(a.s.id) || []).includes(u.key) ? 0 : 1, pb = prev && (prev.get(b.s.id) || []).includes(u.key) ? 0 : 1;
      if (u.kind === 'main') { const ea = isEmployee(a.s) ? 0 : 1, eb = isEmployee(b.s) ? 0 : 1; if (ea !== eb) return ea - eb; }   // 責任者は社員を先に
      if (pa !== pb) return pa - pb;
      if (u.kind === 'skill' && u.level === 'assist') { const la = a.s.levels[u.skill] === 'assist' ? 0 : 1, lb = b.s.levels[u.skill] === 'assist' ? 0 : 1; if (la !== lb) return la - lb; }
      return (Object.keys(a.s.levels).length + a.s.positions.length) - (Object.keys(b.s.levels).length + b.s.positions.length);
    }));
    const order = units.map((_, i) => i).sort((a, b) => elig[a].length - elig[b].length);
    const taken = new Map(), pick = new Array(units.length).fill(null);
    let best = -1, bestPick = pick.slice(), steps = 0;
    const can = (p, u) => (taken.get(p.s.id) || []).every(x => unitCompat(ctx, x, u));
    (function dfs(i, count) {
      if (++steps > 20000) return true;
      if (count + (order.length - i) <= best) return false;
      if (i === order.length) { best = count; bestPick = pick.slice(); return count === units.length; }
      const ui = order[i], u = units[ui];
      for (const p of elig[ui]) {
        if (!can(p, u)) continue;
        taken.set(p.s.id, (taken.get(p.s.id) || []).concat(u)); pick[ui] = p.s.id;
        const done = dfs(i + 1, count + 1);
        taken.get(p.s.id).pop(); pick[ui] = null;
        if (done) return true;
      }
      return dfs(i + 1, count);
    })(0, 0);
    return { count: Math.max(0, best), pick: bestPick };
  }

  function presentAt(ctx, dayShifts, t) {
    const out = [];
    dayShifts.forEach(sh => {
      if (!(sh.start <= t && sh.end >= t + SLOT)) return;
      if ((sh.breaks || []).some(b => b.start < t + SLOT && b.end > t)) return; // 休憩中は数えない
      const s = ctx.staffById.get(sh.staffId); if (!s) return;
      out.push({ s, lock: sh.lock || null });
    });
    return out;
  }

  // 1日の基本人数（ポジションごとの出勤人数）：1人は1つのポジションにだけ数える
  function dailyMatch(ctx, daily, dayShifts) {
    if (!daily.length) return { short: 0, detail: [] };
    const people = dayShifts.map(sh => ({ s: ctx.staffById.get(sh.staffId), lock: sh.lock })).filter(p => p.s);
    const cands = daily.map(d => people.filter(p => p.s.positions.includes(d.pos) && (!p.lock || p.lock.pos === d.pos)));
    const order = daily.map((_, i) => i).sort((a, b) => cands[a].length / daily[a].need - cands[b].length / daily[b].need);
    const used = new Set(), detail = daily.map(d => ({ pos: d.pos, need: d.need, have: 0 }));
    order.forEach(i => {
      cands[i].slice().sort((a, b) => a.s.positions.length - b.s.positions.length).forEach(p => {
        if (detail[i].have >= daily[i].need || used.has(p.s.id)) return;
        used.add(p.s.id); detail[i].have++;
      });
    });
    return { short: detail.reduce((n, d) => n + Math.max(0, d.need - d.have), 0), detail };
  }

  function evaluateDay(ctx, date, dayShifts, demand) {
    const dem = demand || dayDemand(ctx, date);
    const slots = [];
    let prev = new Map(), shortUnits = 0;
    const totals = dem.totals || [];
    const spans = dem.active.concat(totals);
    if (spans.length) {
      const t0 = Math.floor(Math.min(...spans.map(a => a.start)) / SLOT) * SLOT, t1 = Math.max(...spans.map(a => a.end));
      for (let t = t0; t < t1; t += SLOT) {
        const units = unitsAt(dem.active, t);
        // 店舗全体の人数：この時間に重なる条件のうち最も多い人数（条件を足し合わせない）。勤務中（休憩を除く）の人数で判定
        const tn = totals.filter(x => x.start <= t && x.end >= t + SLOT);
        const tot = tn.length ? tn.reduce((m, x) => x.count > m.need ? { id: x.id, label: x.label, need: x.count } : m, { need: 0 }) : null;
        if (!units.length && !tot) { prev = new Map(); continue; }
        const present = presentAt(ctx, dayShifts, t);
        const r = units.length ? assignSlot(ctx, units, present, prev) : { count: 0, pick: [] };
        const next = new Map();
        r.pick.forEach((sid, i) => { if (sid != null) next.set(sid, (next.get(sid) || []).concat(units[i].key)); });
        prev = next;
        shortUnits += units.length - r.count;
        const sl = { t, units, pick: r.pick };
        // 休憩を除いた勤務行から、同一スタッフは店舗全体に1人だけ数える（元の勤務行は変えない）。
        if (tot) { sl.tot = Object.assign({ have: Math.min(tot.need, new Set(present.map(p => p.s.id)).size) }, tot); shortUnits += tot.need - sl.tot.have; }
        slots.push(sl);
      }
    }
    // 時間帯責任者：不在が続く時間が許容時間以内なら不足に数えない（責任者のためだけに人を足したり延ばしたりしない）
    const mainRuns = leaderRuns(ctx, slots), tolSet = new Set();
    mainRuns.forEach(run => { if (run.tolerated) { shortUnits -= run.shortUnits; run.ts.forEach(t => tolSet.add(run.id + '|' + t)); } });
    const daily = dailyMatch(ctx, dem.daily, dayShifts);
    return { dem, slots, shortUnits, daily, cost: shortUnits + daily.short * DAILY_W, mainRuns, tolSet };
  }
  // 時間帯責任者の枠ごとに、不在（必要数に足りない）の続く時間をまとめる。許容時間＝条件ごとの設定 → 店舗の設定（未設定は0分）
  function leaderRuns(ctx, slots) {
    const by = {};
    slots.forEach(sl => {
      const need = {}, have = {}, unit = {};
      sl.units.forEach((u, i) => { if (u.kind !== 'main') return; need[u.id] = (need[u.id] || 0) + 1; unit[u.id] = u; if (sl.pick[i] != null) have[u.id] = (have[u.id] || 0) + 1; });
      Object.keys(need).forEach(id => {
        const sh = need[id] - (have[id] || 0); if (sh <= 0) return;
        const list = by[id] = by[id] || [];
        const last = list[list.length - 1];
        if (last && last.end === sl.t) { last.end = sl.t + SLOT; last.shortUnits += sh; last.ts.push(sl.t); }
        else list.push({ id, label: unit[id].label, start: sl.t, end: sl.t + SLOT, shortUnits: sh, ts: [sl.t], tol: unit[id].gap != null ? unit[id].gap : ctx.leaderGap });
      });
    });
    const out = [];
    Object.values(by).forEach(list => list.forEach(r => { r.tolerated = r.end - r.start <= r.tol; out.push(r); }));
    return out.sort((a, b) => a.start - b.start);
  }

  const unitInfo = u => Object.assign({ kind: u.kind, skill: u.skill || null, level: u.kind === 'skill' ? u.level : null, pos: u.pos || null, label: u.label }, u.inPos ? { inPos: u.inPos } : {});
  function violationsOf(date, ev) {
    const out = [], open = {};
    ev.slots.forEach(sl => {
      const need = {}, have = {}, unit = {};
      sl.units.forEach((u, i) => { need[u.id] = (need[u.id] || 0) + 1; unit[u.id] = u; if (sl.pick[i] != null) have[u.id] = (have[u.id] || 0) + 1; });
      Object.keys(need).forEach(id => {
        const h = (ev.tolSet && ev.tolSet.has(id + '|' + sl.t)) ? need[id] : (have[id] || 0);   // 許容時間内の責任者の不在は不足にしない
        if (h < need[id]) {
          const g = open[id];
          if (g && g.end === sl.t && g.need === need[id] && g.have === h) g.end = sl.t + SLOT;
          else { if (g) out.push(g); open[id] = Object.assign({ date, start: sl.t, end: sl.t + SLOT, ruleId: id, need: need[id], have: h }, unitInfo(unit[id])); }
        } else if (open[id]) { out.push(open[id]); delete open[id]; }
      });
      if (sl.tot && sl.tot.have < sl.tot.need) { need[sl.tot.id] = sl.tot.need; const g = open[sl.tot.id];
        if (g && g.end === sl.t && g.need === sl.tot.need && g.have === sl.tot.have) g.end = sl.t + SLOT;
        else { if (g) out.push(g); open[sl.tot.id] = { date, start: sl.t, end: sl.t + SLOT, ruleId: sl.tot.id, need: sl.tot.need, have: sl.tot.have, kind: 'total', skill: null, level: null, pos: null, label: sl.tot.label }; } }
      else if (sl.tot) need[sl.tot.id] = sl.tot.need;
      Object.keys(open).forEach(id => { if (!(id in need)) { out.push(open[id]); delete open[id]; } });
    });
    Object.values(open).forEach(g => out.push(g));
    ev.daily.detail.filter(d => d.have < d.need).forEach(d => out.push({ date, start: null, end: null, ruleId: 'daily:' + d.pos, kind: 'daily', skill: null, level: null, pos: d.pos, label: `${d.pos}（1日の基本人数）`, need: d.need, have: d.have }));
    return out.sort((a, b) => (a.start == null ? -1 : a.start) - (b.start == null ? -1 : b.start) || String(a.label).localeCompare(String(b.label)));
  }

  // 担当（スロット）→ スタッフごとの連続した担当時間帯
  function dutiesOf(date, ev) {
    const segs = [];
    let open = new Map();
    ev.slots.forEach(sl => {
      const next = new Map();
      const put = (sid, u) => {
        const k = sid + '|' + u.key;
        if (next.has(k)) return;
        const g = open.get(k);
        if (g && g.end === sl.t) { g.end = sl.t + SLOT; next.set(k, g); open.delete(k); }
        else next.set(k, Object.assign({ staffId: sid, date, start: sl.t, end: sl.t + SLOT }, unitInfo(u)));
      };
      sl.pick.forEach((sid, i) => {
        if (sid == null) return;
        const u = sl.units[i]; put(sid, u);
        // 必要人数は最低値。内数の担当者自身の配置も出力し、最低人数の枠を上限にしない。
        if (u.inPos) put(sid, sl.units.find(p => p.kind === 'pos' && p.pos === u.inPos) || { kind: 'pos', pos: u.inPos, key: 'pos:' + u.inPos, label: `${u.inPos}（業務の配置）` });
      });
      open.forEach(g => segs.push(g));
      open = next;
    });
    open.forEach(g => segs.push(g));
    return segs.sort((x, y) => String(x.staffId).localeCompare(String(y.staffId), 'ja', { numeric: true }) || x.start - y.start || String(x.label).localeCompare(String(y.label)));
  }

  // 同じ人のもう一方の店舗の登録（管理者がつないだ組）で勤務している時間：input.busy[staffId][date] = [{start,end}]
  const busyOf = (ctx, s, date) => ((ctx.input.busy || {})[s.id] || {})[date] || [];
  const hitsBusy = (ctx, s, date, st, en) => busyOf(ctx, s, date).some(b => b.start < en && b.end > st);
  // 勤務できる時間から、もう一方の登録で勤務している時間を除く（重ならない時間は残す）
  function cutBusy(ws, busy) {
    if (!busy.length) return ws;
    let out = ws;
    busy.forEach(b => { out = out.flatMap(w => (b.end <= w.start || b.start >= w.end) ? [w] : [{ ...w, end: b.start }, { ...w, start: b.end }].filter(x => x.end > x.start)); });
    return out;
  }
  function windowsFor(ctx, s, date) {
    const inp = ctx.input, dow = dowOf(date);
    if (((inp.offs || {})[s.id] || []).includes(date)) return [];
    const busy = busyOf(ctx, s, date);
    const req = ((inp.requests || {})[s.id] || {})[date];
    if (req && req.length) return cutBusy(req.map(r => ({ start: r.start, end: r.end, src: 'request' })), busy);
    const av = ((inp.availability || {})[s.id] || {})[dow];
    if (av && av.length) return cutBusy(av.map(r => ({ start: r.start, end: r.end, src: 'auto' })), busy);
    if (ctx.opt.unrequestedAvailable) return cutBusy([{ start: ctx.opt.dayStart, end: ctx.opt.dayEnd, src: 'auto' }], busy);
    return [];
  }

  // 拘束時間 len に必要な最短の休憩（実働時間で判定）
  function breakMinutes(ctx, len) {
    const opts = [0].concat(ctx.opt.breakRules.map(r => r.min)).sort((a, b) => a - b);
    for (const b of opts) if (ctx.opt.breakRules.every(r => !(len - b > r.overWork) || b >= r.min)) return b;
    return opts[opts.length - 1];
  }

  // 期間中の勤務の集計（契約条件・公平性に使う）
  function newAcc(ctx) {
    const acc = { mins: new Map(), week: new Map(), days: new Map(), ot: new Map(), xw: new Map(), lo: new Map() };   // ot・xw・lo：社員の延長（月・週・法定時間外）
    Object.entries(ctx.input.usedMinutes || {}).forEach(([k, v]) => acc.mins.set(isNaN(+k) ? k : +k, v));
    Object.entries(ctx.input.workedDates || {}).forEach(([k, ds]) => acc.days.set(isNaN(+k) ? k : +k, new Set(ds)));
    // 他店舗での勤務（複数店舗勤務）：同じ人の月・週の勤務時間と勤務日に数える（契約の上限・連続勤務を店舗をまたいで守る）
    Object.entries(ctx.input.externalWork || {}).forEach(([k, list]) => {
      const id = isNaN(+k) ? k : +k;
      (list || []).forEach(x => {
        acc.mins.set(id, (acc.mins.get(id) || 0) + (x.minutes || 0));
        const wk = id + '|' + weekKey(x.date); acc.week.set(wk, (acc.week.get(wk) || 0) + (x.minutes || 0));
        if (!acc.days.has(id)) acc.days.set(id, new Set()); acc.days.get(id).add(x.date);
      });
    });
    return acc;
  }
  function contractProblem(ctx, acc, s, date, work) {
    const c = s.contract || {}, wk = weekKey(date), days = acc.days.get(s.id) || new Set();
    if (c.maxDayMinutes && work > c.maxDayMinutes) return '1日の上限時間';
    if (c.maxWeekMinutes && (acc.week.get(s.id + '|' + wk) || 0) + work > c.maxWeekMinutes) return '週の上限時間';
    if (c.maxMonthMinutes && (acc.mins.get(s.id) || 0) + work > c.maxMonthMinutes) return '月の上限時間';
    if (c.maxDaysPerWeek && [...days].filter(d => weekKey(d) === wk).length >= c.maxDaysPerWeek) return '週の勤務日数';
    if (ctx.opt.maxConsecutiveDays) {
      let n = 0; for (let d = addDays(date, -1); days.has(d); d = addDays(d, -1)) n++;
      if (n + 1 > ctx.opt.maxConsecutiveDays) return '連続勤務日数';
    }
    return null;
  }

  // ---- 社員：月ごとの所定労働時間にもとづく作成 ----
  // staff.monthly['YYYY-MM'] = {
  //   minutes      : その月の所定労働時間（分。休憩を除く実働）
  //   offDows      : 毎週の固定休日（曜日 0〜6）
  //   dayHours     : 曜日別の勤務時間 {曜日:{start,end}}（未設定の曜日は店舗の営業時間）
  //   halfOff      : 毎週の固定半休 {曜日:'am'|'pm'}（am＝午前休み・pm＝午後休み）
  //   halfSplit    : 半休の区切り（分。未設定はその日の勤務時間の真ん中）
  //   breakMin     : 休憩時間（6時間を超える日に取る長さ。法定より短い値は法定に合わせる）
  //   exceptions   : 日付ごと {date:{type:'off'|'paid'|'am'|'pm'|'work', start?, end?}}
  //                  off＝希望休・paid＝有給・am/pm＝その日だけの半休・work＝臨時の勤務変更（指定した時間で勤務）
  // }
  // 固定休・希望休・有給は変更しない（時間数を合わせるために勝手に勤務日にしない）。
  // 有給などを所定時間の達成判定に入れるかは会社の運用ルールが未確定のため、達成判定には入れず日数だけを示す。
  const monthOf = date => date.slice(0, 7);
  const empSettings = (s, mk) => (s.monthly && s.monthly[mk] && s.monthly[mk].minutes > 0) ? s.monthly[mk] : null;
  // 社員の確定シフト（Excel等で取り込んだもの）：staff.confirmed[date] = {kind:'work'|'off'|'away', start?, end?}
  //   work＝この店舗で勤務（時間は勤務条件から。分からなければ start/end なし）・off＝休み・away＝他店舗で勤務
  //   確定シフトは自動作成で変更しない。時間が分からない日は推測せずに警告し、配置しない
  const confirmedOf = (s, date) => (s.confirmed && s.confirmed[date]) || null;
  // 確定シフトがある月は、その月のすべての日を確定シフトに従う（記載の無い日・不明な区分の日も自動では入れない）
  const confMonths = s => s._confMonths || (s._confMonths = new Set(Object.keys(s.confirmed || {}).map(d => d.slice(0, 7))));
  const hasConfirmed = (s, mk) => confMonths(s).has(mk);
  const isEmpDay = (s, date) => !!empSettings(s, monthOf(date)) || hasConfirmed(s, monthOf(date));
  // 社員の休憩：その日だけの休憩（dayBreaks・法定より短ければ法定）→ 6時間を超える日は社員ごとの休憩（未設定は基本の120分。法定より短ければ法定）、それ以外は法定
  function empBreak(ctx, m, len, date) {
    const legal = breakMinutes(ctx, len);
    const d = m && m.dayBreaks && date != null ? m.dayBreaks[date] : null;
    if (d != null && d !== '' && +d >= 0) return Math.max(legal, +d);
    const base = m && m.breakMin != null && m.breakMin !== '' ? +m.breakMin : ctx.opt.empBreakDefault;
    return len > 360 ? Math.max(legal, base) : legal;
  }
  const empWork = (ctx, m, len, date) => len - empBreak(ctx, m, len, date);
  // 勤務時間の扱い（勤務条件）：'fixed'＝固定（変更しない）／'range'＝勤務できる範囲（範囲内で自動決定）／''＝未選択（従来どおり：基本の時間。所定に合わせて退勤を早める）
  const timeModeOf = (m, dow) => { const dh = m && m.dayHours && m.dayHours[dow]; const v = (dh && dh.mode) || (m && m.timeMode) || ''; return v === 'fixed' || v === 'range' ? v : ''; };
  // 範囲内で自動決定する日の基本の長さ（拘束）：実働が8時間以内で最も長い30分単位の長さ（範囲の長さまで）
  // 社員の休憩を置ける開始時刻（30分単位）：休憩の時間帯（14:00〜17:00）の中に連続 bm 分。休憩の前に60分以上・後に30分以上の勤務
  function empBreakSlots(ctx, st, en, bm) {
    const W = ctx.opt.empBreakWindow, out = [];
    if (!(bm > 0)) return out;
    for (let b = ceilStep(Math.max(W.start, st + 60)); b + bm <= Math.min(W.end, en - EMP_STEP); b += EMP_STEP) out.push(b);
    return out;
  }
  // 範囲内で自動決定する日：長さ len で、休憩を時間帯の中に置ける出勤時刻があるか（開始が決まっている日はその時刻で）
  function flexBreakFits(ctx, z, len, bm) {
    if (!(bm > 0)) return true;
    if (z.pin != null) return empBreakSlots(ctx, z.pin, z.pin + len, bm).length > 0;
    for (let st = ceilStep(z.lo); st + len <= z.hi; st += EMP_STEP) if (empBreakSlots(ctx, st, st + len, bm).length) return true;
    return false;
  }
  function nominalSpan(ctx, m, start, hi, date) {
    for (let len = floorStep(hi - start); len >= EMP_STEP; len -= EMP_STEP) if (empWork(ctx, m, len, date) <= LEGAL_DAY) return len;
    return 0;
  }
  // 月間の残業許容（社内の運用。法令上の上限とは別）：契約条件 staff.contract
  //   rank：'manager'＝店長以上（予定残業の許容は常に0時間）／'staff'＝一般社員（店長未満。otAllowMinutes＝個人ごとの許容）
  //   役職が未設定・一般社員で許容が未設定 → 推測せず0時間として計画し、要設定を警告
  //   役職名だけで労働基準法上の管理監督者とは判断しない（店長以上も実労働時間・法定時間外を集計する）
  function otPolicy(s) {
    const c = s.contract || {}, rank = c.rank === 'manager' || c.rank === 'staff' ? c.rank : null;
    const v = rank === 'manager' ? 0 : rank === 'staff' && c.otAllowMinutes != null && c.otAllowMinutes >= 0 ? +c.otAllowMinutes : null;
    return { rank, allow: v == null ? 0 : v, unset: v == null };
  }
  // 社員の月の集計 → 警告（所定に届かない・所定外・上限超え・許容が未設定・36協定の上限超え）。作成・再評価で共通
  function empWarnings(input, e, out, extra) {
    const W = (type, msg) => out.warnings.push({ date: null, staffId: e.staffId, type, msg });
    if (e.diffMinutes < 0) W('empShort', `${e.month}：所定労働時間 ${fmtH(e.targetMinutes)} に対して ${fmtH(-e.diffMinutes)} 不足します${extra || ''}`);
    else if (e.diffMinutes > 0 && e.allowMinutes != null && e.diffMinutes > e.allowMinutes) W('empOverCap', `${e.month}：所定労働時間 ${fmtH(e.targetMinutes)}＋許容残業 ${fmtH(e.allowMinutes)}${e.rank === 'manager' ? '（店長以上）' : ''} を ${fmtH(e.diffMinutes - e.allowMinutes)} 超えます（確定シフト・勤務変更・手で直した勤務など、自動では変えない勤務のため。確認してください）`);
    else if (e.diffMinutes > 0) W('empOver', `${e.month}：所定労働時間 ${fmtH(e.targetMinutes)} を ${fmtH(e.diffMinutes)} 超えます（所定外。許容残業 ${fmtH(e.allowMinutes || 0)} の範囲内）`);
    if (e.allowUnset) W('empOtUnset', `${e.month}：${e.rank === 'staff' ? '残業許容時間' : '役職（店長以上／一般社員）'}が未設定のため、残業の許容を0時間として扱いました（社員の勤務条件で設定してください）`);
    const lc = input.law36 && input.law36.monthMinutes > 0 ? input.law36.monthMinutes : null;
    if (lc != null && e.legalOtMinutes > lc) W('law36Over', `${e.month}：法定時間外 ${fmtH(e.legalOtMinutes)} が、36協定の上限として設定した ${fmtH(lc)} を超えます（作成期間の中の計算）`);
  }
  // 朝の準備担当（staff.morningPrep＝社員ごとに管理者が設定。退勤時刻などから推測しない）：出勤日は 8:30 開始。退勤時刻・休憩は勤務条件のまま
  //   確定した開始時刻（Excel に書かれた時刻・その日の勤務変更＝fixedTime）が 8:30 以外なら、自動では変えずに警告する
  const PREP_START = 510;
  const hhmm = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  function prepTimes(s, date, t, warnings) {
    if (!s.morningPrep) return t;
    const why = t.fixedTime === 'excel' ? 'Excel の確定シフト' : t.fixedTime === 'change' ? 'その日の勤務変更' : t.fixedTime === 'cond' ? '勤務条件の固定の時間' : null;
    if (why) {
      if (t.start !== PREP_START) warnings.push({ date, staffId: s.id, type: 'prepStartFixed', msg: `朝の準備担当ですが、${why}の開始時刻が ${hhmm(t.start)} です（8:30 に自動では変えていません。確認してください）` });
      return t;
    }
    if (t.half === 'am') { warnings.push({ date, staffId: s.id, type: 'prepHalfAm', msg: '朝の準備担当ですが、午前休みのため 8:30 からは入れていません' }); return t; }
    if (!(t.end > PREP_START)) { warnings.push({ date, staffId: s.id, type: 'prepEndEarly', msg: `朝の準備担当ですが、勤務条件の退勤時刻（${hhmm(t.end)}）が 8:30 より前のため、開始時刻を変えていません（勤務条件を確認してください）` }); return t; }
    return Object.assign({}, t, { start: PREP_START, prep: true });
  }
  // 確定済みのシフト（シフト表で確定・公開済み）：変えない。朝の準備担当で開始が 8:30 以外なら警告
  function prepLocked(s, date, lk, warnings) {
    if (!s.morningPrep) return;
    const st = Math.min(...lk.map(l => l.start));
    if (st !== PREP_START) warnings.push({ date, staffId: s.id, type: 'prepStartLocked', msg: `朝の準備担当ですが、確定済みのシフトの開始時刻が ${hhmm(st)} です（確定済みのため変えていません。確認してください）` });
  }
  function daysInMonth(mk) { const [y, m] = mk.split('-').map(Number); return new Date(y, m, 0).getDate(); }

  // 期間内の社員の勤務日・時間を月ごとに決める（plan の最初に1回。結果は JSON にできる値だけ）
  function planEmployees(ctx) {
    const inp = ctx.input, dates = inp.dates || [];
    const byDate = {}, summary = [], warnings = [];
    const ot = { budget: {}, legal: {}, week: {} };   // 作成中の延長（残業）の判定用（JSON にできる値だけ）
    const months = [...new Set(dates.map(monthOf))];
    const weightMemo = {};
    const weightOf = (date, st, en) => {   // その日・その時間帯に必要な人数の合計（大きい日ほど社員を残す）
      const dem = weightMemo[date] || (weightMemo[date] = dayDemand(ctx, date));
      let w = 0;
      dem.active.forEach(a => { const o = Math.min(en, a.end) - Math.max(st, a.start); if (o > 0) w += o * a.count; });
      return w + dem.daily.reduce((n, d) => n + d.need * 60, 0);
    };
    ctx.staff.forEach(s => months.forEach(mk => {
      const m = empSettings(s, mk);
      if (hasConfirmed(s, mk)) { planConfirmed(s, mk, m); return; }
      if (!m) return;
      const exc = m.exceptions || {}, offDows = new Set((m.offDows || []).map(Number));
      const inMonth = dates.filter(d => monthOf(d) === mk);
      const partial = inMonth.length < daysInMonth(mk);
      // 期間が月の一部だけのときは、所定時間を日数の割合で按分（警告を出す）
      const ovT = inp.empTargets && inp.empTargets[s.id + '|' + mk];   // 再調整（この日だけ）：その日に使える時間（ほかの日の勤務を差し引いた所定と上限）
      const target = ovT ? ovT.target : Math.round(m.minutes * (partial ? inMonth.length / daysInMonth(mk) : 1) / SLOT) * SLOT;
      const sum = { staffId: s.id, month: mk, targetMinutes: target, monthMinutes: m.minutes, partial: ovT ? false : partial, lockedMinutes: 0, paidDays: 0, offDays: 0, wishOffDays: 0, halfDays: 0, changeDays: 0, closedDays: 0, modeUnsetDays: 0 };
      const cands = [], lockedBy = {};
      inMonth.forEach(date => {
        const dow = dowOf(date), e = exc[date] || null;
        const lk = (inp.locked || []).filter(l => l.date === date && l.staffId === s.id);
        if (lk.length) { prepLocked(s, date, lk, warnings); lk.forEach(l => { const w = (l.end - l.start) - (l.breaks || []).reduce((n, b) => n + b.end - b.start, 0); sum.lockedMinutes += w; lockedBy[date] = (lockedBy[date] || 0) + w; }); return; }
        if (e && e.type === 'paid') { sum.paidDays++; return; }
        if (e && e.type === 'off') { sum.offDays++; return; }
        if (((inp.offs || {})[s.id] || []).includes(date)) { sum.wishOffDays++; return; }
        const h = hoursOn(inp, date);
        if (h && h.state === 'closed' && !(e && e.type === 'work')) { if (!offDows.has(dow)) sum.closedDays++; return; }
        if (e && e.type === 'work' && e.end > e.start) { sum.changeDays++; prepTimes(s, date, { start: e.start, end: e.end, fixedTime: 'change' }, warnings); cands.push({ date, start: e.start, end: e.end, fixed: true }); return; }
        if (offDows.has(dow)) return;   // 固定休日
        // 朝の準備担当：退勤時刻は勤務条件（曜日別の時間）から。未設定なら店舗の営業時間で推測せず、入れない
        if (s.morningPrep && !((m.dayHours || {})[dow] && m.dayHours[dow].end > m.dayHours[dow].start)) { warnings.push({ date, staffId: s.id, type: 'prepNoHours', msg: '朝の準備担当ですが、勤務条件の曜日別の勤務時間（退勤時刻）が未設定のため、この日は入れていません' }); return; }
        // 曜日別の勤務時間（勤務できる時間）が未設定：店舗の営業時間などで推測せず、入れない（要確認）
        const dh = (m.dayHours || {})[dow];
        if (!dh || !(dh.end > dh.start)) { warnings.push({ date, staffId: s.id, type: 'empNoHours', msg: '社員の曜日別の勤務時間（勤務できる時間）が未設定のため、推測せずこの日は入れていません（要確認：社員の勤務条件で設定してください）' }); return; }
        let st = dh.start, en = dh.end;
        const half = (e && (e.type === 'am' || e.type === 'pm')) ? e.type : ((m.halfOff || {})[dow] || null);
        if (half) {
          const split = m.halfSplit != null ? m.halfSplit : Math.round((st + en) / 2 / SLOT) * SLOT;
          if (half === 'am') st = Math.max(st, split); else en = Math.min(en, split);
          sum.halfDays++;
          if (!(en > st)) return;
        }
        const mode = timeModeOf(m, dow);
        if (!mode) sum.modeUnsetDays++;
        if (mode === 'fixed') {   // 固定の時間：変えない（所定に合わせて日を減らすことはある）
          prepTimes(s, date, { start: st, end: en, fixedTime: 'cond' }, warnings);
          cands.push({ date, start: st, end: en, fixed: false, noTrim: true });
          return;
        }
        if (mode === 'range') {   // 勤務できる範囲：この中で出勤・退勤を自動で決める（30分単位）
          const f = flexDay(s, m, date, st, en, half, warnings);
          if (f) cands.push(f);
          return;
        }
        const pt = prepTimes(s, date, { start: st, end: en, half }, warnings);
        cands.push({ date, start: pt.start, end: en, fixed: false, prep: !!pt.prep });
      });
      cands.forEach(c => { c.w = weightOf(c.date, c.flex ? c.lo : c.start, c.flex ? c.hi : c.end); c.h = tieHash(c.date + '|' + tieIdOf(ctx, s.id)); });
      if (sum.modeUnsetDays) warnings.push({ date: null, staffId: s.id, type: 'empTimeModeUnset', msg: `${mk}：勤務時間の扱い（固定／範囲内で自動決定）が未選択のため、曜日別の時間を基本の時間として扱いました（${sum.modeUnsetDays}日。要確認：社員の勤務条件で選んでください）` });
      const need = Math.max(0, target - sum.lockedMinutes);
      const workOf = c => empWork(ctx, m, c.end - c.start, c.date);
      let chosen = cands.slice(), total = chosen.reduce((n, c) => n + workOf(c), 0);
      // 週の勤務日数の上限（契約）・連続勤務の上限：必要人数の少ない日から外す
      const c = s.contract || {};
      const dropLowest = list => { const x = list.filter(z => !z.fixed).sort((a, b) => a.w - b.w || a.h - b.h)[0]; if (x) { chosen = chosen.filter(z => z !== x); total -= workOf(x); } return !!x; };
      if (c.maxDaysPerWeek) {
        const byWeek = {}; chosen.forEach(z => (byWeek[weekKey(z.date)] = byWeek[weekKey(z.date)] || []).push(z));
        Object.values(byWeek).forEach(list => { let l = list.slice(); while (l.length > c.maxDaysPerWeek && dropLowest(l)) l = chosen.filter(z => list.includes(z)); });
      }
      if (ctx.opt.maxConsecutiveDays) {
        for (let guard = 0; guard < 40; guard++) {
          const ds = chosen.map(z => z.date).sort(); let run = [], bad = null;
          for (const d of ds) { run = (run.length && addDays(run[run.length - 1], 1) === d) ? run.concat(d) : [d]; if (run.length > ctx.opt.maxConsecutiveDays) { bad = run; break; } }
          if (!bad || !dropLowest(chosen.filter(z => bad.includes(z.date)))) break;
        }
      }
      // 所定時間を超える分：必要人数の少ない日から休みにする（超過がその日の実働以上のときだけ）
      for (const x of chosen.filter(z => !z.fixed).sort((a, b) => a.w - b.w || a.h - b.h)) {
        if (total - need >= workOf(x)) { chosen = chosen.filter(z => z !== x); total -= workOf(x); }
      }
      // 範囲内で自動決定する日：所定（超えるなら上限）に近づくまで、長い日から退勤を30分ずつ早める
      const pol = ovT ? Object.assign({}, otPolicy(s), { allow: Math.max(0, ovT.allow || 0) }) : otPolicy(s), cap = need + pol.allow;
      const workAt = (z, len) => empWork(ctx, m, len, z.date);
      total = shortenFlex(chosen, total, need, cap, workAt);
      // 残りの超過：必要人数の少ない日から終了時刻を15分ずつ早める（最短の勤務時間は守る。実働が近づくときだけ）
      for (let pass = 0; pass < 64 && total > need; pass++) {
        let moved = false;
        for (const x of chosen.filter(z => !z.fixed && !z.prep && !z.flex && !z.noTrim).sort((a, b) => a.w - b.w || a.h - b.h)) {   // 朝の準備担当は退勤時刻を勤務条件のまま（早めない）
          if (total <= need) break;
          const len = x.end - x.start, nl = len - SLOT;
          if (nl < Math.min(ctx.opt.minShift, len)) continue;
          const d = workOf(x) - empWork(ctx, m, nl, x.date);
          if (d <= 0 || Math.abs(total - d - need) >= Math.abs(total - need)) continue;
          x.end -= SLOT; total -= d; moved = true;
        }
        if (!moved) break;
      }
      // 上限（所定＋許容残業）を超える分：勝手に超過配置しない。退勤を15分ずつ早める（朝の準備担当・勤務変更は除く）→ それでも超えれば必要人数の少ない日から休みにする
      for (let guard = 0; guard < 400 && total > cap; guard++) {
        const sh = chosen.filter(z => !z.fixed && !z.prep && !z.flex && !z.noTrim && (z.end - z.start - SLOT) >= Math.min(ctx.opt.minShift, z.end - z.start)).sort((a, b) => a.w - b.w || a.h - b.h)[0];
        if (sh && total - cap < workOf(sh)) { const d = workOf(sh) - empWork(ctx, m, sh.end - sh.start - SLOT, sh.date); sh.end -= SLOT; total -= d; continue; }
        if (!dropLowest(chosen)) break;
      }
      // 法定の週40時間（36協定の上限が未設定なら超えない／設定があればその月の上限まで）：自動で決める日だけ短くする
      total = legalFlex(chosen, total, lockedBy, workAt);
      Object.assign(sum, { rank: pol.rank, allowMinutes: pol.allow, allowUnset: pol.unset, capMinutes: target + pol.allow });
      chosen.sort((a, b) => a.date < b.date ? -1 : 1).forEach(z => {
        (byDate[z.date] = byDate[z.date] || []).push(Object.assign({ staffId: s.id, start: z.start, end: z.end, breakMin: empBreak(ctx, m, z.end - z.start, z.date) }, z.prep ? { prep: true } : {}, z.flex ? { flex: true, lo: z.lo, hi: z.hi, pin: z.pin } : {}));
      });
      otNote(s, mk, need + (ovT ? pol.allow : allowIn(pol.allow, inMonth.length, mk)), total, chosen, lockedBy, workAt);
      sum.plannedMinutes = total + sum.lockedMinutes;
      sum.workDays = chosen.length;
      summary.push(sum);
    }));
    // 30分ごとの必要人数（ホール・キッチン）：担当ポジションにホール・キッチンが無い社員は、その人数に数えない（推測しない）→ 知らせる
    const ng = needGridOf(inp);
    if (ng) {
      const gp = Object.keys(Object.assign({}, ng.weekday, ng.weekend));
      ctx.staff.filter(s => isEmployee(s) && dates.some(d => isEmpDay(s, d)) && !s.positions.some(p => gp.includes(p)))
        .forEach(s => warnings.push({ date: null, staffId: s.id, type: 'empNoGridPos', msg: `担当ポジションに${gp.join('・')}が無いため、この社員の勤務は30分ごとの必要人数（${gp.join('・')}）に数えていません（スタッフ管理の「できるポジション」で設定してください）` }));
    }
    return { byDate, summary, warnings, ot };

    // 範囲内で自動決定する日の候補：基本は実働8時間以内（30分単位）。朝の準備担当は 8:30 開始（退勤は自動）。pinStart＝確定した開始時刻（Excel）
    function flexDay(s, m, date, lo, hi, half, warnings, pinStart) {
      let pin = pinStart != null ? pinStart : null;
      if (s.morningPrep) {
        if (pin != null) { if (pin !== PREP_START) warnings.push({ date, staffId: s.id, type: 'prepStartFixed', msg: `朝の準備担当ですが、Excel の確定シフトの開始時刻が ${hhmm(pin)} です（8:30 に自動では変えていません。確認してください）` }); }
        else if (half === 'am') warnings.push({ date, staffId: s.id, type: 'prepHalfAm', msg: '朝の準備担当ですが、午前休みのため 8:30 からは入れていません' });
        else if (!(hi > PREP_START)) warnings.push({ date, staffId: s.id, type: 'prepEndEarly', msg: `朝の準備担当ですが、勤務できる範囲の終わり（${hhmm(hi)}）が 8:30 より前のため、開始時刻を変えていません（勤務条件を確認してください）` });
        else {
          if (lo > PREP_START) warnings.push({ date, staffId: s.id, type: 'prepRangeStart', msg: `朝の準備担当のため 8:30 開始にしました（勤務条件の勤務できる範囲は ${hhmm(lo)} からです。確認してください）` });
          pin = PREP_START;
        }
      }
      const st = pin != null ? pin : ceilStep(lo);
      const len = nominalSpan(ctx, m, st, hi, date);
      if (!(len > 0)) { warnings.push({ date, staffId: s.id, type: 'empRangeShort', msg: `勤務できる範囲（${hhmm(lo)}〜${hhmm(hi)}）が短いため、この日は入れていません（要確認）` }); return null; }
      return { date, start: st, end: st + len, fixed: false, flex: true, lo: pin != null ? pin : lo, hi, pin, prep: pin === PREP_START && !!s.morningPrep };
    }
    // 自動で決める日を、所定に近づくまで（上限を超える間は必ず）長い日から30分ずつ短くする。同じ長さなら必要人数の少ない日から
    function shortenFlex(list, total, need, cap, workAt) {
      const stuck = new Set();
      for (let g = 0; g < 4000 && (total > cap || total > need); g++) {
        const x = list.filter(z => z.flex && !stuck.has(z) && z.end - z.start - EMP_STEP >= Math.min(ctx.opt.minShift, z.end - z.start))
          .sort((a, b) => (b.end - b.start) - (a.end - a.start) || (a.w || 0) - (b.w || 0) || (a.h || 0) - (b.h || 0))[0];
        if (!x) break;
        const d = workAt(x, x.end - x.start) - workAt(x, x.end - x.start - EMP_STEP);
        if (d <= 0) { stuck.add(x); continue; }   // 休憩の段階が変わり実働が減らない長さ
        { const nl = x.end - x.start - EMP_STEP; if (!flexBreakFits(ctx, x, nl, nl - workAt(x, nl))) { stuck.add(x); continue; } }   // 休憩を時間帯の中に置けなくなる長さにしない
        if (total <= cap && Math.abs(total - d - need) >= Math.abs(total - need)) break;
        x.end -= EMP_STEP; total -= d;
      }
      return total;
    }
    // 法定の時間（日曜始まりの週40時間・1日8時間）：36協定の上限が未設定なら週40時間を超えない。設定があれば、その月の法定時間外を上限以内にする
    //   自動で決める日だけを短くする（確定シフト・固定の時間は変えない。残る超過は作成後の確認で警告）
    function legalFlex(list, total, lockedBy, workAt) {
      const law = inp.law36 && inp.law36.monthMinutes > 0 ? inp.law36.monthMinutes : null;
      const stuck = new Set();
      for (let g = 0; g < 4000; g++) {
        const lg = legalOfPlan(list, lockedBy, workAt);
        const weeks = Object.keys(lg.week).filter(k => lg.week[k] > LEGAL_WEEK);
        if (!weeks.length || (law != null && lg.total <= law)) break;
        const x = list.filter(z => z.flex && !stuck.has(z) && weeks.includes(sunKey(z.date)) && z.end - z.start - EMP_STEP >= Math.min(ctx.opt.minShift, z.end - z.start))
          .sort((a, b) => (b.end - b.start) - (a.end - a.start) || (a.w || 0) - (b.w || 0) || (a.h || 0) - (b.h || 0))[0];
        if (!x) break;
        const d = workAt(x, x.end - x.start) - workAt(x, x.end - x.start - EMP_STEP);
        if (d <= 0) { stuck.add(x); continue; }
        { const nl = x.end - x.start - EMP_STEP; if (!flexBreakFits(ctx, x, nl, nl - workAt(x, nl))) { stuck.add(x); continue; } }
        x.end -= EMP_STEP; total -= d;
      }
      return total;
    }
    function legalOfPlan(list, lockedBy, workAt) {
      const week = {}, days = {};
      list.forEach(z => { days[z.date] = (days[z.date] || 0) + workAt(z, z.end - z.start); });
      Object.entries(lockedBy || {}).forEach(([d, v]) => { days[d] = (days[d] || 0) + v; });
      let total = 0;
      Object.entries(days).forEach(([d, w]) => { total += Math.max(0, w - LEGAL_DAY); const k = sunKey(d); week[k] = (week[k] || 0) + Math.min(w, LEGAL_DAY); });
      Object.values(week).forEach(w => { total += Math.max(0, w - LEGAL_WEEK); });
      return { total, week };
    }
    // 延長に使える残業許容：作成期間が月の一部なら、所定時間と同じく日数で按分する（月の許容を一部の期間で使い切らない）
    function allowIn(allow, days, mk) { return days < daysInMonth(mk) ? Math.round(allow * days / daysInMonth(mk) / SLOT) * SLOT : allow; }
    // 作成中の延長（残業）の判定に使う値：延長できる時間（上限−計画）・週ごとの計画（法定の数え方）・計画の法定時間外
    function otNote(s, mk, cap, total, list, lockedBy, workAt) {
      const key = s.id + '|' + mk, lg = legalOfPlan(list, lockedBy, workAt);
      ot.budget[key] = cap == null ? 0 : Math.max(0, cap - total);
      ot.legal[key] = lg.total;
      Object.entries(lg.week).forEach(([k, w]) => { const wk = s.id + '|' + k; ot.week[wk] = (ot.week[wk] || 0) + w; });
    }

    // 確定シフトの月：勤務日・休み・他店舗はそのまま。時間は Excel の時刻 → 勤務条件（固定の時間／勤務できる範囲の中で自動決定）。分からなければ警告して配置しない
    function planConfirmed(s, mk, m) {
      const inMonth = dates.filter(d => monthOf(d) === mk);
      const partial = inMonth.length < daysInMonth(mk);
      const ovT = inp.empTargets && inp.empTargets[s.id + '|' + mk];
      const target = ovT ? ovT.target : m ? Math.round(m.minutes * (partial ? inMonth.length / daysInMonth(mk) : 1) / SLOT) * SLOT : null;
      const sum = { staffId: s.id, month: mk, confirmed: true, targetMinutes: target, monthMinutes: m ? m.minutes : null, partial: ovT ? false : partial, lockedMinutes: 0, paidDays: 0, offDays: 0, wishOffDays: 0, halfDays: 0, changeDays: 0, closedDays: 0, awayDays: 0, unknownTimeDays: 0, missingDays: 0, autoTimeDays: 0 };
      let total = 0, n = 0;
      const fixedList = [], flexList = [], lockedBy = {}, unknownDates = [];
      // その日の休憩の設定：取り込み時の値（社員ごと・その日だけ）→ 月の設定 → 基本の120分
      const mOf = (c, date) => Object.assign({}, m || {}, c.breakMin != null ? { breakMin: c.breakMin } : {}, c.dayBreak != null ? { dayBreaks: { [date]: c.dayBreak } } : {});
      const workAt = (z, len) => empWork(ctx, z.mm, len, z.date);
      inMonth.forEach(date => {
        let c = confirmedOf(s, date);
        const lk = (inp.locked || []).filter(l => l.date === date && l.staffId === s.id);
        if (lk.length) { prepLocked(s, date, lk, warnings); lk.forEach(l => { const w = (l.end - l.start) - (l.breaks || []).reduce((a, b) => a + b.end - b.start, 0); sum.lockedMinutes += w; lockedBy[date] = (lockedBy[date] || 0) + w; }); return; }
        if (!c) { sum.missingDays++; warnings.push({ date, staffId: s.id, type: 'empFixedMissing', msg: '社員の確定シフトにこの日の記載がありません（入れていません）' }); return; }
        if (c.kind === 'off') { sum.offDays++; return; }
        if (c.kind === 'away') { sum.awayDays++; return; }
        if (c.conflict) warnings.push({ date, staffId: s.id, type: 'empConflict', msg: `勤務条件では「${c.conflict}」ですが、確定シフトでは勤務です（確定シフトのとおり入れています。どちらが正しいか確認してください）` });
        if (c.half) sum.halfDays++;
        const mm = mOf(c, date);
        // 「勤務」とだけ書かれた日（時刻なし）で、勤務条件に勤務できる範囲がある：範囲の中で出勤・退勤を自動で決める
        if (c.range && c.range.end > c.range.start && !(c.start != null && c.end > c.start)) {
          const f = flexDay(s, mm, date, c.range.start, c.range.end, c.half || null, warnings, c.start != null ? c.start : null);
          if (!f) { sum.unknownTimeDays++; return; }
          Object.assign(f, { mm, w: weightOf(date, f.lo, f.hi), h: tieHash(date + '|' + tieIdOf(ctx, s.id)) });
          flexList.push(f); total += workAt(f, f.end - f.start); n++; sum.autoTimeDays++;
          return;
        }
        if (!(c.start != null && c.end > c.start)) { sum.unknownTimeDays++; unknownDates.push(date); warnings.push({ date, staffId: s.id, type: 'empTimeUnknown', msg: '社員の確定シフト（勤務）ですが、勤務時間（固定の時間・勤務できる範囲）が勤務条件に登録されていないため、時間を推測せず入れていません（要確認）' }); return; }
        c = prepTimes(s, date, c, warnings);
        // 休憩：その日だけの設定 → 社員の休憩時間（6時間を超える日だけ。未設定は基本の120分）→ 法定（法定より短い値は法定に合わせる）
        const len = c.end - c.start, br = empBreak(ctx, mm, len, date);
        (byDate[date] = byDate[date] || []).push(Object.assign({ staffId: s.id, start: c.start, end: c.end, breakMin: br, src: 'confirmed' }, c.prep ? { prep: true } : {}));
        fixedList.push({ date, start: c.start, end: c.end, mm });
        total += len - br; n++;
      });
      // 時間が分からない勤務日のまとめ（曜日ごと）：どの曜日の勤務できる時間が勤務条件に無いかを1行で知らせる
      if (unknownDates.length) {
        const DJ = '日月火水木金土', dws = [...new Set(unknownDates.map(dowOf))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
        warnings.push({ date: null, staffId: s.id, type: 'empTimeUnknownDows', msg: `${mk}：確定シフトで勤務の ${unknownDates.length}日（${dws.map(w => DJ[w]).join('・')}曜）は、勤務条件にその曜日の勤務できる時間（開始・終了）が保存されていないため、入れていません（画面に入力しただけで保存していない内容は使われません。社員の勤務条件で保存してください）` });
      }
      const pol = ovT ? Object.assign({}, otPolicy(s), { allow: Math.max(0, ovT.allow || 0) }) : otPolicy(s), need = target == null ? null : Math.max(0, target - sum.lockedMinutes), cap = need == null ? null : need + pol.allow;
      if (flexList.length) {
        if (need != null) total = shortenFlex(flexList, total, need, cap, workAt);
        total = legalFlex(fixedList.concat(flexList), total, lockedBy, workAt);
        flexList.forEach(z => (byDate[z.date] = byDate[z.date] || []).push(Object.assign({ staffId: s.id, start: z.start, end: z.end, breakMin: empBreak(ctx, z.mm, z.end - z.start, z.date), src: 'confirmed', autoTime: true, flex: true, lo: z.lo, hi: z.hi, pin: z.pin }, z.prep ? { prep: true } : {})));
      }
      otNote(s, mk, need == null ? null : need + (ovT ? pol.allow : allowIn(pol.allow, inMonth.length, mk)), total, fixedList.concat(flexList), lockedBy, workAt);
      sum.plannedMinutes = total + sum.lockedMinutes;
      sum.workDays = n;
      Object.assign(sum, { rank: pol.rank, allowMinutes: pol.allow, allowUnset: pol.unset, capMinutes: target == null ? null : target + pol.allow });
      summary.push(sum);
    }
  }

  function planDay(ctx, date, acc) {
    const inp = ctx.input, opt = ctx.opt, dow = dowOf(date);
    const dem = dayDemand(ctx, date);
    const warnings = dem.warnings.slice();
    const shifts = [], placed = new Set();
    const offs = s => ((inp.offs || {})[s.id] || []).includes(date);
    const workOfLen = len => len - breakMinutes(ctx, len);
    // 1) 既存の確定シフト：そのまま（上書きしない）
    (inp.locked || []).filter(l => l.date === date).forEach(l => {
      shifts.push({ staffId: l.staffId, date, start: l.start, end: l.end, pos: l.pos || '', source: 'locked', lock: l.posFree ? null : lockOf(l.pos), posFree: !!l.posFree, breaks: (l.breaks || []).slice() });   // posFree：ポジションが自動の代表の表示（担当を固定しない）
      placed.add(l.staffId);
    });
    // 2a) 社員（月ごとの所定労働時間で決めた勤務日・時間）。月の設定がある社員は、ほかの方法では入れない
    const flexEmp = [];
    ((ctx.emp && ctx.emp.byDate[date]) || []).forEach(e => {
      if (placed.has(e.staffId)) return;
      const se = ctx.staffById.get(e.staffId);
      if (se && hitsBusy(ctx, se, date, e.flex ? e.lo : e.start, e.flex ? e.hi : e.end)) { warnings.push({ date, staffId: e.staffId, type: 'linkedBusy', msg: '同じ人のもう一方の店舗の登録で、同じ時間に勤務があるため入れていません（同じ時間に両店舗には配置しない）' }); placed.add(e.staffId); return; }
      const sh = Object.assign({ staffId: e.staffId, date, start: e.start, end: e.end, source: e.src || 'employee', breaks: [], breakMin: e.breakMin }, e.prep ? { prep: true } : {}, e.autoTime ? { autoTime: true } : {});
      if (e.flex) { sh.flex = { lo: e.lo, hi: e.hi, pin: e.pin }; flexEmp.push(sh); }
      shifts.push(sh);
      placed.add(e.staffId);
    });
    ctx.staff.forEach(s => { if (isEmpDay(s, date)) placed.add(s.id); });
    // 範囲内で自動決定する社員：決めた長さのまま、不足が最も少なくなる時間に置く（30分単位。範囲の狭い人から。同じなら早い時間）
    //   この時点ではパート・アルバイトを入れていないため、社員で埋められる時間を先に埋める
    if (flexEmp.length && !dem.closed && dem.active.length) {
      flexEmp.slice().sort((a, b) => (a.flex.hi - a.flex.lo) - (b.flex.hi - b.flex.lo) || tieHash(date + '|' + tieIdOf(ctx, a.staffId)) - tieHash(date + '|' + tieIdOf(ctx, b.staffId))).forEach(sh => {
        if (sh.flex.pin != null) return;   // 開始が決まっている（朝の準備担当・Excel の開始時刻）
        const len = sh.end - sh.start; let best = null;
        const fits = st => !(sh.breakMin > 0) || empBreakSlots(ctx, st, st + len, sh.breakMin).length > 0;   // 休憩を時間帯（14:00〜17:00）に置ける時間だけ
        const anyFit = (() => { for (let st = ceilStep(sh.flex.lo); st + len <= sh.flex.hi; st += EMP_STEP) if (fits(st)) return true; return false; })();
        for (let st = ceilStep(sh.flex.lo); st + len <= sh.flex.hi; st += EMP_STEP) {
          if (anyFit && !fits(st)) continue;
          sh.start = st; sh.end = st + len;
          const c = evaluateDay(ctx, date, shifts, dem).cost;
          if (!best || c < best.c) best = { st, c };
        }
        if (best) { sh.start = best.st; sh.end = best.st + len; }
      });
    }
    // 2) 固定シフト（契約上の勤務）。希望休・休業日は入れずに警告。契約上限を超える場合も入れて警告
    ctx.staff.forEach(s => {
      const f = s.fixed && s.fixed[dow];
      if (!f || placed.has(s.id)) return;
      if (offs(s)) { warnings.push({ date, staffId: s.id, type: 'fixedOff', msg: '固定シフトの曜日ですが希望休のため入れていません' }); return; }
      if (dem.closed) { warnings.push({ date, staffId: s.id, type: 'fixedClosed', msg: '休業日のため固定シフトを入れていません' }); return; }
      if (hitsBusy(ctx, s, date, f.start, f.end)) { warnings.push({ date, staffId: s.id, type: 'linkedBusy', msg: '同じ人のもう一方の店舗の登録で、同じ時間に勤務があるため固定シフトを入れていません' }); return; }
      const why = contractProblem(ctx, acc, s, date, workOfLen(f.end - f.start));
      if (why) warnings.push({ date, staffId: s.id, type: 'fixedContract', msg: `固定シフトが契約条件（${why}）を超えます` });
      shifts.push({ staffId: s.id, date, start: f.start, end: f.end, source: 'fixed', breaks: [] });
      placed.add(s.id);
    });
    if (dem.closed) {
      // 休業日でも、社員の確定シフト（取り込み）は変えずに入れる（休憩は真ん中に）。休業日に勤務がある旨を警告
      shifts.filter(sh => sh.source === 'confirmed' || sh.source === 'employee').forEach(sh => {
        const bm = sh.breakMin != null ? sh.breakMin : breakMinutes(ctx, sh.end - sh.start);
        const sl = empBreakSlots(ctx, sh.start, sh.end, bm);   // 社員の休憩の時間帯（14:00〜17:00）の最初に置ける時刻。置けなければ入れない（要調整）
        if (bm > 0 && !(sh.breaks || []).length && sl.length) sh.breaks = [{ start: sl[0], end: sl[0] + bm }];
        if (sh.source === 'confirmed') warnings.push({ date, staffId: sh.staffId, type: 'empClosedDay', msg: dem.temporary ? '臨時休業日に社員の確定シフトがあります（変更せずに入れています）' : '休業日（営業時間の設定）に社員の確定シフトがあります（変更せずに入れています）' });
      });
      empBreakIssues(ctx, date, shifts.filter(sh => sh.source === 'confirmed' || sh.source === 'employee'), shifts, dem, false).forEach(w => warnings.push(w));
      return { shifts, warnings, unplaced: [], ev: evaluateDay(ctx, date, shifts, dem) };
    }
    if (opt.fillAllRequests) ctx.staff.forEach(s => {
      if (placed.has(s.id)) return;
      const w = windowsFor(ctx, s, date).find(x => x.src === 'request');
      if (w && !contractProblem(ctx, acc, s, date, workOfLen(w.end - w.start))) { shifts.push({ staffId: s.id, date, start: w.start, end: w.end, source: 'request', keep: true, breaks: [] }); placed.add(s.id); }
    });

    let evCache = evaluateDay(ctx, date, shifts, dem);
    const gainOf = cand => { // 追加で減る不足（時間帯の枠＋1日の基本人数）
      let g = 0;
      for (const sl of evCache.slots) {
        if (sl.t < cand.start || sl.t + SLOT > cand.end) continue;
        if (sl.tot && sl.tot.have < sl.tot.need) g += 1;   // 店舗全体の人数：1人増える
        if (!sl.units.length) continue;
        const r = assignSlot(ctx, sl.units, presentAt(ctx, shifts.concat([cand]), sl.t), null);
        const counts = (u, i) => !(u.kind === 'main' && evCache.tolSet.has(u.id + '|' + sl.t));
        g += sl.units.reduce((n, u, i) => n + (counts(u, i) && r.pick[i] != null ? 1 : 0) - (counts(u, i) && sl.pick[i] != null ? 1 : 0), 0);
      }
      if (evCache.daily.short > 0) g += (evCache.daily.short - dailyMatch(ctx, dem.daily, shifts.concat([cand])).short) * DAILY_W;
      return g;
    };
    // 同点のとき a を b より先にするか：期間中の勤務日数が少ない人 → 日付ごとに入れ替わる順
    const daysOf = id => (acc.days.get(id) || new Set()).size;
    const tieBefore = (a, b) => {
      const da = daysOf(a), db = daysOf(b);
      if (da !== db) return da < db;
      return tieHash(date + '|' + tieIdOf(ctx, a)) < tieHash(date + '|' + tieIdOf(ctx, b));
    };
    // 不足を埋める（効果の大きい人・時間帯から1人ずつ。必要以上には入れない）
    const greedy = () => {
      for (let iter = 0; iter < 80; iter++) {
        if (evCache.cost === 0) return;
        const shortSlots = evCache.slots.filter(sl => sl.pick.some(x => x == null) || (sl.tot && sl.tot.have < sl.tot.need)).map(sl => sl.t);
        const dailyShortPos = evCache.daily.detail.filter(d => d.have < d.need).map(d => d.pos);
        let best = null;
        ctx.staff.forEach(s => {
          if (placed.has(s.id)) return;
          const cando = evCache.slots.some(sl => (sl.pick.some(x => x == null) && sl.units.some(u => eligible(ctx, s, u))) || (sl.tot && sl.tot.have < sl.tot.need)) || dailyShortPos.some(p => s.positions.includes(p));
          if (!cando) return;
          windowsFor(ctx, s, date).forEach(w => {
            const ws = Math.max(w.start, opt.dayStart), we = Math.min(w.end, opt.dayEnd);
            if (we - ws < SLOT) return;
            const minLen = Math.min(opt.minShift, we - ws);
            const starts = new Set([ws]);
            shortSlots.forEach(t => { if (t >= ws && t < we) starts.add(Math.max(ws, Math.min(t, we - minLen))); });
            const pv = inp.prefer && inp.prefer[s.id + '|' + date];   // 再調整：今の配置（同じくらい良ければ変えない）
            if (pv && pv.start >= ws && pv.start < we) starts.add(pv.start);
            starts.forEach(st => {
              const ends = new Set([Math.min(we, st + opt.maxShift), Math.min(we, st + minLen)]);
              if (pv && pv.end > st && pv.end <= we) ends.add(pv.end);
              shortSlots.forEach(t => { const e = t + SLOT; if (e - st >= minLen && e - st <= opt.maxShift && e <= we) ends.add(e); });
              ends.forEach(en => {
                const len = en - st;
                if (len < minLen) return;
                if (contractProblem(ctx, acc, s, date, workOfLen(len))) return; // 契約条件を超える案は作らない
                const cand = { staffId: s.id, date, start: st, end: en, source: w.src, breaks: [] };
                const gain = gainOf(cand);
                if (gain <= 0) return;
                const target = (s.targetHours || 0) * 60, used = acc.mins.get(s.id) || 0;
                const over = target > 0 ? Math.max(0, used + len - target) : 0;
                // 評価：埋まる量（必要な業務・ポジション）→ 優先度 → 無駄な時間が少ない → 目標時間の超過が少ない
                //       → これまでの勤務が少ない人（公平性）。同点なら勤務日数が少ない人 → 日付ごとに入れ替わる順
                const keepPv = pv ? (st === pv.start && en === pv.end ? 30 : Math.max(0, Math.min(en, pv.end) - Math.max(st, pv.start)) / SLOT) : 0;   // 今の配置に近いほど少し優先（不足の解消・優先度より小さい）
                const score = gain * 1000 + PRIORITY_W[s.priority] - (len / SLOT - Math.min(gain, len / SLOT)) * 20 - over / SLOT * 50 - (target > 0 ? used / target : used / 6000) * 150 + (w.src === 'request' ? 5 : 0) + keepPv;
                if (!best || score > best.score || (score === best.score && best.cand.staffId !== s.id && tieBefore(s.id, best.cand.staffId))) best = { cand, score };
              });
            });
          });
        });
        if (!best) return;
        shifts.push(best.cand); placed.add(best.cand.staffId);
        evCache = evaluateDay(ctx, date, shifts, dem);
      }
    };
    // 不足に関係しない前後を短くする（必要以上の人員配置を抑える。最短時間は守る）
    const trim = () => {
      shifts.filter(sh => (sh.source === 'request' || sh.source === 'auto') && !sh.keep && !(sh.breaks || []).length).forEach(sh => {
        const base = evaluateDay(ctx, date, shifts, dem).cost;
        const tryCut = (field, delta) => {
          for (;;) {
            if (sh.end - sh.start - SLOT < Math.min(opt.minShift, sh.end - sh.start)) return;
            sh[field] += delta;
            if (evaluateDay(ctx, date, shifts, dem).cost > base) { sh[field] -= delta; return; }
          }
        };
        tryCut('start', SLOT); tryCut('end', -SLOT);
      });
      evCache = evaluateDay(ctx, date, shifts, dem);
    };
    // 休憩：法定の長さを、不足が増えない（なるべく真ん中の）時間に入れる（パート・アルバイト等）
    //   社員（店長を含む）：基本120分（社員ごと・日ごとに変更可）を、14:00〜17:00 の間に連続で（分けずに）取る。平日・土日祝とも同じ。30分単位
    //         選び方：必要人数・業務の担当の不足が少ない → （不足が同じなら）ほかの社員の休憩と重ならない → 営業の中休みにかかる → 早い時刻
    //         社員同士の休憩が重なるのはよい（必要人数・必要な業務の担当が確保できていれば要調整にしない）
    //         時間帯の中に置けないときは、分割・短縮・時間帯の外への移動をせず、休憩を入れずに「要調整」を知らせる（empBreakIssues）
    const gaps = (() => { const ps = periodsOf(hoursOn(inp, date)).slice().sort((a, b) => a.start - b.start), out = [];
      for (let i = 1; i < ps.length; i++) if (ps[i].start > ps[i - 1].end) out.push({ start: ps[i - 1].end, end: ps[i].start }); return out; })();
    const isEmpShift = sh => sh.source === 'employee' || sh.source === 'confirmed';
    const gapOverlap = (b, bm) => gaps.reduce((n, g) => n + Math.max(0, Math.min(b + bm, g.end) - Math.max(b, g.start)), 0);
    const placeBreaks = (reopt) => {
      shifts.filter(sh => sh.source !== 'locked' && (reopt ? (sh.breaks || []).length : !(sh.breaks || []).length)).forEach(sh => {
        const bm = sh.breakMin != null ? sh.breakMin : breakMinutes(ctx, sh.end - sh.start);   // 社員は設定の休憩時間
        if (!bm) return;
        if (isEmpShift(sh)) {
          const slots = empBreakSlots(ctx, sh.start, sh.end, bm);
          if (!slots.length) { sh.breaks = []; return; }   // 要調整（入れない）
          const others = shifts.filter(x => x !== sh && isEmpShift(x));
          let best = null;
          for (const b of slots) {
            sh.breaks = [{ start: b, end: b + bm }];
            const ov = others.reduce((n, x) => n + (x.breaks || []).reduce((m, y) => m + Math.max(0, Math.min(b + bm, y.end) - Math.max(b, y.start)), 0), 0);
            const sc = evaluateDay(ctx, date, shifts, dem).cost * 1e6 + ov * 1000 - gapOverlap(b, bm) * 2 + (b - slots[0]) / EMP_STEP;
            if (!best || sc < best.sc) best = { b, sc };
          }
          sh.breaks = [{ start: best.b, end: best.b + bm }];
          return;
        }
        const step = sh.flex ? EMP_STEP : SLOT;
        const mid = (sh.start + sh.end - bm) / 2;
        let best = null;
        for (let b = sh.start + 120; b + bm <= sh.end - 60; b += step) {
          sh.breaks = [{ start: b, end: b + bm }];
          const sc = evaluateDay(ctx, date, shifts, dem).cost * 1000 + Math.abs(b - mid);
          if (!best || sc < best.sc) best = { b, sc };
        }
        if (!best) best = { b: Math.round(mid / step) * step };
        sh.breaks = [{ start: best.b, end: best.b + bm }];
      });
      evCache = evaluateDay(ctx, date, shifts, dem);
    };
    // 社員の延長（残業）：パート・アルバイトで埋まらない不足があるときだけ、範囲内で自動決定する社員の勤務を30分ずつ延ばす（必要最小限）
    //   条件：勤務できる範囲の中・月の上限（所定＋残業許容。店長以上は所定まで）・法定の時間
    //         1日8時間を超えるのは、36協定の1日の延長の上限（law36.dayMinutes）が設定されていて、その範囲内のときだけ
    //         週40時間を超えるのは、36協定の月の上限（law36.monthMinutes）が設定されていて、その月の法定時間外が上限以内のときだけ
    const otExtend = () => {
      if (!flexEmp.length || evCache.cost <= 0 || !ctx.emp || !ctx.emp.ot) return;
      const O = ctx.emp.ot, law = inp.law36 && inp.law36.monthMinutes > 0 ? inp.law36.monthMinutes : null, mk = monthOf(date), wkKey = sunKey(date);
      const lawDay = law != null && inp.law36.dayMinutes > 0 ? inp.law36.dayMinutes : null;
      const blocked = new Map();
      for (let it = 0; it < 48 && evCache.cost > 0; it++) {
        let best = null;
        flexEmp.forEach(sh => {
          const s = ctx.staffById.get(sh.staffId); if (!s) return;
          [['start', -EMP_STEP], ['end', EMP_STEP]].forEach(([f, d]) => {
            if (f === 'start' && sh.flex.pin != null) return;
            const ns = f === 'start' ? sh.start + d : sh.start, ne = f === 'end' ? sh.end + d : sh.end;
            if (ns < sh.flex.lo || ne > sh.flex.hi) return;
            sh[f] += d; const ev = evaluateDay(ctx, date, shifts, dem); sh[f] -= d;
            const gain = evCache.cost - ev.cost; if (gain <= 0) return;
            const b = breaksOf(sh), ow = sh.end - sh.start - b, nw = ne - ns - b;
            const k = s.id + '|' + mk, wk = s.id + '|' + wkKey, used = acc.ot.get(k) || 0;
            let why = null;
            if (breakMinutes(ctx, ne - ns) > b) why = '休憩が法定に足りなくなる';
            else if (used + (nw - ow) > (O.budget[k] || 0)) why = s.contract && s.contract.rank === 'manager' ? '店長以上は予定残業0時間（所定時間まで）の' : '月の上限（所定＋残業許容）に達している';
            else {
              const W = (O.week[wk] || 0) + (acc.xw.get(wk) || 0);
              const dayAdd = Math.max(0, nw - LEGAL_DAY) - Math.max(0, ow - LEGAL_DAY);
              const weekAdd = Math.max(0, W + Math.min(nw, LEGAL_DAY) - Math.min(ow, LEGAL_DAY) - LEGAL_WEEK) - Math.max(0, W - LEGAL_WEEK), legalAdd = dayAdd + weekAdd;
              if (dayAdd > 0 && lawDay == null) why = law == null ? '1日8時間を超える（36協定の上限が未設定）' : '1日8時間を超える（36協定の1日の延長の上限が未設定）';
              else if (dayAdd > 0 && nw - LEGAL_DAY > lawDay) why = '36協定の1日の延長の上限を超える';
              else if (weekAdd > 0 && law == null) why = '週40時間を超える（36協定の上限が未設定）';
              else if (legalAdd > 0 && (O.legal[k] || 0) + (acc.lo.get(k) || 0) + legalAdd > law) why = '36協定の月の上限（法定時間外）を超える';
              else if (!best || gain > best.gain) best = { sh, f, d, ev, gain, k, wk, dw: nw - ow, dWeek: Math.min(nw, LEGAL_DAY) - Math.min(ow, LEGAL_DAY), legalAdd };
            }
            if (why && !blocked.has(sh.staffId)) blocked.set(sh.staffId, why);
          });
        });
        if (!best) break;
        best.sh[best.f] += best.d; evCache = best.ev;
        best.sh.otMinutes = (best.sh.otMinutes || 0) + best.dw;
        acc.ot.set(best.k, (acc.ot.get(best.k) || 0) + best.dw);
        acc.xw.set(best.wk, (acc.xw.get(best.wk) || 0) + best.dWeek);
        if (best.legalAdd > 0) acc.lo.set(best.k, (acc.lo.get(best.k) || 0) + best.legalAdd);
        blocked.delete(best.sh.staffId);
      }
      // 延ばした勤務の休憩を置き直す（中休みにかかるようになった勤務など）
      const ext = flexEmp.filter(sh => sh.otMinutes);
      if (ext.length) { ext.forEach(sh => { sh.breaks = []; }); placeBreaks(false); }   // 休憩の無い勤務だけを置き直す
      flexEmp.forEach(sh => { if (sh.otMinutes) warnings.push({ date, staffId: sh.staffId, type: 'empOtExtend', msg: `不足を補うため、勤務を ${fmtH(sh.otMinutes)} 延長しました（${fmt(sh.start)}〜${fmt(sh.end)}。パート・アルバイトで埋まらない時間だけ。月の上限・法定の範囲内）` }); });
      if (evCache.cost > 0) blocked.forEach((why, id) => warnings.push({ date, staffId: id, type: 'empOtLimit', msg: `不足がありますが、${why}ため、この社員の勤務は延長していません` }));
    };
    // 休憩などで生じた穴：入っている人のシフトを、勤務可能時間・最長時間・休憩・契約の範囲で延ばす
    const extend = () => {
      let improved = true;
      while (improved && evCache.cost > 0) {
        improved = false;
        for (const sh of shifts) {
          if (!(sh.source === 'request' || sh.source === 'auto') || sh.keep) continue;
          const s = ctx.staffById.get(sh.staffId);
          const ws = windowsFor(ctx, s, date).filter(w => w.start <= sh.start && w.end >= sh.end)[0];
          if (!ws) continue;
          for (const [field, delta] of [['end', SLOT], ['start', -SLOT]]) {
            const ns = field === 'start' ? sh.start + delta : sh.start, ne = field === 'end' ? sh.end + delta : sh.end;
            if (ns < Math.max(ws.start, opt.dayStart) || ne > Math.min(ws.end, opt.dayEnd) || ne - ns > opt.maxShift) continue;
            if (breakMinutes(ctx, ne - ns) > breaksOf(sh)) continue;
            if (contractProblem(ctx, acc, s, date, (ne - ns) - breaksOf(sh))) continue;
            const before = evCache.cost;
            sh[field] += delta;
            const ev = evaluateDay(ctx, date, shifts, dem);
            if (ev.cost < before) { evCache = ev; improved = true; } else sh[field] -= delta;
          }
        }
      }
    };
    greedy(); trim(); placeBreaks();
    if (evCache.cost > 0) { extend(); greedy(); trim(); placeBreaks(); }
    if (evCache.cost > 0) placeBreaks(true);
    otExtend();
    empBreakIssues(ctx, date, shifts.filter(isEmpShift), shifts, dem, false).forEach(w => warnings.push(w));
    shifts.forEach(sh => {
      if (sh.source === 'locked') return;
      const work = (sh.end - sh.start) - breaksOf(sh), wk = sh.staffId + '|' + weekKey(date);
      acc.mins.set(sh.staffId, (acc.mins.get(sh.staffId) || 0) + work);
      acc.week.set(wk, (acc.week.get(wk) || 0) + work);
    });
    shifts.forEach(sh => { if (!acc.days.has(sh.staffId)) acc.days.set(sh.staffId, new Set()); acc.days.get(sh.staffId).add(date); });
    const unplaced = [];
    ctx.staff.forEach(s => {
      if (placed.has(s.id)) return;
      windowsFor(ctx, s, date).filter(w => w.src === 'request').forEach(w => unplaced.push({ staffId: s.id, date, start: w.start, end: w.end }));
    });
    return { shifts, warnings, unplaced, ev: evCache };
  }

  function posLabelOf(ctx, duties, staffId, fallback) {
    const mine = {};
    duties.filter(x => x.staffId === staffId && x.kind !== 'main').forEach(x => {
      const name = x.kind === 'skill' ? (ctx.skillName[x.skill] || x.skill) : x.pos;
      mine[name] = (mine[name] || 0) + (x.end - x.start) * (x.kind === 'pos' ? 1.01 : 1);
    });
    return Object.keys(mine).sort((a, b) => mine[b] - mine[a])[0] || fallback || '';
  }

  // メイン：期間のシフト案を作成
  // 月単位の作成を「何日分かずつ」に分けて進められる形（サーバーの1回あたりの計算時間の上限に対応）。
  // 途中の状態（state）は JSON にできる値だけで、保存・再開しても一度に計算した結果と同じになる。
  function planStart(input) {
    const ctx = prepare(input);
    const out = { shifts: [], duties: [], violations: [], warnings: [], unplacedRequests: [] };
    // 希望（勤務可能時間）の未提出者：勤務可能とはみなさず警告
    ctx.staff.forEach(s => {
      const hasReq = (input.dates || []).some(d => (((input.requests || {})[s.id] || {})[d] || []).length);
      const hasAvail = Object.keys(((input.availability || {})[s.id]) || {}).length > 0;
      const empAll = (input.dates || []).length > 0 && (input.dates || []).every(d => isEmpDay(s, d));
      if (!hasReq && !hasAvail && !empAll && !ctx.opt.unrequestedAvailable) out.warnings.push({ date: null, staffId: s.id, type: 'noRequest', msg: '期間中の希望（勤務可能時間）が未提出です。勤務可能とはみなしていません' + (Object.keys(s.fixed || {}).length ? '（固定シフトは反映）' : '') });
    });
    const emp = planEmployees(ctx);
    out.warnings.push(...emp.warnings);
    out.warnings.push(...gridNotices(input));
    out.coverage = [];
    return { i: 0, acc: accToJSON(newAcc(ctx)), out, emp };
  }
  const accToJSON = acc => ({ mins: [...acc.mins], week: [...acc.week], days: [...acc.days].map(([k, set]) => [k, [...set]]), ot: [...(acc.ot || [])], xw: [...(acc.xw || [])], lo: [...(acc.lo || [])] });
  const accFromJSON = j => ({ mins: new Map(j.mins), week: new Map(j.week), days: new Map(j.days.map(([k, ds]) => [k, new Set(ds)])), ot: new Map(j.ot || []), xw: new Map(j.xw || []), lo: new Map(j.lo || []) });
  // opts.maxDays：今回進める日数／opts.until（Date.now() の値）：この時刻を過ぎたら次の日に進まない
  function planContinue(input, state, opts = {}, ctxIn) {
    const ctx = ctxIn || prepare(input);
    ctx.emp = state.emp || null;
    const acc = accFromJSON(state.acc), out = state.out, dates = input.dates || [];
    if (!out.coverage) out.coverage = [];
    let i = state.i, n = 0;
    while (i < dates.length && (opts.maxDays == null || n < opts.maxDays) && (opts.until == null || n === 0 || Date.now() < opts.until)) {
      const date = dates[i];
      const d = planDay(ctx, date, acc);
      const duties = dutiesOf(date, d.ev);
      d.shifts.forEach(sh => {
        if (sh.source !== 'locked') sh.pos = posLabelOf(ctx, duties, sh.staffId, (ctx.staffById.get(sh.staffId) || {}).role);
        const { lock, keep, flex, ...rest } = sh;
        out.shifts.push(rest);
      });
      out.duties.push(...duties);
      const vio = violationsOf(date, d.ev);
      out.violations.push(...vio);
      out.warnings.push(...d.warnings);
      // 朝の準備担当（この店舗の担当）が誰も 8:30 に勤務しない日で、8:30 の時間帯が人数不足 → 警告（休み・他店舗の日。人は推測で足さない）
      const preps = ctx.staff.filter(s => s.morningPrep && s.prepHome);
      if (preps.length && !d.shifts.some(sh => preps.some(p => p.id === sh.staffId) && sh.start <= PREP_START && sh.end > PREP_START)) {
        const short = vio.filter(v => v.start != null && v.start <= PREP_START && v.end > PREP_START);
        if (short.length) out.warnings.push({ date, staffId: null, type: 'prepAbsentShort', msg: `朝の準備担当（${preps.map(p => p.name).join('・')}）がこの日は 8:30 から勤務しないため（休み・他店舗など）、8:30 の時間帯の人数が不足しています（${short.map(v => (v.label || v.pos || '') + ' ' + v.have + '/' + v.need + '人').join('・')}）` });
      }
      out.unplacedRequests.push(...d.unplaced);
      out.coverage.push(coverageOf(ctx, date, d.ev, d.shifts));
      (out.leaderGaps = out.leaderGaps || []).push(...leaderGapsOf(ctx, date, d.ev, d.shifts));
      i++; n++;
    }
    const next = { i, acc: accToJSON(acc), out, emp: state.emp || null };
    return { done: i >= dates.length, state: next, result: i >= dates.length ? planFinish(input, next, ctx) : null };
  }
  function planFinish(input, state, ctxIn) {
    const ctx = ctxIn || prepare(input);
    const out = Object.assign({}, state.out);
    out.employees = employeeResults(ctx, out, state.emp);
    out.employees.forEach(e => {
      empWarnings(input, e, out, '（固定休・希望休・有給は変更していません）');
      if (e.paidDays) out.warnings.push({ date: null, staffId: e.staffId, type: 'empPaid', msg: `${e.month}：有給 ${e.paidDays}日は、所定時間の達成判定に含めていません（会社の運用ルールが未設定）` });
      if (e.partial) out.warnings.push({ date: null, staffId: e.staffId, type: 'empPartial', msg: `${e.month}：作成期間が月の一部のため、所定時間を日数で按分しています（月全体で作成すると正確に合わせられます）` });
    });
    legalWarnings(ctx, out);
    out.stats = summarize(ctx, out);
    return out;
  }
  function plan(input) {
    const ctx = prepare(input);
    return planContinue(input, planStart(input), {}, ctx).result;
  }

  // 時間帯責任者の不在：日付・時間帯・継続時間・許容内か・理由
  function leaderGapsOf(ctx, date, ev, dayShifts) {
    return (ev.mainRuns || []).map(run => {
      const r = { date, start: run.start, end: run.end, minutes: run.end - run.start, label: run.label, ruleId: run.id, toleranceMinutes: run.tol, tolerated: run.tolerated };
      const cert = ctx.staff.filter(s => s.canMain);
      const onBreak = dayShifts.filter(sh => { const s = ctx.staffById.get(sh.staffId); return s && s.canMain && sh.start <= run.start && sh.end >= run.end && (sh.breaks || []).some(b => b.start < run.end && b.end > run.start); });
      const working = dayShifts.filter(sh => cert.some(s => s.id === sh.staffId));
      const avail = cert.filter(s => !working.some(sh => sh.staffId === s.id) && windowsFor(ctx, s, date).some(w => w.start < run.end && w.end > run.start));
      if (onBreak.length) Object.assign(r, { reason: 'break', reasonText: onBreak.map(sh => ctx.staffById.get(sh.staffId).name).join('・') + 'の休憩中' });
      else if (!cert.length) Object.assign(r, { reason: 'noCertified', reasonText: '責任者に認定された人がいない' });
      else if (run.tolerated && avail.length) Object.assign(r, { reason: 'cost', reasonText: '許容時間内のため、責任者のためだけに人を追加・延長していない' });
      else if (!avail.length && !working.length) Object.assign(r, { reason: 'notAvailable', reasonText: 'この時間に勤務できる認定者がいない（休み・希望の時間外）' });
      else if (!avail.length) Object.assign(r, { reason: 'outside', reasonText: '認定者はこの前後に勤務（この時間は勤務時間外。休み・希望の時間は変えていない）' });
      else Object.assign(r, { reason: 'limit', reasonText: '勤務できる認定者はいるが、勤務条件（上限時間・連続勤務など）や必要人数との兼ね合いで入れていない' });
      return r;
    });
  }
  // 社員の休憩の確認（作成・再評価で共通）：基本のルール（14:00〜17:00 に連続で基本の長さ）を満たさない勤務を「要調整」として知らせる
  //   要調整：連続の休憩を置けない・休憩中に必要人数／必要な業務の担当が不足する（再評価では、分割・短い・時間帯の外も）
  //   社員同士の休憩の重なりだけでは要調整にしない
  //   empShifts：確認する社員の勤務（bm＝その日の休憩の長さ。作成時は breakMin、再評価では勤務条件から）、all：その日の全員の勤務（不足の判定用）
  function empBreakIssues(ctx, date, empShifts, all, dem, manual) {
    const W = ctx.opt.empBreakWindow, out = [];
    empShifts.forEach(sh => {
      const s = ctx.staffById.get(sh.staffId) || {}, len = sh.end - sh.start;
      const m = s.monthly ? empSettings(s, monthOf(date)) : null;
      const bm = sh.breakMin != null ? sh.breakMin : empBreak(ctx, m, len, date);
      if (!(bm > 0)) return;
      const br = (sh.breaks || []).slice().sort((a, b) => a.start - b.start), tot = br.reduce((n, b) => n + b.end - b.start, 0), why = [];
      if (!br.length) why.push(manual ? `休憩が入っていません（基本 ${bm}分）` : `勤務 ${fmt(sh.start)}〜${fmt(sh.end)} の中で、${fmt(W.start)}〜${fmt(W.end)} に連続 ${bm}分の休憩を取れません`);
      else {
        if (br.length > 1) why.push(`休憩が${br.length}回に分かれています`);
        if (tot < bm) why.push(`休憩が ${tot}分です（基本 ${bm}分）`);
        if (br.some(b => b.start < W.start || b.end > W.end)) why.push(`休憩が ${fmt(W.start)}〜${fmt(W.end)} の外にあります`);
        // 休憩中に必要人数・業務の担当が不足する（休憩が無い場合より不足が増える）
        const keep = sh.breaks; sh.breaks = [];
        const none = evaluateDay(ctx, date, all, dem).cost; sh.breaks = keep;
        if (evaluateDay(ctx, date, all, dem).cost > none) why.push('休憩中に必要人数・必要な業務の担当（レジ・キッチンなど）が不足します');
      }
      if (why.length) out.push({ date, staffId: sh.staffId, type: 'breakAdjust', msg: `休憩は要調整：${why.join('・')}${manual ? '（現在のシフト表）' : '（自動では休憩を分けたり短くしたり、時間帯の外に動かしたりしていません。シフト表で直してください）'}` });
    });
    return out;
  }
  const fmtH = m => { const h = Math.floor(Math.abs(m) / 60), mm = Math.abs(m) % 60; return h + '時間' + (mm ? mm + '分' : ''); };
  // 社員ごとの所定時間・実働（休憩を除く）・差（＋超過／−不足）
  function employeeResults(ctx, out, emp) {
    if (!emp) return [];
    return emp.summary.map(sm => {
      const own = out.shifts.filter(sh => sh.staffId === sm.staffId && monthOf(sh.date) === sm.month);
      const st = ctx.staffById.get(sm.staffId), m = st && empSettings(st, sm.month);
      // 休憩の記録がないシフト（公開済みシフトの再読み込みなど。休憩はまだDBに保存されない）は、設定の休憩時間（法定以上）を差し引く
      let assumed = 0;
      const actual = own.reduce((n, sh) => {
        const len = sh.end - sh.start, rec = breaksOf(sh);
        if (rec > 0) return n + len - rec;
        const b = (m || sm.confirmed) ? empBreak(ctx, m, len, sh.date) : 0; if (b > 0) assumed++;   // 社員の休憩（未設定は基本の120分。法定以上）
        return n + len - b;
      }, 0);
      // 法定時間外（通常の労働時間制度：1日8時間・週40時間を超える分。週は日曜始まり。作成期間の中だけで計算。変形労働時間制などは未対応）
      const byDay = {};
      own.forEach(sh => { const len = sh.end - sh.start, rec = breaksOf(sh); const b = rec > 0 ? rec : ((m || sm.confirmed) ? empBreak(ctx, m, len, sh.date) : 0); byDay[sh.date] = (byDay[sh.date] || 0) + len - b; });
      let legalDay = 0; const wk = {};
      Object.entries(byDay).forEach(([d, w]) => { legalDay += Math.max(0, w - 480); const k = addDays(d, -dowOf(d)); wk[k] = (wk[k] || 0) + Math.min(w, 480); });
      const legalWeek = Object.values(wk).reduce((n, w) => n + Math.max(0, w - 2400), 0);
      return Object.assign({}, sm, { actualMinutes: actual, workDays: own.length, diffMinutes: sm.targetMinutes == null ? null : actual - sm.targetMinutes, breakAssumedDays: assumed,
        overScheduledMinutes: sm.targetMinutes == null ? null : Math.max(0, actual - sm.targetMinutes), legalOtMinutes: legalDay + legalWeek, legalOtDailyMinutes: legalDay, legalOtWeeklyMinutes: legalWeek });
    });
  }
  // 日ごとの必要人数の内訳（15分×人の合計）：社員が担当・それ以外（パート・アルバイト等）が担当・不足・過剰
  // 過剰＝必要人数の条件がある時間帯に勤務中（休憩を除く）だが、どの必要枠も担当していない人×時間（必要人数を超える配置）
  function coverageOf(ctx, date, ev, dayShifts) {
    const r = { date, needMinutes: 0, employeeMinutes: 0, otherMinutes: 0, shortMinutes: 0, excessMinutes: 0 };
    ev.slots.forEach(sl => {
      if (sl.tot && sl.tot.have < sl.tot.need) r.shortMinutes += (sl.tot.need - sl.tot.have) * SLOT;   // 店舗全体の人数の不足（担当の枠とは別に数える）
      sl.units.forEach((u, i) => {
        r.needMinutes += SLOT;
        const sid = sl.pick[i];
        if (sid == null) r.shortMinutes += SLOT;
        else if (isEmpDay(ctx.staffById.get(sid) || {}, date)) r.employeeMinutes += SLOT;
        else r.otherMinutes += SLOT;
      });
      if (dayShifts) {
        const busy = new Set(sl.pick.filter(x => x != null));
        r.excessMinutes += presentAt(ctx, dayShifts, sl.t).filter(p => !busy.has(p.s.id)).length * SLOT;
      }
    });
    // 時間帯別（1時間ごと。その1時間の中で最も厳しい値）：必要な担当数・配置済み・不足・勤務中の人数（休憩を除く）
    const byHour = {};
    ev.slots.forEach(sl => {
      const h = Math.floor(sl.t / 60) * 60, filled = sl.pick.filter(x => x != null).length, need = sl.units.length;
      const tol = ev.tolSet ? sl.units.filter(u => u.kind === 'main' && ev.tolSet.has(u.id + '|' + sl.t)).length : 0;
      const pres = dayShifts ? presentAt(ctx, dayShifts, sl.t) : null;
      const short = Math.max(0, need - filled - tol, sl.tot ? sl.tot.need - sl.tot.have : 0), people = pres ? pres.length : null;
      const emp = pres ? pres.filter(p => isEmpDay(p.s, date)).length : null;
      const b = byHour[h] = byHour[h] || { start: h, need: 0, filled: Infinity, short: 0, people: Infinity, emp: Infinity, other: Infinity };
      b.need = Math.max(b.need, need); b.filled = Math.min(b.filled, filled); b.short = Math.max(b.short, short);
      if (people != null) { b.people = Math.min(b.people, people); b.emp = Math.min(b.emp, emp); b.other = Math.min(b.other, people - emp); }
    });
    const fin = v => v === Infinity ? null : v;
    r.hours = Object.values(byHour).sort((a, b) => a.start - b.start).map(b => ({ start: b.start, need: b.need, filled: b.filled, short: b.short, people: fin(b.people), emp: fin(b.emp), other: fin(b.other) }));
    return r;
  }

  function summarize(ctx, out) {
    const byStaff = {};
    out.shifts.forEach(sh => {
      const b = byStaff[sh.staffId] = byStaff[sh.staffId] || { minutes: 0, days: 0 };
      b.minutes += sh.end - sh.start - breaksOf(sh); b.days++;
    });
    ctx.staff.forEach(s => { const b = byStaff[s.id] = byStaff[s.id] || { minutes: 0, days: 0 }; b.targetMinutes = (s.targetHours || 0) * 60; });
    const shortSlotUnits = out.violations.filter(v => v.start != null).reduce((n, v) => n + (v.need - v.have) * (v.end - v.start) / SLOT, 0);
    return {
      shifts: out.shifts.length,
      workMinutes: Object.values(byStaff).reduce((a, b) => a + b.minutes, 0),
      shortPersonMinutes: shortSlotUnits * SLOT,
      dailyShort: out.violations.filter(v => v.kind === 'daily').reduce((n, v) => n + v.need - v.have, 0),
      violations: out.violations.length,
      excessPersonMinutes: (out.coverage || []).reduce((n, c) => n + (c.excessMinutes || 0), 0),
      leaderGapOver: (out.leaderGaps || []).filter(g => !g.tolerated).length,
      leaderGapTolerated: (out.leaderGaps || []).filter(g => g.tolerated).length,
      leaderGapMinutes: ctx.leaderGap,
      employeeShort: (out.employees || []).filter(e => e.diffMinutes < 0).length,
      employeeOver: (out.employees || []).filter(e => e.diffMinutes > 0).length,
      byStaff,
    };
  }

  // 別の方法で作ったシフトを同じ基準で評価する。shifts: [{staffId,date,start,end,pos,breaks}]
  // ポジション（pos）が入っているシフトは、そのポジションの担当として扱う
  function evaluate(input, shifts) {
    const ctx = prepare(input);
    const out = { shifts, duties: [], violations: [], warnings: gridNotices(input), unplacedRequests: [], coverage: [] };
    (input.dates || []).forEach(date => {
      const day = shifts.filter(s => s.date === date).map(s => Object.assign({}, s, { lock: lockOf(s.pos) }));
      const dem = dayDemand(ctx, date);
      const ev = evaluateDay(ctx, date, day, dem);
      out.violations.push(...violationsOf(date, ev));
      out.duties.push(...dutiesOf(date, ev));
      out.warnings.push(...dem.warnings);
      out.warnings.push(...empBreakIssues(ctx, date, day.filter(sh => { const s = ctx.staffById.get(sh.staffId); return s && isEmployee(s) && isEmpDay(s, date); }), day, dem, true));
      out.coverage.push(coverageOf(ctx, date, ev, day));
      (out.leaderGaps = out.leaderGaps || []).push(...leaderGapsOf(ctx, date, ev, day));
    });
    // 社員の所定時間：目標は設定から、実働は渡されたシフト（店長が直した後の内容）から
    const emp = planEmployees(Object.assign({}, ctx, { input: Object.assign({}, input, { locked: [] }) }));
    out.employees = employeeResults(ctx, out, emp);
    out.employees.forEach(e => empWarnings(input, e, out));
    legalWarnings(ctx, out);
    out.stats = summarize(ctx, out);
    return out;
  }

  // 法令上の確認（通常の労働時間制度。変形労働時間制などは未対応）：作成・再評価の結果のシフトで判定し、違反のおそれを警告する
  //   1日8時間・週40時間（日曜始まり）を超える勤務：36協定の上限が未設定なら警告（設定があれば月の上限で判定＝law36Over）
  //   毎週1日の休日（日曜〜土曜がすべて期間内の週に、休みが1日も無い）・記録された休憩が法定より短い
  //   休憩の記録が無い勤務（公開済みの再読み込みなど）は、休憩を推定して実働を数える（休憩不足とはしない）
  const LEGAL_TYPES = ['legalDay', 'legalWeek', 'legalHoliday', 'legalBreak', 'law36Over', 'empOverCap'];
  function legalWarnings(ctx, out) {
    const inp = ctx.input, law = inp.law36 && inp.law36.monthMinutes > 0, dset = new Set(inp.dates || []);
    const lawDay = law && inp.law36.dayMinutes > 0 ? inp.law36.dayMinutes : null;
    const by = new Map();
    out.shifts.forEach(sh => { if (!by.has(sh.staffId)) by.set(sh.staffId, []); by.get(sh.staffId).push(sh); });
    by.forEach((list, id) => {
      const s = ctx.staffById.get(id) || {}, days = {};
      list.forEach(sh => {
        const len = sh.end - sh.start, rec = breaksOf(sh), m = s.monthly ? empSettings(s, monthOf(sh.date)) : null;
        if (rec > 0 && rec < breakMinutes(ctx, len)) out.warnings.push({ date: sh.date, staffId: id, type: 'legalBreak', msg: `休憩（${rec}分）が法定（実働6時間超は45分・8時間超は60分）より短いおそれがあります（${fmt(sh.start)}〜${fmt(sh.end)}）` });
        const b = rec > 0 ? rec : (m || (isEmployee(s) && isEmpDay(s, sh.date)) ? empBreak(ctx, m, len, sh.date) : breakMinutes(ctx, len));
        days[sh.date] = (days[sh.date] || 0) + len - b;
      });
      const wk = {};
      Object.entries(days).forEach(([d, w]) => {
        if (w > LEGAL_DAY && (lawDay == null || w - LEGAL_DAY > lawDay)) out.warnings.push({ date: d, staffId: id, type: 'legalDay', msg: `1日の実働が ${fmtH(w)} で、8時間を超えます（法定時間外）。${!law ? '36協定の上限が未設定' : lawDay == null ? '36協定の1日の延長の上限が未設定' : `36協定の1日の延長の上限（${fmtH(lawDay)}）を超える`}ため、確認してください（確定シフト・固定の時間などは自動では変えていません）` });
        const k = sunKey(d); wk[k] = (wk[k] || 0) + Math.min(w, LEGAL_DAY);
      });
      Object.entries(wk).forEach(([k, w]) => { if (!law && w > LEGAL_WEEK) out.warnings.push({ date: k, staffId: id, type: 'legalWeek', msg: `${k} からの1週間（日曜始まり・作成期間内）の実働が ${fmtH(w)} で、週40時間を超えます（法定時間外）。36協定の上限が未設定のため、確認してください` }); });
      const ext = new Set(((inp.externalWork || {})[id] || []).map(x => x.date));
      [...new Set(Object.keys(days).map(sunKey))].forEach(k => {
        const week = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(k, i));
        if (week.every(d => dset.has(d)) && week.every(d => days[d] != null || ext.has(d))) out.warnings.push({ date: k, staffId: id, type: 'legalHoliday', msg: `${k} からの1週間（日曜〜土曜）に休日がありません（法定休日は毎週1日以上。4週4日の変形休日制などは設定がありません）。確認してください` });
      });
    });
  }

  // 自動では解決できなかった不足の理由（再調整・作成の結果の確認用）：日付・時間帯・必要／配置の人数と、担当できる人がなぜ入れなかったか
  //   category：register＝レジ担当の不足・skill＝業務の担当の不足（キッチンなど）・headcount＝必要人数の不足・leader＝時間帯責任者
  //   担当できる人の内訳：ほかの担当中・休憩中・休み（休み希望・社員の休日・他店舗など）・勤務できる時間の外・上限に達している（理由別）・その他（最短勤務などで入れられない）
  function explainShortages(input, result) {
    const ctx = prepare(input), out = [];
    const byDate = {}; (result.shifts || []).forEach(sh => (byDate[sh.date] = byDate[sh.date] || []).push(sh));
    const acc = newAcc(ctx);
    (result.shifts || []).forEach(sh => { if (sh.source === 'locked') return; const w = sh.end - sh.start - breaksOf(sh), wk = sh.staffId + '|' + weekKey(sh.date);
      acc.mins.set(sh.staffId, (acc.mins.get(sh.staffId) || 0) + w); acc.week.set(wk, (acc.week.get(wk) || 0) + w); });
    (result.shifts || []).forEach(sh => { if (!acc.days.has(sh.staffId)) acc.days.set(sh.staffId, new Set()); acc.days.get(sh.staffId).add(sh.date); });
    (result.violations || []).filter(v => v.start != null && v.kind !== 'daily').forEach(v => {
      const unit = v.kind === 'skill' ? { kind: 'skill', skill: v.skill, level: v.level || 'solo', key: 'skill:' + v.skill } : v.kind === 'pos' ? { kind: 'pos', pos: v.pos, key: 'pos:' + v.pos } : v.kind === 'total' ? { kind: 'total', key: 'total' } : { kind: 'main', key: 'main' };
      const day = byDate[v.date] || [], c = { total: 0, busy: 0, onBreak: 0, off: 0, outside: 0, limit: 0, other: 0 }, limits = {};
      ctx.staff.forEach(s => {
        if (unit.kind !== 'total' && !eligible(ctx, s, unit)) return;   // 店舗全体の人数はだれでも
        c.total++;
        const sh = day.find(x => x.staffId === s.id);
        if (sh) {
          if (!(sh.start <= v.start && sh.end >= v.end)) c.outside++;
          else if ((sh.breaks || []).some(b => b.start < v.end && b.end > v.start)) c.onBreak++;
          else c.busy++;
          return;
        }
        if (((input.offs || {})[s.id] || []).includes(v.date) || isEmpDay(s, v.date)) { c.off++; return; }
        if (!windowsFor(ctx, s, v.date).some(w => w.start <= v.start && w.end >= v.end)) { c.outside++; return; }
        const len = Math.max(ctx.opt.minShift, v.end - v.start), why = contractProblem(ctx, acc, s, v.date, len - breakMinutes(ctx, len));
        if (why) { c.limit++; limits[why] = (limits[why] || 0) + 1; return; }
        c.other++;
      });
      const name = v.kind === 'skill' ? (ctx.skillName[v.skill] || v.skill) : v.kind === 'pos' ? v.pos : v.kind === 'total' ? '店舗全体' : '時間帯責任者';
      const category = v.kind === 'skill' ? (v.skill === 'register' || name === 'レジ' ? 'register' : 'skill') : (v.kind === 'pos' || v.kind === 'total') ? 'headcount' : 'leader';
      const parts = [['ほかの担当中', c.busy], ['休憩中', c.onBreak], ['休み', c.off], ['勤務できる時間の外', c.outside], ['上限に達している' + (Object.keys(limits).length ? '（' + Object.entries(limits).map(([k, n]) => k + n + '人').join('・') + '）' : ''), c.limit], ['その他', c.other]].filter(x => x[1] > 0);
      const label = { register: 'レジ担当の不足', skill: `${name}の担当の不足`, headcount: v.kind === 'total' ? '店舗全体の人数の不足' : `${name}の必要人数の不足`, leader: '時間帯責任者の不在' }[category];
      out.push({ date: v.date, start: v.start, end: v.end, need: v.need, have: v.have, category, limitReached: c.limit > 0, label, counts: c, limits,
        msg: `${label}：${fmt(v.start)}〜${fmt(v.end)} 必要 ${v.need}人・配置 ${v.have}人（${v.need - v.have}人不足）。` + (c.total ? `担当できる人 ${c.total}人：${parts.map(x => x[0] + ' ' + x[1] + '人').join('・')}` : '担当できる人がいません（業務能力・ポジションの設定を確認してください）') });
    });
    return out;
  }
  // 法令上の重大な問題：6時間を超える勤務で、記録された休憩が法定の最低時間（6時間超45分・8時間超60分）より短い（休憩なしを含む）
  //   公開済みで変更していない勤務（pub）は対象外（休憩はまだ保存されないため、読み込んだ勤務には休憩の記録が無い）
  function legalBreakCritical(input, shifts) {
    const ctx = prepare(input), out = [];
    (shifts || []).forEach(sh => {
      if (sh.pub) return;
      const len = sh.end - sh.start, need = breakMinutes(ctx, len), inside = (sh.breaks || []).filter(b => b.start >= sh.start && b.end <= sh.end).reduce((n, b) => n + b.end - b.start, 0);
      if (need > 0 && inside < need) out.push({ date: sh.date, staffId: sh.staffId, start: sh.start, end: sh.end, severity: 'critical', type: 'legalBreakMissing',
        msg: `【重大】${fmt(sh.start)}〜${fmt(sh.end)}（拘束 ${fmtH(len)}）の休憩が ${inside}分です。法定の最低 ${need}分（実働6時間超は45分・8時間超は60分）を満たしていません。休憩を入れてから公開してください` });
    });
    return out;
  }

  // 計画の妥当性チェック：問題があれば文字列の配列
  function audit(input, result) {
    const ctx = prepare(input), probs = [];
    const lockedKey = l => `${l.staffId}|${l.date}|${l.start}|${l.end}|${l.pos || ''}`;
    (input.locked || []).forEach(l => { if (!result.shifts.some(s => s.source === 'locked' && lockedKey(s) === lockedKey(l))) probs.push('確定シフトが変わっています: ' + lockedKey(l)); });
    const perDay = {};
    result.shifts.forEach(s => {
      const k = s.staffId + '|' + s.date; perDay[k] = (perDay[k] || 0) + 1;
      if (s.source === 'locked') return;
      if (((input.offs || {})[s.staffId] || []).includes(s.date)) probs.push(`希望休の日に入っています: ${s.staffId} ${s.date}`);
      if (s.source === 'request' || s.source === 'auto') {
        const ws = windowsFor(ctx, ctx.staffById.get(s.staffId), s.date);
        if (!ws.some(w => w.start <= s.start && w.end >= s.end)) probs.push(`勤務可能時間の外です: ${s.staffId} ${s.date} ${fmt(s.start)}-${fmt(s.end)}`);
      }
      const len = s.end - s.start, b = breaksOf(s);
      if (b < breakMinutes(ctx, len) || (s.breaks || []).some(x => x.start < s.start || x.end > s.end)) probs.push(`休憩が不足・不正: ${s.staffId} ${s.date}`);
      // 社員の確定シフト：取り込んだ内容（勤務・時間）のとおりで、休み・他店舗の日には入っていない
      const st = ctx.staffById.get(s.staffId), m = st && empSettings(st, monthOf(s.date));
      if (st && hasConfirmed(st, monthOf(s.date))) {
        const c = confirmedOf(st, s.date);
        if (!c || c.kind !== 'work') probs.push(`社員の確定シフト（${c ? (c.kind === 'off' ? '休み' : '他店舗') : '記載なし'}）の日に入っています: ${s.staffId} ${s.date}`);
        else if (s.source === 'confirmed' && c.range && !(c.start != null && c.end > c.start)) { if (s.start < c.range.start && !(st.morningPrep && s.start === PREP_START) || s.end > c.range.end || (c.start != null && s.start !== c.start)) probs.push(`社員の勤務できる範囲の外です: ${s.staffId} ${s.date}`); }
        else if (s.source === 'confirmed' && (s.start !== c.start || s.end !== c.end)) probs.push(`社員の確定シフトの時間が変わっています: ${s.staffId} ${s.date}`);
        else if (s.source !== 'confirmed') probs.push(`社員の確定シフト以外で入っています: ${s.staffId} ${s.date}`);
      } else if (m) {
        const e = (m.exceptions || {})[s.date] || null, dow = dowOf(s.date);
        if (s.source !== 'employee') probs.push(`社員が所定時間の計画以外で入っています: ${s.staffId} ${s.date}`);
        if (e && (e.type === 'off' || e.type === 'paid')) probs.push(`社員の休み（${e.type === 'paid' ? '有給' : '希望休'}）に入っています: ${s.staffId} ${s.date}`);
        if ((m.offDows || []).map(Number).includes(dow) && !(e && e.type === 'work')) probs.push(`社員の固定休日に入っています: ${s.staffId} ${s.date}`);
        if (e && e.type === 'work' && (s.start !== e.start || s.end > e.end)) probs.push(`臨時の勤務変更と違う時間です: ${s.staffId} ${s.date}`);
        const half = (e && (e.type === 'am' || e.type === 'pm')) ? e.type : ((m.halfOff || {})[dow] || null);
        if (half) {
          const dh = (m.dayHours || {})[dow] || { start: s.start, end: s.end };
          const split = m.halfSplit != null ? m.halfSplit : Math.round((dh.start + dh.end) / 2 / SLOT) * SLOT;
          if ((half === 'am' && s.start < split) || (half === 'pm' && s.end > split)) probs.push(`社員の半休（${half === 'am' ? '午前' : '午後'}）に勤務しています: ${s.staffId} ${s.date}`);
        }
        if (b < empBreak(ctx, m, len, s.date)) probs.push(`社員の休憩時間が設定より短い: ${s.staffId} ${s.date}`);
        const dh = (m.dayHours || {})[dow];
        if (timeModeOf(m, dow) === 'range' && dh && !(e && e.type === 'work') && ((s.start < dh.start && !(st.morningPrep && s.start === PREP_START)) || s.end > dh.end)) probs.push(`社員の勤務できる範囲の外です: ${s.staffId} ${s.date}`);
        if (timeModeOf(m, dow) === 'fixed' && dh && !(e && e.type === 'work') && !half && (s.start !== dh.start || s.end !== dh.end)) probs.push(`社員の固定の時間と違います: ${s.staffId} ${s.date}`);
      }
    });
    Object.entries(perDay).forEach(([k, n]) => { if (n > 1) probs.push('同じ日に2つのシフトがあります: ' + k); });
    const byKey = {};
    result.duties.forEach(d => { (byKey[d.staffId + '|' + d.date] = byKey[d.staffId + '|' + d.date] || []).push(d); });
    Object.entries(byKey).forEach(([k, ds]) => {
      const [sid, date] = k.split('|'); const staffId = isNaN(+sid) ? sid : +sid;
      const sh = result.shifts.find(s => s.staffId === staffId && s.date === date);
      const s = ctx.staffById.get(staffId);
      const asUnit = d => d.kind === 'skill' ? Object.assign({ kind: 'skill', skill: d.skill, key: 'skill:' + d.skill + (d.inPos ? '@' + d.inPos : '') }, d.inPos ? { inPos: d.inPos } : {}) : d.kind === 'pos' ? { kind: 'pos', pos: d.pos, key: 'pos:' + d.pos } : { kind: 'main', key: 'main' };
      ds.forEach(d => {
        if (!sh || d.start < sh.start || d.end > sh.end) probs.push(`勤務時間外の担当: ${k} ${d.label}`);
        if (sh && (sh.breaks || []).some(b => b.start < d.end && b.end > d.start)) probs.push(`休憩中の担当: ${k} ${d.label} ${fmt(d.start)}`);
        if (!s || (d.kind === 'skill' && !s.levels[d.skill]) || (d.kind === 'pos' && !s.positions.includes(d.pos)) || (d.kind === 'main' && !s.canMain)) probs.push(`能力・ポジションのない担当: ${k} ${d.label}`);
        if (d.inPos) {
          if (!s || !s.positions.includes(d.inPos)) probs.push(`内数のポジション資格がない担当: ${k} ${d.label}`);
          for (let t = d.start; t < d.end; t += SLOT) {
            if (!ds.some(p => p.kind === 'pos' && p.pos === d.inPos && p.start <= t && p.end >= t + SLOT)) {
              probs.push(`内数のポジション配置がない担当: ${k} ${d.label} ${fmt(t)}`); break;
            }
          }
        }
        if (sh && sh.source === 'locked' && !sh.posFree && !allowedWithLock(ctx, lockOf(sh.pos), asUnit(d))) probs.push(`確定シフトのポジションと両立しない担当: ${k} ${d.label}`);
      });
      for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) {
        const a = ds[i], b = ds[j];
        if (a.start < b.end && b.start < a.end && !unitCompat(ctx, asUnit(a), asUnit(b))) probs.push(`同時に持てない担当: ${k} ${a.label}+${b.label} ${fmt(Math.max(a.start, b.start))}`);
      }
    });
    // 契約条件（自動作成分）と連続勤務
    const acc = newAcc(ctx);
    (input.dates || []).forEach(date => {
      result.shifts.filter(s => s.date === date).forEach(sh => {
        const s = ctx.staffById.get(sh.staffId); if (!s) return;
        const work = sh.end - sh.start - breaksOf(sh);
        if (sh.source === 'request' || sh.source === 'auto') { const why = contractProblem(ctx, acc, s, date, work); if (why) probs.push(`契約条件（${why}）を超えています: ${sh.staffId} ${date}`); }
        if (sh.source !== 'locked') { acc.mins.set(s.id, (acc.mins.get(s.id) || 0) + work); const wk = s.id + '|' + weekKey(date); acc.week.set(wk, (acc.week.get(wk) || 0) + work); }
        if (!acc.days.has(s.id)) acc.days.set(s.id, new Set()); acc.days.get(s.id).add(date);
      });
    });
    return probs;
  }

  const api = { LEGAL_TYPES, explainShortages, legalBreakCritical, needGridStatus, plan, planStart, planContinue, planFinish, evaluate, audit, DEFAULTS, _internal: { assignSlot, dayDemand, needGridSegments, evaluateDay, violationsOf, dutiesOf, unitCompat } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RakuAutoFill2 = api;
})(typeof window !== 'undefined' ? window : globalThis);
