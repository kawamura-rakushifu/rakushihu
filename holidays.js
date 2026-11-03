// らくシフト 日本の祝日と、その日の営業時間の決定（計算専用。画面・サーバー共通。外部への通信はしない）
// ・祝日データ：内閣府「国民の祝日」の公表内容（2025〜2027年）を組み込み。春分・秋分の日は官報で公表済みの年だけ。
//   それ以外の年は、内閣府の祝日CSV（syukujitsu.csv）を管理者が取り込むまで「未取得」とし、平日扱いしない。
// ・振替休日（祝日が日曜 → 次の祝日でない日）・国民の休日（祝日に挟まれた日）は、組み込みデータに含む（下の計算でも確認できる）。
// ・営業時間の優先順位：臨時休業・特別営業時間（日付ごと）→ 土日祝 → 通常平日。
(function (root) {
  'use strict';
  // 内閣府の公表（国民の祝日・休日）。名称の「休日」は振替休日・国民の休日
  const BUILTIN = {
    2025: { '01-01': '元日', '01-13': '成人の日', '02-11': '建国記念の日', '02-23': '天皇誕生日', '02-24': '休日', '03-20': '春分の日', '04-29': '昭和の日',
      '05-03': '憲法記念日', '05-04': 'みどりの日', '05-05': 'こどもの日', '05-06': '休日', '07-21': '海の日', '08-11': '山の日', '09-15': '敬老の日',
      '09-23': '秋分の日', '10-13': 'スポーツの日', '11-03': '文化の日', '11-23': '勤労感謝の日', '11-24': '休日' },
    2026: { '01-01': '元日', '01-12': '成人の日', '02-11': '建国記念の日', '02-23': '天皇誕生日', '03-20': '春分の日', '04-29': '昭和の日',
      '05-03': '憲法記念日', '05-04': 'みどりの日', '05-05': 'こどもの日', '05-06': '休日', '07-20': '海の日', '08-11': '山の日', '09-21': '敬老の日',
      '09-22': '休日', '09-23': '秋分の日', '10-12': 'スポーツの日', '11-03': '文化の日', '11-23': '勤労感謝の日' },
    2027: { '01-01': '元日', '01-11': '成人の日', '02-11': '建国記念の日', '02-23': '天皇誕生日', '03-21': '春分の日', '03-22': '休日', '04-29': '昭和の日',
      '05-03': '憲法記念日', '05-04': 'みどりの日', '05-05': 'こどもの日', '07-19': '海の日', '08-11': '山の日', '09-20': '敬老の日',
      '09-23': '秋分の日', '10-11': 'スポーツの日', '11-03': '文化の日', '11-23': '勤労感謝の日' },
  };
  // 官報で公表済みの春分・秋分の日（この表に無い年は計算しない）
  const EQUINOX = { 2025: ['03-20', '09-23'], 2026: ['03-20', '09-23'], 2027: ['03-21', '09-23'] };
  const pad = n => String(n).padStart(2, '0');
  const dowOf = d => new Date(d + 'T00:00:00Z').getUTCDay();
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const nthMonday = (y, m, n) => { const first = dowOf(`${y}-${pad(m)}-01`); return `${pad(m)}-${pad(1 + ((8 - first) % 7) + (n - 1) * 7)}`; };

  // 祝日法（2021年以降の通常の規定）による計算。春分・秋分が公表済みの年だけ。組み込みデータの確認用
  function compute(y) {
    if (!EQUINOX[y] || y < 2021) return null;
    const base = { '01-01': '元日', '02-11': '建国記念の日', '02-23': '天皇誕生日', '04-29': '昭和の日', '05-03': '憲法記念日', '05-04': 'みどりの日', '05-05': 'こどもの日',
      '08-11': '山の日', '11-03': '文化の日', '11-23': '勤労感謝の日' };
    base[nthMonday(y, 1, 2)] = '成人の日'; base[nthMonday(y, 7, 3)] = '海の日'; base[nthMonday(y, 9, 3)] = '敬老の日'; base[nthMonday(y, 10, 2)] = 'スポーツの日';
    base[EQUINOX[y][0]] = '春分の日'; base[EQUINOX[y][1]] = '秋分の日';
    const out = Object.assign({}, base), isH = md => !!out[md], ymd = md => `${y}-${md}`;
    // 振替休日：祝日が日曜なら、その後の最初の祝日でない日
    Object.keys(base).sort().forEach(md => { if (dowOf(ymd(md)) === 0) { let d = addDays(ymd(md), 1); while (isH(d.slice(5))) d = addDays(d, 1); if (d.slice(0, 4) === String(y)) out[d.slice(5)] = '休日'; } });
    // 国民の休日：前日と翌日が祝日の、祝日でない日（日曜を除く）
    for (let d = `${y}-01-02`; d < `${y}-12-31`; d = addDays(d, 1)) { const md = d.slice(5); if (!out[md] && dowOf(d) !== 0 && base[addDays(d, -1).slice(5)] && base[addDays(d, 1).slice(5)]) out[md] = '休日'; }
    return out;
  }

  // 取り込んだ祝日データ（内閣府の祝日CSV）：{years:[2028,…], dates:{'2028-01-01':'元日',…}}
  let extra = { years: [], dates: {} };
  function setExtra(v) { extra = { years: (v && v.years || []).map(Number), dates: Object.assign({}, v && v.dates) }; }
  function coveredYears() { return [...new Set(Object.keys(BUILTIN).map(Number).concat(extra.years))].sort(); }
  // 祝日か：{known:false}＝その年の祝日データが無い（平日扱いしない）
  function info(date) {
    const y = +String(date).slice(0, 4);
    if (extra.years.includes(y)) { const n = extra.dates[date]; return { known: true, holiday: !!n, name: n || '' }; }
    const b = BUILTIN[y]; if (!b) return { known: false, holiday: false, name: '' };
    const n = b[String(date).slice(5)]; return { known: true, holiday: !!n, name: n || '' };
  }
  // 内閣府の祝日CSV（"国民の祝日・休日月日,国民の祝日・休日名称" / 2028/1/1,元日）を読む。年ごとに丸ごと置き換える
  function parseCsv(text) {
    const dates = {}, years = new Set(), bad = [];
    String(text || '').split(/\r?\n/).forEach((line, i) => {
      const c = line.split(','); if (!c[0] || i === 0 && !/^\d/.test(c[0])) return;
      const m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/.exec(c[0].trim());
      if (!m) { if (line.trim()) bad.push(i + 1); return; }
      const d = `${m[1]}-${pad(m[2])}-${pad(m[3])}`; dates[d] = (c[1] || '祝日').trim(); years.add(+m[1]);
    });
    return { dates, years: [...years].sort(), bad };
  }

  // 営業時間 {state:'open'|'closed', open, close, periods:[{start,end}]} の形をそろえる（periods が無ければ open〜close の1つ）
  function norm(h) {
    if (!h || !(h.state === 'open' || h.state === 'closed')) return null;
    if (h.state === 'closed') return { state: 'closed' };
    const ps = (Array.isArray(h.periods) && h.periods.length ? h.periods : [{ start: h.open, end: h.close }])
      .map(p => ({ start: +p.start, end: +p.end })).filter(p => p.end > p.start).sort((a, b) => a.start - b.start);
    if (!ps.length) return null;
    return { state: 'open', open: ps[0].start, close: ps[ps.length - 1].end, periods: ps };
  }
  // その日の営業時間：臨時休業・特別営業時間 → 土日祝 → 通常平日。決められない日は state:'unknown'（要設定）
  //   hours：{0..6: 曜日の設定, h: 祝日の設定（無ければ日曜と同じ）}／special：{日付:{reason, periods?}}（periods 無し＝臨時休業）
  function resolve(hours, special, date) {
    const sp = special && special[date];
    if (sp) return sp.periods && sp.periods.length ? Object.assign(norm({ state: 'open', periods: sp.periods }) || { state: 'unknown' }, { kind: 'special', special: true, reason: sp.reason || '' })
      : { state: 'closed', kind: 'special', temporary: true, reason: sp.reason || '' };
    const dow = dowOf(date), hi = info(date);
    if (dow === 0 || dow === 6) { const h = norm(hours[dow]); return h ? Object.assign(h, { kind: 'weekend', holiday: hi.holiday, holidayName: hi.name }) : null; }
    if (!hi.known) return { state: 'unknown', kind: 'unknown', reason: `${date.slice(0, 4)}年の祝日データが未取得` };
    if (hi.holiday) { const src = hours.h ? 'h' : 0, h = norm(hours[src]); return h ? Object.assign(h, { kind: 'holiday', holiday: true, holidayName: hi.name, from: src === 'h' ? '祝日の設定' : '日曜と同じ' }) : null; }
    const h = norm(hours[dow]); return h ? Object.assign(h, { kind: 'weekday' }) : null;
  }

  const api = { BUILTIN, EQUINOX, compute, info, setExtra, coveredYears, parseCsv, norm, resolve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RakuHolidays = api;
})(typeof window !== 'undefined' ? window : globalThis);
