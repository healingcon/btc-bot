// BTC 차트 텔레그램 봇 — Vercel 서버리스
// 15m/1h/4h 가중통합 + 200EMA + RSI다이버전스 + BB스퀴즈 + 펀딩레이트 + 롱숏비율

const FAPI      = 'https://fapi.binance.com/fapi/v1';
const TFS       = ['15m','1h','4h'];
const TF_LABELS = {'15m':'15분봉','1h':'1시간봉','4h':'4시간봉'};
const TF_ROLE   = {'15m':'진입타이밍','1h':'중기방향','4h':'큰추세'};
const TF_WEIGHT = {'15m':1.0,'1h':2.0,'4h':3.0};

// ── 텔레그램 발송 ─────────────────────────────────────────
async function sendTG(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id:chatId, text, parse_mode:'HTML'})
  });
}

// ── Binance 데이터 ────────────────────────────────────────
async function fetchCandles(sym, interval, limit=220) {
  const r=await fetch(`${FAPI}/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);
  const d=await r.json();
  if(!Array.isArray(d)) throw new Error('캔들 오류');
  return d.map(k=>({time:+k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4],vol:+k[5]}))
    .filter(c=>c.open>0&&c.close>0&&c.high>=c.low);
}

async function fetchFundingRate(sym) {
  try{
    const r=await fetch(`${FAPI}/premiumIndex?symbol=${sym}`);
    const d=await r.json();
    return d.lastFundingRate!==undefined ? +d.lastFundingRate*100 : null;
  }catch(e){return null;}
}

async function fetchLSRatio(sym) {
  try{
    const r=await fetch(`${FAPI}/globalLongShortAccountRatio?symbol=${sym}&period=5m&limit=1`);
    const d=await r.json();
    if(Array.isArray(d)&&d.length) return {longPct:+d[0].longAccount*100, shortPct:+d[0].shortAccount*100};
    return null;
  }catch(e){return null;}
}

// ── 지표 계산 ─────────────────────────────────────────────
function emaArr(arr,p){
  const k=2/(p+1),res=[arr[0]];
  for(let i=1;i<arr.length;i++) res.push(arr[i]*k+res[i-1]*(1-k));
  return res;
}

function calcRSI(closes,p=14){
  if(closes.length<p+2) return 50;
  let ag=0,al=0;
  for(let i=closes.length-p;i<closes.length;i++){const d=closes[i]-closes[i-1];d>=0?ag+=d:al-=d;}
  ag/=p;al/=p; return al===0?100:100-100/(1+ag/al);
}

function calcRSIArr(closes,p=14){
  const res=new Array(closes.length).fill(null);
  if(closes.length<p+2) return res;
  let ag=0,al=0;
  for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1];d>=0?ag+=d:al-=d;}
  ag/=p;al/=p;
  res[p]=al===0?100:100-100/(1+ag/al);
  for(let i=p+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    ag=(ag*(p-1)+(d>0?d:0))/p;
    al=(al*(p-1)+(d<0?-d:0))/p;
    res[i]=al===0?100:100-100/(1+ag/al);
  }
  return res;
}

function calcMACD(closes){
  if(closes.length<35) return {hist:0,crossUp:false,crossDn:false,histExpanding:false};
  const e12=emaArr(closes,12),e26=emaArr(closes,26);
  const ml=e12.map((v,i)=>v-e26[i]),sl=emaArr(ml,9);
  const n=ml.length-1,m=ml[n],s=sl[n];
  return{hist:m-s,crossUp:ml[n-1]<=sl[n-1]&&m>s,crossDn:ml[n-1]>=sl[n-1]&&m<s,
    histExpanding:Math.abs(m-s)>Math.abs(ml[n-1]-sl[n-1])};
}

function calcBB(closes,p=20){
  if(closes.length<p) return null;
  const sl=closes.slice(-p),ma=sl.reduce((a,b)=>a+b)/p;
  const std=Math.sqrt(sl.reduce((s,v)=>s+(v-ma)**2,0)/p);
  const last=closes[closes.length-1];
  const bandwidth=(4*std)/ma;
  let avgBW=bandwidth;
  if(closes.length>=p+20){
    const bws=[];
    for(let i=p;i<p+20;i++){
      const s2=closes.slice(i-p,i),m2=s2.reduce((a,b)=>a+b)/p;
      const sd=Math.sqrt(s2.reduce((a,v)=>a+(v-m2)**2,0)/p);
      bws.push((4*sd)/m2);
    }
    avgBW=bws.reduce((a,b)=>a+b)/bws.length;
  }
  return{upper:ma+2*std,mid:ma,lower:ma-2*std,
    pct:Math.max(0,Math.min(100,((last-(ma-2*std))/(4*std||1))*100)),
    aboveMid:last>ma, bandwidth, avgBandwidth:avgBW};
}

function calcMASimple(closes,p){
  return closes.map((_,i)=>{
    if(i<p-1) return null;
    return closes.slice(i-p+1,i+1).reduce((a,b)=>a+b)/p;
  });
}

// ── 종합 신호 계산 ────────────────────────────────────────
function calcSignal(candles){
  if(candles.length<30) return {score:0,dir:'neutral',sigs:[]};
  const closes=candles.map(c=>c.close),last=candles[candles.length-1],n=closes.length;
  const rsi=calcRSI(closes),macd=calcMACD(closes),bb=calcBB(closes);
  const e9a=emaArr(closes,9),e21a=emaArr(closes,21),e55a=emaArr(closes,Math.min(55,n));
  const e9=e9a[e9a.length-1],e21=e21a[e21a.length-1],e55=e55a[e55a.length-1];
  let score=0;const sigs=[];

  // 200 EMA
  if(candles.length>=200){
    const e200a=emaArr(closes,200),e200=e200a[e200a.length-1];
    if(last.close>e200){score+=25;sigs.push({name:'200EMA 위(강세)',dir:'buy',cat:'200EMA'});}
    else{score-=25;sigs.push({name:'200EMA 아래(약세)',dir:'sell',cat:'200EMA'});}
  } else if(candles.length>=55){
    if(last.close>e55){score+=12;sigs.push({name:'55EMA 위',dir:'buy',cat:'200EMA'});}
    else{score-=12;sigs.push({name:'55EMA 아래',dir:'sell',cat:'200EMA'});}
  }

  // EMA 배열
  if(e9>e21&&e21>e55&&last.close>e9){score+=30;sigs.push({name:'EMA 정배열',dir:'buy',cat:'추세'});}
  else if(e9>e21&&e21>e55){score+=18;sigs.push({name:'EMA 상승배열',dir:'buy',cat:'추세'});}
  else if(e9<e21&&e21<e55&&last.close<e9){score-=30;sigs.push({name:'EMA 역배열',dir:'sell',cat:'추세'});}
  else if(e9<e21&&e21<e55){score-=18;sigs.push({name:'EMA 하락배열',dir:'sell',cat:'추세'});}
  else{score+=e9>e21?8:-8;}

  // MACD
  if(macd.crossUp){score+=30;sigs.push({name:'MACD 골든크로스',dir:'buy',cat:'MACD'});}
  else if(macd.crossDn){score-=30;sigs.push({name:'MACD 데드크로스',dir:'sell',cat:'MACD'});}
  else if(macd.hist>0&&macd.histExpanding){score+=18;sigs.push({name:'MACD 상승확장',dir:'buy',cat:'MACD'});}
  else if(macd.hist<0&&macd.histExpanding){score-=18;sigs.push({name:'MACD 하락확장',dir:'sell',cat:'MACD'});}
  else{score+=macd.hist>0?8:-8;}

  // RSI + 다이버전스
  if(rsi>50&&rsi<72){score+=10;sigs.push({name:`RSI ${rsi.toFixed(1)} 강세권`,dir:'buy',cat:'RSI'});}
  else if(rsi<50&&rsi>28){score-=10;sigs.push({name:`RSI ${rsi.toFixed(1)} 약세권`,dir:'sell',cat:'RSI'});}
  else if(rsi>=72){score+=4;sigs.push({name:`RSI ${rsi.toFixed(1)} 과열`,dir:'caution',cat:'RSI'});}
  else if(rsi<=28){score-=4;sigs.push({name:`RSI ${rsi.toFixed(1)} 침체`,dir:'caution',cat:'RSI'});}

  // RSI 다이버전스
  if(candles.length>=28){
    const rsiArr=calcRSIArr(closes,14);
    const rc=candles.slice(-14),rr=rsiArr.slice(-14);
    const pl1=Math.min(...rc.slice(0,7).map(c=>c.low)),pl2=Math.min(...rc.slice(7).map(c=>c.low));
    const rl1=Math.min(...rr.slice(0,7).filter(v=>v!==null)),rl2=Math.min(...rr.slice(7).filter(v=>v!==null));
    if(pl2<pl1&&rl2>rl1&&rsi<45){score+=28;sigs.push({name:'RSI 강세 다이버전스',dir:'buy',cat:'RSI'});}
    const ph1=Math.max(...rc.slice(0,7).map(c=>c.high)),ph2=Math.max(...rc.slice(7).map(c=>c.high));
    const rh1=Math.max(...rr.slice(0,7).filter(v=>v!==null)),rh2=Math.max(...rr.slice(7).filter(v=>v!==null));
    if(ph2>ph1&&rh2<rh1&&rsi>55){score-=28;sigs.push({name:'RSI 약세 다이버전스',dir:'sell',cat:'RSI'});}
  }

  // BB
  if(bb){
    if(bb.pct<=8){score+=20;sigs.push({name:'BB 하단 터치',dir:'buy',cat:'BB'});}
    else if(bb.pct>=92){score-=20;sigs.push({name:'BB 상단 터치',dir:'sell',cat:'BB'});}
    else if(bb.aboveMid&&bb.pct>45){score+=10;sigs.push({name:`BB ${bb.pct.toFixed(0)}% 중상단`,dir:'buy',cat:'BB'});}
    else if(!bb.aboveMid&&bb.pct<55){score-=10;sigs.push({name:`BB ${bb.pct.toFixed(0)}% 중하단`,dir:'sell',cat:'BB'});}
    if(bb.bandwidth<bb.avgBandwidth*0.6){sigs.push({name:'BB 스퀴즈(폭발임박)',dir:'caution',cat:'BB'});}
  }

  // 거래량
  if(candles.length>=20){
    const vols=candles.slice(-20).map(c=>c.vol);
    const avg=vols.reduce((a,b)=>a+b)/vols.length;
    const ratio=last.vol/(avg||1);
    if(ratio>=3){
      if(last.close>=last.open){score+=25;sigs.push({name:`거래량 급증 ×${ratio.toFixed(1)}`,dir:'buy',cat:'거래량'});}
      else{score-=25;sigs.push({name:`거래량 급증 ×${ratio.toFixed(1)}`,dir:'sell',cat:'거래량'});}
    } else if(ratio>=2){
      if(last.close>=last.open){score+=12;sigs.push({name:`거래량 증가 ×${ratio.toFixed(1)}`,dir:'buy',cat:'거래량'});}
      else{score-=12;sigs.push({name:`거래량 증가 ×${ratio.toFixed(1)}`,dir:'sell',cat:'거래량'});}
    }
    const r10=candles.slice(-10);
    let bv=0,sv=0;
    r10.forEach(c=>c.close>=c.open?bv+=c.vol:sv+=c.vol);
    const bp=bv/(bv+sv)*100;
    if(bp>=65){score+=15;sigs.push({name:`매수압 ${bp.toFixed(0)}%`,dir:'buy',cat:'거래량'});}
    else if(bp<=35){score-=15;sigs.push({name:`매도압 ${(100-bp).toFixed(0)}%`,dir:'sell',cat:'거래량'});}
  }

  // MA20/60
  if(candles.length>=62){
    const ma20=calcMASimple(closes,20),ma60=calcMASimple(closes,60);
    const m20=ma20[n-1],m20p=ma20[n-2],m60=ma60[n-1],m60p=ma60[n-2];
    if(m20&&m60&&m20p&&m60p){
      if(m20>m60&&m20p<=m60p){score+=35;sigs.push({name:'MA20/60 골든크로스',dir:'buy',cat:'MA크로스'});}
      else if(m20<m60&&m20p>=m60p){score-=35;sigs.push({name:'MA20/60 데드크로스',dir:'sell',cat:'MA크로스'});}
      else if(m20>m60&&last.close>m20){score+=18;sigs.push({name:'MA 정배열',dir:'buy',cat:'MA크로스'});}
      else if(m20<m60&&last.close<m60){score-=18;sigs.push({name:'MA 역배열',dir:'sell',cat:'MA크로스'});}
    }
  }

  const dir=score>=20?'buy':score<=-20?'sell':'neutral';
  return {score,dir,sigs,rsi};
}

// ── 5단계 롱/숏 레벨 판단 ────────────────────────────────
function getLongShortLevel(results, fundingRate, lsRatio){
  const h4=results['4h'],h1=results['1h'],m15=results['15m'];
  const h4long =h4?.dir==='buy' &&h4?.score>=30;
  const h4short=h4?.dir==='sell'&&h4?.score<=-30;
  const h1long =h1?.dir==='buy' &&h1?.score>=25;
  const h1short=h1?.dir==='sell'&&h1?.score<=-25;
  const m15long =m15?.dir==='buy' &&m15?.score>=20;
  const m15short=m15?.dir==='sell'&&m15?.score<=-20;

  // 거래량 방향
  const m15volBuy  = m15?.sigs?.find(s=>s.cat==='거래량'&&s.dir==='buy');
  const m15volSell = m15?.sigs?.find(s=>s.cat==='거래량'&&s.dir==='sell');
  const h1volBuy   = h1?.sigs?.find(s=>s.cat==='거래량'&&s.dir==='buy');
  const h1volSell  = h1?.sigs?.find(s=>s.cat==='거래량'&&s.dir==='sell');

  function calcConf(isLong){
    let c=0;
    if(isLong){if(h4long)c+=35;if(h1long)c+=25;if(m15long)c+=15;}
    else{if(h4short)c+=35;if(h1short)c+=25;if(m15short)c+=15;}
    // 거래량
    if(isLong){if(m15volBuy)c+=12;if(h1volBuy)c+=8;if(m15volSell)c-=8;}
    else{if(m15volSell)c+=12;if(h1volSell)c+=8;if(m15volBuy)c-=8;}
    // 펀딩레이트
    if(fundingRate!==null){
      if(isLong&&fundingRate<-0.05)c+=12;
      if(isLong&&fundingRate>0.10)c-=10;
      if(!isLong&&fundingRate>0.05)c+=12;
      if(!isLong&&fundingRate<-0.10)c-=10;
    }
    // 롱숏비율
    if(lsRatio){
      if(isLong&&lsRatio.shortPct>65)c+=10;
      if(isLong&&lsRatio.longPct>80)c-=8;
      if(!isLong&&lsRatio.longPct>65)c+=10;
      if(!isLong&&lsRatio.shortPct>80)c-=8;
    }
    return Math.max(0,Math.min(100,Math.round(c)));
  }

  if(h4long&&h1long&&m15long&&calcConf(true)>=70)
    return{level:2,label:'🚀 강한 롱',sublabel:'LONG ●●●',action:'진입 검토',conf:calcConf(true)};
  if(h4long&&h1long&&!m15long)
    return{level:1,label:'📈 롱 대기',sublabel:'LONG ●●○',action:'15m 롱 전환 시 진입',conf:calcConf(true)};
  if(h4long&&!h1short)
    return{level:0.5,label:'📊 롱 준비',sublabel:'LONG ●○○',action:'1h 방향 확인 후 판단',conf:calcConf(true)};
  if(h4short&&h1short&&m15short&&calcConf(false)>=70)
    return{level:-2,label:'💀 강한 숏',sublabel:'SHORT ●●●',action:'숏 진입 검토',conf:calcConf(false)};
  if(h4short&&h1short&&!m15short)
    return{level:-1,label:'📉 숏 대기',sublabel:'SHORT ●●○',action:'15m 숏 전환 시 진입',conf:calcConf(false)};
  if(h4short&&!h1long)
    return{level:-0.5,label:'📊 숏 준비',sublabel:'SHORT ●○○',action:'1h 방향 확인 후 판단',conf:calcConf(false)};
  return{level:0,label:'⏸ 관망',sublabel:'WAIT',action:'방향 불일치 — 대기',conf:0};
}

// ── 시황 리포트 빌드 ──────────────────────────────────────
function fmtP(p){return p>=1000?p.toLocaleString('en-US',{maximumFractionDigits:1}):p.toFixed(4);}
function confBar(c){return '█'.repeat(Math.floor(c/10))+'░'.repeat(10-Math.floor(c/10));}

async function buildReport(sym){
  const results={};
  const [,,fundingRate,lsRatio] = await Promise.all([
    Promise.allSettled(TFS.map(async tf=>{
      try{const cs=await fetchCandles(sym,tf);const sg=calcSignal(cs);results[tf]={...sg,price:cs[cs.length-1].close};}catch(e){}
    })),
    Promise.resolve(),
    fetchFundingRate(sym),
    fetchLSRatio(sym)
  ]);

  const sig=getLongShortLevel(results,fundingRate,lsRatio);
  const price=results['15m']?.price||results['1h']?.price||0;

  const tfLines=TFS.map(t=>{
    const r=results[t];if(!r)return`${TF_LABELS[t]}: ❓`;
    const isL=r.dir==='buy'&&r.score>=20;
    const isS=r.dir==='sell'&&r.score<=-20;
    const icon=isL?'🟢':isS?'🔴':'🟡';
    const dir=isL?'LONG':isS?'SHORT':'중립';
    return`${icon} ${TF_LABELS[t]} — ${TF_ROLE[t]}: ${dir} ${Math.abs(r.score)}점`;
  }).join('\n');

  const allSigs=[];
  TFS.forEach(t=>{results[t]?.sigs?.slice(0,2).forEach(s=>{if(!allSigs.find(x=>x.name===s.name))allSigs.push({...s,tf:TF_LABELS[t]});});});
  const topSigs=allSigs.slice(0,6).map(s=>`• [${s.tf}] ${s.name}`).join('\n');

  const frLine=fundingRate!==null?`\n💸 펀딩레이트: <b>${fundingRate.toFixed(4)}%</b>${fundingRate>0.1?' 🔥롱과열':fundingRate<-0.1?' 🧊숏과열':fundingRate>0.05?' ↑롱우세':fundingRate<-0.05?' ↓숏우세':' ≈중립'}`:'';
  const lsLine=lsRatio?`\n📊 롱/숏: 🟢${lsRatio.longPct.toFixed(0)}% / 🔴${lsRatio.shortPct.toFixed(0)}%${lsRatio.longPct>80?' ⚠롱과열':lsRatio.shortPct>80?' ⚠숏과열':''}`:'';

  return`📊 <b>${sym} 시황 리포트</b>
🕐 ${new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}

💰 현재가: <b>$${fmtP(price)}</b>
🎯 신호: <b>${sig.label}</b>  <code>${sig.sublabel}</code>
📊 신뢰도: <b>${sig.conf}%</b>  [${confBar(sig.conf)}]
💡 행동: <i>${sig.action}</i>${frLine}${lsLine}

⏰ <b>타임프레임 분석</b>
${tfLines}

📋 <b>주요 신호</b>
${topSigs}

⚠️ <i>참고용 · 투자 결정은 본인 책임</i>`;
}

// ── /tf 상세 분석 ─────────────────────────────────────────
async function buildTFReport(sym){
  const results={};
  const [,,fr,ls]=await Promise.all([
    Promise.allSettled(TFS.map(async tf=>{
      try{const cs=await fetchCandles(sym,tf,220);const sg=calcSignal(cs);results[tf]={...sg,price:cs[cs.length-1].close};}catch(e){}
    })),
    Promise.resolve(),
    fetchFundingRate(sym),
    fetchLSRatio(sym)
  ]);
  const sig=getLongShortLevel(results,fr,ls);
  const price=results['15m']?.price||0;

  const lines=TFS.map(t=>{
    const r=results[t];if(!r)return`${TF_LABELS[t]}: 오류`;
    const isL=r.dir==='buy'&&r.score>=20;
    const isS=r.dir==='sell'&&r.score<=-20;
    const icon=isL?'🟢':isS?'🔴':'🟡';
    const dir=isL?'LONG':isS?'SHORT':'중립';
    const topSig=r.sigs?.slice(0,2).map(s=>s.name).join(', ')||'—';
    return`${icon} <b>${TF_LABELS[t]}</b> (${TF_ROLE[t]})\n   ${dir} ${Math.abs(r.score)}점\n   └ ${topSig}`;
  });

  const frTxt=fr!==null?`펀딩: ${fr.toFixed(4)}%`:'펀딩: —';
  const lsTxt=ls?`롱/숏: ${ls.longPct.toFixed(0)}%/${ls.shortPct.toFixed(0)}%`:'롱/숏: —';

  return`📊 <b>${sym} 타임프레임 분석</b>
💰 $${fmtP(price)}

${lines.join('\n\n')}

━━━━━━━━━━━━━━━
🎯 <b>${sig.label}</b>  <code>${sig.sublabel}</code>
📊 신뢰도: ${sig.conf}% [${confBar(sig.conf)}]
💡 ${sig.action}
${frTxt}  |  ${lsTxt}
🕐 ${new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}`;
}

// ── 메인 핸들러 ───────────────────────────────────────────
export default async function handler(req,res){
  const token=process.env.TG_TOKEN;
  const chatId=process.env.TG_CHAT_ID;
  const sym=process.env.COIN||'BTCUSDT';
  if(!token||!chatId) return res.status(400).json({error:'환경변수 없음'});

  // GET: 5분 자동 발송 (GitHub Actions 크론)
  if(req.method==='GET'){
    try{await sendTG(token,chatId,await buildReport(sym));return res.status(200).json({ok:true});}
    catch(e){return res.status(500).json({error:e.message});}
  }

  // POST: Webhook 명령어 처리
  if(req.method==='POST'){
    const msg=req.body?.message;
    if(!msg) return res.status(200).json({ok:true});
    if(String(msg.chat.id)!==String(chatId)) return res.status(200).json({ok:true});
    const text=(msg.text||'').trim().toLowerCase();

    try{
      if(text==='/status'||text==='/시황'){
        await sendTG(token,chatId,'⏳ 분석 중... (15m/1h/4h + 펀딩레이트 + 롱숏비율)');
        await sendTG(token,chatId,await buildReport(sym));

      }else if(text==='/tf'){
        await sendTG(token,chatId,'⏳ 타임프레임 분석 중...');
        await sendTG(token,chatId,await buildTFReport(sym));

      }else if(text==='/help'||text==='/도움말'){
        await sendTG(token,chatId,
`📋 <b>명령어 목록</b>

/status 또는 /시황
→ 현재 시황 즉시 조회

/tf
→ 15m/1h/4h 상세 분석 + 펀딩레이트

/coin
→ 현재 분석 코인 확인

/help
→ 이 메시지

━━━━━━━━━━━━━━━
📊 <b>신호 종류</b>
🚀 강한 롱  (LONG ●●●) 신뢰도 70%+
📈 롱 대기  (LONG ●●○) 4h+1h 롱
📊 롱 준비  (LONG ●○○) 4h만 롱
📉 숏 대기  (SHORT ●●○) 4h+1h 숏
💀 강한 숏  (SHORT ●●●) 신뢰도 70%+
⏸ 관망      (WAIT)

📌 신뢰도 = 4h추세+1h방향+15m타이밍
           + 거래량+펀딩레이트+롱숏비율

⏰ 자동 발송: 5분마다`);

      }else if(text==='/coin'){
        try{
          const cs=await fetchCandles(sym,'15m',2);
          const p=cs.at(-1)?.close||0;
          const fr=await fetchFundingRate(sym);
          const ls=await fetchLSRatio(sym);
          await sendTG(token,chatId,
`🪙 <b>${sym}</b>
💰 $${fmtP(p)}
💸 펀딩레이트: ${fr!==null?fr.toFixed(4)+'%':'—'}
📊 롱/숏: ${ls?`${ls.longPct.toFixed(0)}% / ${ls.shortPct.toFixed(0)}%`:'—'}
🕐 ${new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}`);
        }catch(e){await sendTG(token,chatId,'❌ 조회 실패');}

      }else{
        await sendTG(token,chatId,'❓ 모르는 명령어\n/help 를 입력해보세요!');
      }
    }catch(e){
      console.error('오류:',e);
      await sendTG(token,chatId,`❌ 오류: ${e.message}`);
    }
    return res.status(200).json({ok:true});
  }
  return res.status(405).json({error:'Method not allowed'});
}
