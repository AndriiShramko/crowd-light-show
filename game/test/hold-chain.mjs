// Приёмочный помощник (не тест): поднимает N ботов через /api/join, собирает хоровод и УДЕРЖИВАЕТ
// его подключённым ~HOLD секунд, чтобы можно было снять spectate-кадр цепочки котов.
// Запуск: node game/test/hold-chain.mjs <wssBase> <N> <holdSec>
import { WebSocket } from 'ws';
const BASE = process.argv[2] || 'wss://game.flyreelstudio.eu';
const N = Number(process.argv[3] || 30);
const HOLD = Number(process.argv[4] || 150);
const HTTP = BASE.replace(/^ws/, 'http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class C {
  constructor(){ this.num=null; this.seat=-1; this.tail=null; this.pos=null; }
  async enter(){
    const j = await fetch(`${HTTP}/api/join?room=MAIN`).then(r=>r.json());
    this.ws = new WebSocket(`${BASE}/ws?token=${j.token}`, { perMessageDeflate:false });
    this.ws.binaryType='nodebuffer';
    this.ws.on('message',(d,bin)=>this.onMsg(d,bin));
    await new Promise((res,rej)=>{ this.ws.on('open',res); this.ws.on('error',rej); });
  }
  onMsg(d,bin){
    if(bin){ const cnt=d.readUInt16LE(5); for(let i=0;i<cnt;i++){ const o=7+i*10; if(d.readUInt32LE(o)===this.num) this.pos={x:d.readInt16LE(o+4)/32,z:d.readInt16LE(o+6)/32}; } return; }
    let m; try{ m=JSON.parse(d); }catch{ return; }
    if(m.t==='hello') this.num=m.num;
    if(m.t==='joined') this.seat=m.seat;
    if(m.t==='tail') this.tail=m.tail;
    if(m.t==='err'&&m.code==='too_far') this.tail=m.tail;
  }
  send(o){ if(this.ws.readyState===1) this.ws.send(JSON.stringify(o)); }
}

const cs=[];
console.log(`hold-chain: ${N} cats → ${BASE}, hold ${HOLD}s`);
for(let i=0;i<N;i++){ const c=new C(); await c.enter(); cs.push(c); await sleep(35); }
await sleep(1000);
cs[0].send({t:'join_tail'});                       // первый — голова
const drv=setInterval(()=>{
  const h=cs.find(c=>c.seat===0);
  if(h&&h.pos){ const a=Date.now()/1600; h.send({t:'intent',x:2.4*Math.cos(a)-h.pos.x,z:2.4*Math.sin(a)-h.pos.z}); }
  for(const c of cs){ if(c.seat>=0||!c.pos||!c.tail) continue;
    const d=Math.hypot(c.tail.x-c.pos.x,c.tail.z-c.pos.z);
    if(d<3) c.send({t:'join_tail'}); else c.send({t:'intent',x:(c.tail.x-c.pos.x)/d,z:(c.tail.z-c.pos.z)/d}); }
},200);

// ждём пока прицепятся, логируем прогресс
for(let w=0;w<120;w++){ const a=cs.filter(c=>c.seat>=0).length; if(w%5===0) console.log(`attached ${a}/${N}`); if(a===N) { console.log(`FULL CHAIN ${a}/${N}`); break; } await sleep(500); }
console.log('HOLDING — снимай кадр сейчас');
await sleep(HOLD*1000);
clearInterval(drv);
for(const c of cs) c.ws.close();
console.log('done');
process.exit(0);
