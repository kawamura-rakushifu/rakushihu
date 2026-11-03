// らくシフト 締切翌日の自動作成：予定日時の計算と実行判定（計算専用。画面・DBには触れない）
// ・日時はすべて日本時間（Asia/Tokyo, UTC+9・夏時間なし）で判定する。端末のタイムゾーン設定には左右されない。
// ・締切 'YYYY-MM-DDTHH:mm' は日本時間として解釈する。
(function (root) {
  'use strict';
  const JST = 9 * 3600 * 1000;
  const DEFAULTS = { enabled: true, offsetDays: 1, timeJst: '06:00', staleMinutes: 15, maxAttempts: 3 };

  // 'YYYY-MM-DDTHH:mm'（日本時間）→ UTC のミリ秒
  function jstToEpoch(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(String(s || ''));
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) - JST;
  }
  // UTC のミリ秒 → 日本時間の各値
  function jstParts(epoch) {
    const d = new Date(epoch + JST);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), dow: d.getUTCDay() };
  }
  const pad = n => String(n).padStart(2, '0');
  function formatJst(epoch) { const p = jstParts(epoch); return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}`; }
  function labelJst(epoch) { const p = jstParts(epoch); return `${p.m}/${p.d}（${'日月火水木金土'[p.dow]}）${pad(p.hh)}:${pad(p.mm)}`; }

  // 自動作成の予定日時：締切日（日本時間の日付）の offsetDays 日後の timeJst
  function scheduledEpoch(deadlineJst, offsetDays, timeJst) {
    const dl = jstToEpoch(deadlineJst);
    if (isNaN(dl)) return NaN;
    const p = jstParts(dl);
    const t = /^(\d{2}):(\d{2})$/.exec(timeJst || DEFAULTS.timeJst) || [0, '06', '00'];
    return Date.UTC(p.y, p.m - 1, p.d + (offsetDays == null ? DEFAULTS.offsetDays : +offsetDays), +t[1], +t[2]) - JST;
  }

  // 対象期間（対象月の1日〜末日）
  function periodDates(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return [...Array(days)].map((_, i) => `${monthKey}-${pad(i + 1)}`);
  }

  // 実行判定。run：実行記録（店舗×対象月に1つ）{status, startedAt, finishedAt, attempts, error}
  // 戻り値 state：
  //   'noDeadline'（締切未設定） / 'disabled'（自動作成オフ） / 'waiting'（予定前） / 'beforeDeadline'（締切前）
  //   'due'（予定時刻を過ぎたが未実行＝店長に案内） / 'running'（実行中） / 'stale'（実行中のまま止まった＝再実行可）
  //   'succeeded'（作成済み） / 'failed'（失敗。再試行可） / 'gaveUp'（失敗が上限回数に達した）
  function decide({ nowEpoch, deadlineJst, schedule, run }) {
    const sc = Object.assign({}, DEFAULTS, schedule || {});
    if (!deadlineJst) return { state: 'noDeadline' };
    const dl = jstToEpoch(deadlineJst);
    const at = scheduledEpoch(deadlineJst, sc.offsetDays, sc.timeJst);
    const base = { deadlineEpoch: dl, scheduledEpoch: at };
    if (run && run.status === 'succeeded') return Object.assign({ state: 'succeeded' }, base);
    if (run && run.status === 'running') {
      const started = Date.parse(run.startedAt || '');
      const stale = !isNaN(started) && nowEpoch - started > sc.staleMinutes * 60000;
      return Object.assign({ state: stale ? 'stale' : 'running' }, base);
    }
    if (run && run.status === 'failed') return Object.assign({ state: (run.attempts || 1) >= sc.maxAttempts ? 'gaveUp' : 'failed' }, base);
    if (!sc.enabled) return Object.assign({ state: 'disabled' }, base);
    if (nowEpoch < dl) return Object.assign({ state: 'beforeDeadline' }, base);
    if (nowEpoch < at) return Object.assign({ state: 'waiting' }, base);
    return Object.assign({ state: 'due' }, base);
  }

  // 実行記録の遷移（二重実行防止は保存時の版番号チェックで行う。ここでは「始めてよいか」と次の値を返す）
  function claim(run, nowEpoch, schedule, by) {
    const sc = Object.assign({}, DEFAULTS, schedule || {});
    if (run && run.status === 'succeeded') return { ok: false, reason: 'already' };
    if (run && run.status === 'running') {
      const started = Date.parse(run.startedAt || '');
      if (isNaN(started) || nowEpoch - started <= sc.staleMinutes * 60000) return { ok: false, reason: 'running' };
    }
    const attempts = (run && run.attempts || 0) + 1;
    return { ok: true, next: { status: 'running', startedAt: new Date(nowEpoch).toISOString(), finishedAt: null, by: by || '', attempts, error: null } };
  }
  function succeed(run, nowEpoch, summary) {
    return Object.assign({}, run, { status: 'succeeded', finishedAt: new Date(nowEpoch).toISOString(), error: null }, summary || {});
  }
  function fail(run, nowEpoch, message) {
    return Object.assign({}, run, { status: 'failed', finishedAt: new Date(nowEpoch).toISOString(), error: String(message || '不明なエラー').slice(0, 300) });
  }

  const api = { DEFAULTS, jstToEpoch, jstParts, formatJst, labelJst, scheduledEpoch, periodDates, decide, claim, succeed, fail };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RakuAutoSched = api;
})(typeof window !== 'undefined' ? window : globalThis);
