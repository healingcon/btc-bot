// ══════════════════════════════════════════════════════
// BTC 차트 텔레그램 봇 — Vercel 서버리스 함수
// ══════════════════════════════════════════════════════

const FAPI = 'https://fapi.binance.com/fapi/v1';
const TF_LABELS = { '1m':'1분봉','5m':'5분봉','15m':'15분봉','1h':'1시간봉','4h':'4시간봉' };

// ── 텔레그램 메시지 발송 ──────────────────────────────
async function sendTG(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

// ── Binance 캔들 조회 ─────────────────────────────────
async function fetchCandles(sym, interval, limit = 120) {
  const r = await fetch(`${FAPI}/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);
  const data = await r.json();
  if (!Array.isArray(data)) throw new Error('캔들 오류');
  return data.map(d => ({
    time: +d[0], open: +d[1], high: +d[2],
    low: +d[3], close: +d[4], vol: +d[5]
  })).filter(c => c.open > 0 && c.close > 0 && c.high >= c.low);
}

// ── 지표 계산 ─────────────────────────────────────────
function ema(arr, p) {
  const k = 2 / (p + 1);
  return arr.reduce((res, v, i) => {
    res.push(i === 0 ? v : v * k + res[i - 1] * (1 - k));
    return res;
  }, []);
}

function calcRSI(closes, p = 14) {
  if (closes.length < p + 2) return 50;
  let ag = 0, al = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    d >= 0 ? ag += d : al -= d;
  }
  ag /= p; al /= p;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcMACD(closes) {
  if (closes.length < 35) return { hist: 0 };
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const ml = e12.map((v, i) => v - e26[i]);
  const sl = ema(ml, 9);
  const n = ml.length - 1;
  return { hist: ml[n] - sl[n], macd: ml[n], signal: sl[n] };
}

function calcBB(closes, p = 20) {
  if (closes.length < p) return { pct: 50, aboveMid: true };
  const slice = closes.slice(-p);
  const mid = slice.reduce((a, b) => a + b) / p;
  const std = Math.sqrt(slice.reduce((s, v) => s + (v - mid) ** 2, 0) / p);
  const last = closes[closes.length - 1];
  const upper = mid + 2 * std, lower = mid - 2 * std;
  return { pct: ((last - lower) / (upper - lower)) * 100, aboveMid: last > mid };
}

function calcMA(closes, p) {
  if (closes.length < p) return null;
  return closes.slice(-p).reduce((a, b) => a + b) / p;
}

// ── 종합 신호 계산 ────────────────────────────────────
function calcSignal(candles) {
  if (candles.length < 30) return { score: 0, dir: 'neutral', label: '데이터 부족' };
  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  let score = 0;
  const sigs = [];

  // RSI
  const rsi = calcRSI(closes);
  if (rsi <= 30) { score -= 20; sigs.push(`RSI ${rsi.toFixed(1)} 과매도`); }
  else if (rsi >= 70) { score += 20; sigs.push(`RSI ${rsi.toFixed(1)} 과매수`); }
  else if (rsi > 50) { score += 10; sigs.push(`RSI ${rsi.toFixed(1)} 강세권`); }
  else { score -= 10; sigs.push(`RSI ${rsi.toFixed(1)} 약세권`); }

  // MACD
  const macd = calcMACD(closes);
  if (macd.hist > 0) { score += 15; sigs.push('MACD 상승'); }
  else { score -= 15; sigs.push('MACD 하락'); }

  // BB
  const bb = calcBB(closes);
  if (bb.aboveMid && bb.pct > 50) { score += 10; sigs.push(`BB ${bb.pct.toFixed(0)}% 상단`); }
  else if (!bb.aboveMid && bb.pct < 50) { score -= 10; sigs.push(`BB ${bb.pct.toFixed(0)}% 하단`); }

  // MA20/60
  const ma20 = calcMA(closes, 20), ma60 = calcMA(closes, 60);
  if (ma20 && ma60) {
    if (ma20 > ma60) { score += 15; sigs.push('MA 정배열'); }
    else { score -= 15; sigs.push('MA 역배열'); }
  }

  // 거래량
  const vols = candles.slice(-20).map(c => c.vol);
  const avgVol = vols.reduce((a, b) => a + b) / vols.length;
  const surgeRatio = last.vol / avgVol;
  if (surgeRatio >= 2) {
    if (last.close >= last.open) { score += 15; sigs.push(`거래량 급증 ×${surgeRatio.toFixed(1)} 매수`); }
    else { score -= 15; sigs.push(`거래량 급증 ×${surgeRatio.toFixed(1)} 매도`); }
  }

  // 매수/매도압
  const recent = candles.slice(-10);
  let bv = 0, sv = 0;
  recent.forEach(c => c.close >= c.open ? bv += c.vol : sv += c.vol);
  const bpct = bv / (bv + sv) * 100;
  if (bpct >= 65) { score += 10; sigs.push(`매수압 ${bpct.toFixed(0)}%`); }
  else if (bpct <= 35) { score -= 10; sigs.push(`매도압 ${(100 - bpct).toFixed(0)}%`); }

  const dir = score >= 50 ? 'buy' : score <= -50 ? 'sell' : 'neutral';
  return { score, dir, sigs, rsi, ma20, ma60, bb, macd };
}

// ── 시황 메시지 빌드 ──────────────────────────────────
async function buildReport(sym) {
  const tfs = ['1m', '5m', '15m', '1h', '4h'];
  const results = {};

  await Promise.allSettled(tfs.map(async tf => {
    try {
      const cs = await fetchCandles(sym, tf);
      const sig = calcSignal(cs);
      results[tf] = { ...sig, price: cs[cs.length - 1].close };
    } catch (e) { /* 실패 시 스킵 */ }
  }));

  const price = results['1m']?.price || results['5m']?.price || 0;
  let buyCount = 0, sellCount = 0;
  tfs.forEach(t => {
    const r = results[t]; if (!r) return;
    if (r.dir === 'buy' && r.score >= 50) buyCount++;
    if (r.dir === 'sell' && r.score <= -50) sellCount++;
  });
  const overall = buyCount >= 3 ? '🟢 매수우위' : sellCount >= 3 ? '🔴 매도우위' : '🟡 중립/관망';

  const tfLines = tfs.map(t => {
    const r = results[t]; if (!r) return `${TF_LABELS[t]}: ❓`;
    const icon = r.dir === 'buy' && r.score >= 50 ? '🟢' : r.dir === 'sell' && r.score <= -50 ? '🔴' : '🟡';
    return `${icon} ${TF_LABELS[t]}: ${Math.abs(r.score)}점`;
  }).join('\n');

  // 주요 신호 수집
  const allSigs = [];
  tfs.forEach(t => { results[t]?.sigs?.slice(0, 2).forEach(s => { if (!allSigs.includes(s)) allSigs.push(s); }); });

  const fmtPrice = p => p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 1 }) : p.toFixed(4);

  return `📊 <b>${sym} 시황 리포트</b>
🕐 ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}

💰 현재가: <b>$${fmtPrice(price)}</b>
🎯 종합판단: <b>${overall}</b>

⏰ <b>타임프레임별 분석</b>
${tfLines}

📋 <b>주요 신호</b>
${allSigs.slice(0, 5).map(s => `• ${s}`).join('\n')}

⚠️ <i>참고용 · 투자 결정은 본인 책임</i>`;
}

// ── 메인 핸들러 ───────────────────────────────────────
export default async function handler(req, res) {
  // GET: cron 5분 자동 발송
  if (req.method === 'GET') {
    const token  = process.env.TG_TOKEN;
    const chatId = process.env.TG_CHAT_ID;
    const sym    = process.env.COIN || 'BTCUSDT';
    if (!token || !chatId) return res.status(400).json({ error: '환경변수 없음' });
    try {
      const msg = await buildReport(sym);
      await sendTG(token, chatId, msg);
      return res.status(200).json({ ok: true, sent: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST: 텔레그램 Webhook
  if (req.method === 'POST') {
    const token  = process.env.TG_TOKEN;
    const chatId = process.env.TG_CHAT_ID;
    const sym    = process.env.COIN || 'BTCUSDT';
    if (!token || !chatId) return res.status(400).json({ error: '환경변수 없음' });

    const update = req.body;
    const msg    = update?.message;
    if (!msg) return res.status(200).json({ ok: true });

    // Chat ID 검증 (본인만 사용 가능)
    if (String(msg.chat.id) !== String(chatId)) return res.status(200).json({ ok: true });

    const text = (msg.text || '').trim().toLowerCase();

    try {
      if (text === '/status' || text === '/시황') {
        await sendTG(token, chatId, '⏳ 분석 중... 잠시만요!');
        const report = await buildReport(sym);
        await sendTG(token, chatId, report);

      } else if (text === '/help' || text === '/도움말') {
        await sendTG(token, chatId,
`📋 <b>명령어 목록</b>

/status 또는 /시황
→ 현재 시황 즉시 조회

/tf
→ 타임프레임별 점수 상세

/coin
→ 현재 분석 코인 확인

/help
→ 이 메시지

⏰ 자동 발송: <b>5분마다</b> 시황 리포트
🚨 신호 변경 시 즉시 알림`);

      } else if (text === '/tf') {
        const tfs = ['1m', '5m', '15m', '1h', '4h'];
        const lines = await Promise.all(tfs.map(async tf => {
          try {
            const cs = await fetchCandles(sym, tf, 80);
            const sig = calcSignal(cs);
            const icon = sig.dir === 'buy' && sig.score >= 50 ? '🟢'
              : sig.dir === 'sell' && sig.score <= -50 ? '🔴' : '🟡';
            return `${icon} ${TF_LABELS[tf]}: ${sig.dir === 'buy' ? '매수' : sig.dir === 'sell' ? '매도' : '중립'} ${Math.abs(sig.score)}점\n   └ ${sig.sigs.slice(0, 2).join(', ')}`;
          } catch { return `${TF_LABELS[tf]}: 오류`; }
        }));
        const price = (await fetchCandles(sym, '1m', 2)).at(-1)?.close || 0;
        await sendTG(token, chatId,
`📊 <b>${sym} 타임프레임 분석</b>
💰 $${price.toLocaleString('en-US', { maximumFractionDigits: 1 })}

${lines.join('\n\n')}

🕐 ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);

      } else if (text === '/coin') {
        try {
          const cs = await fetchCandles(sym, '1m', 2);
          const price = cs.at(-1)?.close || 0;
          await sendTG(token, chatId,
`🪙 현재 코인: <b>${sym}</b>
💰 현재가: $${price.toLocaleString('en-US', { maximumFractionDigits: 1 })}
🕐 ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
        } catch { await sendTG(token, chatId, '❌ 가격 조회 실패'); }

      } else {
        await sendTG(token, chatId, '❓ 알 수 없는 명령어\n/help 를 입력해보세요!');
      }
    } catch (e) {
      console.error('핸들러 오류:', e);
      await sendTG(token, chatId, `❌ 오류 발생: ${e.message}`);
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
