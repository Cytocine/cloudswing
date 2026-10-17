// Cytocine cloud scanner: same 30m BUY/SELL rules as the app, run by GitHub Actions. Alerts go to Discord and/or ntfy (phone push).
import fs from 'node:fs';
const E=process.env,KEY=E.ALPACA_KEY,SEC=E.ALPACA_SECRET,ACCT=+E.ACCT||25000,RISK=+E.RISK_PCT||0.5,MAXPOS=+E.MAX_POS_PCT||25,GAP=+E.GAP_ATR||0.1,CD=+E.COOLDOWN||10,FEED=E.FEED||'iex';
const WL=(E.WATCHLIST||fs.readFileSync(new URL('./watchlist.txt',import.meta.url),'utf8')).split(/[\s,]+/).filter(Boolean);
if(!KEY||!SEC){console.error('Set ALPACA_KEY and ALPACA_SECRET secrets');process.exit(1)}
const ema=(a,n)=>{const k=2/(n+1);let p;return a.map(x=>{if(isNaN(x))return NaN;p=p===undefined?x:x*k+p*(1-k);return p})};
const linreg=(a,n)=>a.map((_,i)=>{if(i<n-1)return NaN;let sx=0,sy=0,sxy=0,sxx=0;for(let j=0;j<n;j++){const y=a[i-n+1+j];sx+=j;sy+=y;sxy+=j*y;sxx+=j*j}const s=(n*sxy-sx*sy)/(n*sxx-sx*sx);return(sy-s*sx)/n+s*(n-1)});
const atr=(r,n=14)=>{let a=0;return r.map((x,i)=>{const tr=i?Math.max(x.h-x.l,Math.abs(x.h-r[i-1].c),Math.abs(x.l-r[i-1].c)):x.h-x.l;a=i<n?(a*i+tr)/(i+1):(a*(n-1)+tr)/n;return a})};
const TF=E.TF||'30Min',BAR=(TF==='1Hour'?60:30)*6e4,DAYS=TF==='1Hour'?90:45; // scanner timeframe: 30Min | 1Hour
const FLT=E.FILTER||'off',W=FLT==='cloud'?210:110; // same as the app's Signal filter dropdown: off | rise | cloud (Beyond 180/200)
function cond(r){const n=r.length,out=new Array(n).fill(null);if(n<=W)return out;
 const cl=r.map(b=>b.c),hl=r.map(b=>(b.h+b.l)/2),e12=ema(cl,12),e34=ema(cl,34),lr=linreg(cl,80),el=ema(lr,20),h5=ema(hl,5),h12=ema(hl,12),h34=ema(hl,34),h50=ema(hl,50),e180=ema(hl,180),e200=ema(hl,200),AT=atr(r);
 for(let i=W;i<n;i++){const c=cl[i],a=AT[i],test=(lr[i]+el[i])/2;if(![e12[i],e34[i],lr[i],el[i],h5[i],h12[i],h34[i],h50[i],e180[i],e200[i],a].every(isFinite)||!(a>0))continue;
  const g1=(h5[i]-h12[i])/a,g2=(h34[i]-h50[i])/a,tU=lr[i]>el[i],gc=c>e12[i]&&e12[i]>e34[i]&&c>test&&tU,rc=c<e12[i]&&e12[i]<e34[i]&&c<test&&!tU;
  let fb=true,fs=true;if(FLT==='cloud'){fb=c>Math.max(e180[i],e200[i]);fs=c<Math.min(e180[i],e200[i])}else if(FLT==='rise'){const tp=(lr[i-3]+el[i-3])/2;fb=test>tp;fs=test<tp}
  out[i]={px:c,buy:gc&&g1>=GAP&&g2>=GAP&&fb,sell:rc&&-g1>=GAP&&-g2>=GAP&&fs}}return out}
function signals(r){const s=cond(r),n=r.length,out=[];if(n<=W+1)return out;let lastI=-1e9,last=s[W]?(s[W].buy?'buy':s[W].sell?'sell':''):'';
 for(let i=W+1;i<n;i++){const x=s[i];if(!x||i-lastI<=CD)continue;const pv=s[i-1];
  if(x.buy&&!(pv&&pv.buy)&&last!=='buy'){out.push({i,side:'buy',px:x.px});last='buy';lastI=i}
  else if(x.sell&&!(pv&&pv.sell)&&last!=='sell'){out.push({i,side:'sell',px:x.px});last='sell';lastI=i}}return out}
function plan(r,e){const sg=e.side==='buy'?1:-1,a=atr(r)[e.i];let sw=sg>0?Infinity:-Infinity;for(let j=Math.max(0,e.i-7);j<=e.i;j++)sw=sg>0?Math.min(sw,r[j].l):Math.max(sw,r[j].h);
 let risk=sg>0?e.px-(sw-.1*a):(sw+.1*a)-e.px;risk=Math.min(2.5*a,Math.max(a,risk));
 let sh=Math.floor(ACCT*RISK/100/risk);if(MAXPOS>0)sh=Math.min(sh,Math.floor(ACCT*MAXPOS/100/e.px));
 return{stop:e.px-sg*risk,t1:e.px+sg*1.5*risk,t2:e.px+sg*3*risk,sh,risk:sh*risk}}
async function bars(syms){const by={},H={'APCA-API-KEY-ID':KEY,'APCA-API-SECRET-KEY':SEC},st=new Date(Date.now()-DAYS*864e5).toISOString();let tok='';
 do{const u=`https://data.alpaca.markets/v2/stocks/bars?symbols=${syms.join(',')}&timeframe=${TF}&start=${st}&limit=10000&adjustment=split&sort=asc&feed=${FEED}`+(tok?`&page_token=${tok}`:'');
  const res=await fetch(u,{headers:H});if(!res.ok)throw new Error(res.status+' '+(await res.text()).slice(0,200));const j=await res.json();
  for(const k in(j.bars||{}))(by[k]=by[k]||[]).push(...j.bars[k]);tok=j.next_page_token}while(tok);return by}
const SENT='sent.json';let sent={};try{sent=JSON.parse(fs.readFileSync(SENT,'utf8'))}catch{}
const now=Date.now(),msgs=[];let got=0,inBuy=0,inSell=0,newest='';
for(let i=0;i<WL.length;i+=14){const by=await bars(WL.slice(i,i+14));
 for(const k in by){let r=by[k];if(now<Date.parse(r[r.length-1].t)+BAR)r=r.slice(0,-1); // drop the still-forming bar: closed bars only
  got++;{const x=cond(r)[r.length-1];if(x&&x.buy)inBuy++;if(x&&x.sell)inSell++}if(r.length&&r[r.length-1].t>newest)newest=r[r.length-1].t;
  const ev=signals(r),e=ev[ev.length-1];if(!e)continue;const close=Date.parse(r[e.i].t)+BAR;if(now-close>2*BAR)continue;
  const key=`${k}|${e.side}|${r[e.i].t}`;if(sent[key])continue;sent[key]=now;const p=plan(r,e);
  msgs.push(`${e.side.toUpperCase()} ${k} (${TF} bar closed) entry ${e.px.toFixed(2)} stop ${p.stop.toFixed(2)} T1 ${p.t1.toFixed(2)} T2 ${p.t2.toFixed(2)} · ${p.sh} sh, risk $${Math.round(p.risk)}`)}}
for(const k of Object.keys(sent))if(now-sent[k]>3*864e5)delete sent[k];
fs.writeFileSync(SENT,JSON.stringify(sent));
console.log(`${new Date().toISOString()} | ${TF} | filter ${FLT} | ${got}/${WL.length} symbols had bars | newest closed bar ${newest||'none'} | ${inBuy} in BUY state, ${inSell} in SELL state | ${msgs.length} NEW signals`);if(!got)console.log('WARNING: no bars returned. Check keys, feed, or whether the market was open.');msgs.forEach(m=>console.log(m));
if(msgs.length){const text=msgs.join('\n');
 if(E.DISCORD_WEBHOOK)await fetch(E.DISCORD_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'Cytocine Cloud',content:text.slice(0,1900)})});
 if(E.NTFY_TOPIC)await fetch('https://ntfy.sh/'+E.NTFY_TOPIC,{method:'POST',headers:{Title:'Cytocine signal'},body:text})}
