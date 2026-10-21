import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chooseLocal } from './local-ai.mjs';
import { validateBoard, legalMoves, maxTile } from './public/game.mjs';

const source=JSON.parse(readFileSync(new URL('./vendor/nneonneo-2048-ai/SOURCE.json',import.meta.url),'utf8'));
export const NATIVE_VERSION='nneonneo-'+source.commit.slice(0,12)+'-bridge-endless-v2';
export const NATIVE_SEARCH=Object.freeze({depth_policy:'max(3, distinct_nonzero_ranks - 2)',probability_cutoff:0.0001,upstream_commit:source.commit});
export const nativeBinary=fileURLToPath(new URL('./.build/nneonneo-2048',import.meta.url));
export const nativeAvailable=()=>existsSync(nativeBinary);
export function packBoard(board) {
  validateBoard(board);
  if(board.flat().some(n=>n>32768)) throw new Error('原生算法仅支持最大 32768 的方块');
  return board.flat().reduce((packed,n,i)=>packed | (BigInt(n?Math.log2(n):0)<<BigInt(i*4)),0n).toString(16);
}
export function unpackBoard(hex) {
  let value=BigInt('0x'+hex);
  return Array.from({length:4},()=>Array.from({length:4},()=>{const rank=Number(value&15n);value>>=4n;return rank?2**rank:0;}));
}
export function createNativeEngine({binary=nativeBinary,timeout=30000,idleMs=1000}={}) {
  let worker=null, nextId=0, idle;
  const pending=new Map();
  function shutdown(error=new Error('本地算法已停止')) {
    clearTimeout(idle);
    const old=worker;worker=null;
    old?.kill('SIGKILL');
    for(const item of pending.values()) item.reject(error);
    pending.clear();
  }
  function start() {
    if(worker) return worker;
    if(!existsSync(binary)) throw new Error('原生算法尚未编译，请在项目根目录执行 npm run build:native');
    const child=spawn(binary,[],{stdio:['pipe','pipe','ignore'],env:{PATH:process.env.PATH || ''}});
    worker=child;
    child.on('error',()=>{if(worker===child)shutdown(new Error('无法启动原生算法，请重新编译'));});
    child.on('exit',()=>{if(worker===child)shutdown(new Error('原生算法进程意外退出'));});
    child.stdin.on('error',()=>{if(worker===child)shutdown(new Error('原生算法通信失败'));});
    createInterface({input:child.stdout}).on('line',line=>{
      if(worker!==child) return;
      let result;try {result=JSON.parse(line);}catch {shutdown(new Error('原生算法响应格式错误'));return;}
      const item=pending.get(result.id);
      if(!item){shutdown(new Error('原生算法响应编号无效'));return;}
      pending.delete(result.id);item.resolve(result);
      if(!pending.size) idle=setTimeout(()=>shutdown(),idleMs);
    });
    return child;
  }
  function request(board,signal) {
    const packed=packBoard(board);
    signal?.throwIfAborted();
    clearTimeout(idle);
    const child=start(), id=++nextId;
    return new Promise((resolve,reject)=>{
      const abort=()=>shutdown(signal.reason || new Error('本地搜索已取消'));
      const timer=setTimeout(()=>shutdown(new Error('原生算法搜索超时')),timeout);
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      pending.set(id,{resolve:r=>{cleanup();resolve(r);},reject:e=>{cleanup();reject(e);}});
      signal?.addEventListener('abort',abort,{once:true});
      child.stdin.write(`${id} ${packed}\n`);
    });
  }
  return {request,close:shutdown};
}
const engine=createNativeEngine();
export async function chooseNative(board,signal,runner=engine) {
  validateBoard(board);
  const available=legalMoves(board);
  if(!available.length) throw new Error('本局已结束');
  // Upstream uses 4-bit ranks and saturates a merge of two 32768 tiles.
  // Use the JS engine once that rank appears, rather than misrepresenting the board.
  if (maxTile(board) >= 32768) {
    signal?.throwIfAborted();
    const result = chooseLocal(board);
    return { ...result, fallback_from: NATIVE_VERSION, warnings: [{ code: 'native_rank_limit',
      message: '棋盘含 32768 或更大方块，已切换到 JavaScript 搜索以保持合并规则正确；不调用模型 API。' }] };
  }
  const started=performance.now();
  const {id,...raw}=await runner.request(board,signal);
  if(!available.includes(raw.direction) || available.some(d=>!Number.isFinite(raw.scores?.[d]))) throw new Error('原生算法返回无效方向或分数');
  return {...raw,algorithm:NATIVE_VERSION,search:NATIVE_SEARCH,score_kind:'heuristic utility, NOT win probability',
    latency_ms:Math.round((performance.now()-started)*100)/100};
}
export function closeNative(){engine.close();}
