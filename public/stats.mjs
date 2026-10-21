import { renderChart, element, number, duration, money, colorClass, costInCny, FX_SNAPSHOT } from './chart.mjs';
const $=id=>document.getElementById(id), hidden=new Set();
let data, loading=false, fingerprint='';
function small(cell,text){cell.append(element('small','',text));}
function render() {
  if(!data)return;
  const axis=$('axis').value, visible=data.series.filter(s=>!hidden.has(s.key));
  $('axis-note').textContent=axis==='step'?'横轴只累计有效移动；失败重试保留记录，不增加步数。每条曲线到其最后一条记录为止。':axis==='time'?'横轴从首次操作准备开始计时，包含网络、步间等待、重试及中途暂停。不同模式的起点均对齐到 0 秒。':'横轴累计所有已知费用，统一折算人民币，非账单。未知费用不填零、不推算；从首次缺失起改用虚线，后续已知费用继续累计到最新记录。';
  $('legend').replaceChildren(...data.series.map(s=>{
    const button=element('button','');button.type='button';button.setAttribute('aria-pressed',String(!hidden.has(s.key)));
    button.append(element('i','swatch '+colorClass(s.key)),document.createTextNode(s.label));
    button.addEventListener('click',()=>{hidden.has(s.key)?hidden.delete(s.key):hidden.add(s.key);render();});return button;
  }));
  $('empty-state').hidden=!!data.series.length;
  const charts=[];
  if(data.series.length)for(const metric of ['score','max_tile'])charts.push(renderChart(visible,axis,metric,axis==='cost'?'CNY':null));
  $('charts').replaceChildren(...charts);
  $('runs').replaceChildren(...data.series.map(s=>{
    const row=element('tr');const cells=Array.from({length:8},()=>element('td'));row.append(...cells);
    cells[0].append(element('strong','',s.label));small(cells[0],s.models.join(' / ')||'无模型');small(cells[0],s.versions.join(' / '));
    if(s.fallback_events)small(cells[0],`${s.fallback_events} 次原生引擎回退 JavaScript`);
    cells[1].append(document.createTextNode(new Date(s.created_at).toLocaleString('zh-CN',{hour12:false})));
    small(cells[1],`种子 ${s.seed}`);small(cells[1],`对局 ${s.session_id}`);
    cells[2].textContent=number(s.steps);cells[3].textContent=number(s.score);cells[4].textContent=number(s.max_tile);cells[5].textContent=duration(s.elapsed_ms);
    const cny=costInCny(s.costs);
    cells[6].textContent=s.key==='manual'||s.key.startsWith('local:')?'无 API 费用':s.currencies.length&&cny!==null?money(cny,'CNY'):'未知';
    if(s.currencies.includes('USD'))small(cells[6],`原币 ${s.currencies.map(c=>money(s.costs[c],c)).join(' + ')}`);
    if(!s.cost_complete)small(cells[6],`已知小计 · ${s.unknown_costs} 次费用未知${s.pending?` · ${s.pending} 次等待`:''}`);
    cells[7].textContent={target_reached:'达到 2048 · 已完成',game_over:'无路可走 · 已结束',pending:'等待返回或未确认',can_continue:'尚可继续'}[s.status];
    small(cells[7],`${s.attempts} 次尝试 · ${s.failed} 次失败 / 取消 / 丢弃`);
    small(cells[7],s.objectives.length>1?'包含不同目标版本':s.objectives.includes('endless-v1')?'无限挑战':s.objectives.includes('target-2048-v1')?'2048 封顶':'历史版本 · 2048 目标');
    return row;
  }));
  const ex=data.excluded;
  $('scan-summary').textContent=`${data.series.length} 种模式 · 排除 ${ex.mixed} 局混合、${ex.empty} 局空白${ex.invalid+ex.unsupported?`、${ex.invalid+ex.unsupported} 份无效 / 不支持记录`:''}`;
}
async function refresh() {
  if(loading)return;loading=true;$('refresh').disabled=true;
  try {
    const response=await fetch('/api/stats',{signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error('读取失败');
    const next=await response.json();
    const nextFingerprint=JSON.stringify([next.excluded,next.series.map(s=>[s.key,s.session_id,s.saved_at,s.attempts])]);
    data=next;
    if(nextFingerprint!==fingerprint){fingerprint=nextFingerprint;render();}
    $('load-status').textContent=`更新于 ${new Date(data.generated_at).toLocaleTimeString('zh-CN')}`;
  } catch { $('load-status').textContent='无法刷新统计，请检查本地服务后重试。'+(data?'保留上次结果。':''); }
  finally {loading=false;$('refresh').disabled=false;}
}
$('axis').addEventListener('change',render);$('refresh').addEventListener('click',refresh);
const source=element('a','',FX_SNAPSHOT.source);
source.href=FX_SNAPSHOT.url;source.target='_blank';source.rel='noopener noreferrer';
$('fx-note').append(document.createTextNode(`费用统一显示人民币 · 固定参考汇率 1 USD = ${FX_SNAPSHOT.usdToCny} CNY（${FX_SNAPSHOT.accessedOn} 查询，不实时更新，非结算价）。来源：`),source);
setInterval(()=>{if($('auto-refresh').checked&&!document.hidden)refresh();},10000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&$('auto-refresh').checked)refresh();});
refresh();
