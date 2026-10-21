export const palette = {
  manual: '#8d8076', 'llm:direct': '#7a96bd', 'llm:guided': '#4170c3', 'llm:assisted': '#273c76',
  'jev:direct': '#c49b43', 'jev:guided': '#ca761e', 'jev:assisted': '#925025',
  'local:simple': '#9b5b9e', 'local:nneonneo': '#49816b'
};
export const colorClass = key => 'color-' + key.replace(':', '-');
export const number = n => n == null ? '未知' : n.toLocaleString('zh-CN', {maximumFractionDigits:2});
export const duration = ms => ms == null ? '未知' : ms < 60000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.floor(ms / 60000)} 分 ${Math.floor(ms / 1000) % 60} 秒`;
export const money = (amount, currency) => `${currency === 'CNY' ? '¥' : 'US$'}${amount.toFixed(6)}`;
// Fixed display conversion; historical prices and original log amounts stay unchanged.
export const FX_SNAPSHOT = Object.freeze({
  usdToCny: 6.6792, accessedOn: '2026-10-20',
  source: 'Investing.com USD/CNY', url: 'https://www.investing.com/currencies/usd-cny'
});
export function costInCny(costs) {
  if (!costs || !['CNY', 'USD'].every(c => Number.isFinite(costs[c]) && costs[c] >= 0)) return null;
  return costs.CNY + costs.USD * FX_SNAPSHOT.usdToCny;
}
export function projectSeries(series, axis) {
  const result = [];
  for (const point of series.points) {
    const x = axis === 'step' ? point.step : axis === 'time' ? (point.elapsed_ms === null ? null : point.elapsed_ms / 1000) : costInCny(point.known_costs ?? point.costs);
    if (x == null || !Number.isFinite(x)) break;
    result.push({...point,x});
  }
  return result;
}
export function stepPath(points, xScale, yScale, metric) {
  return points.map((p,i) => i ? `H${xScale(p.x)}V${yScale(p[metric])}` : `M${xScale(p.x)},${yScale(p[metric])}`).join('');
}
const svgNS = 'http://www.w3.org/2000/svg';
function svgElement(name, attrs = {}, text) {
  const el = document.createElementNS(svgNS, name);
  for (const [key,value] of Object.entries(attrs)) el.setAttribute(key,value);
  if (text !== undefined) el.textContent = text;
  return el;
}
export function element(tag, className, text) {
  const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el;
}
export function renderChart(series, axis, metric, currency) {
  const title = metric === 'score' ? '得分曲线' : '最大方块曲线';
  const card = element('section','chart-card'); card.append(element('h2','',title + (currency ? ` · ${currency === 'CNY' ? '人民币' : '美元'}` : '')));
  const projected = series.map(s => ({...s, plotted:projectSeries(s,axis)})).filter(s=>s.plotted.length);
  const truncated = projected.filter(s => s.plotted.length < s.points.length).map(s=>s.label);
  const incomplete = axis === 'cost' ? projected.filter(s=>!s.cost_complete).map(s=>s.label) : [];
  const excluded = series.filter(s=>!projected.some(p=>p.key===s.key)).map(s=>s.label);
  const caption = element('p','chart-caption', [axis === 'cost' ? '实线：费用记录完整；虚线：累计已知小计，未含未知费用。空心圆标记首次缺失；零 API 费用模式在 x = 0。' : '移动指针、点击或使用左右方向键查看记录。',
    incomplete.length ? `${incomplete.join('、')}已接续到末条记录，费用不完整，不能按相同实际预算比较。` : '',
    truncated.length ? `${truncated.join('、')}存在缺失数据，仅绘制完整前缀。` : '',
    excluded.length ? `${excluded.join('、')}未纳入此图（无有效数据）。` : ''].filter(Boolean).join(' '));
  card.append(caption);
  if (!projected.length) {card.append(element('p','chart-empty','没有可绘制的数据，请选择模式或等待日志保存。'));return card;}
  const w=800,h=400,left=78,right=24,top=26,bottom=58;
  const maxX=Math.max(...projected.map(s=>s.plotted.at(-1).x),0), maxY=projected.reduce((max,s)=>s.plotted.reduce((m,p)=>Math.max(m,p[metric]),max),1);
  const boundX=maxX || 1, boundY=maxY * 1.08;
  const xScale=x=>left+x/boundX*(w-left-right), yScale=y=>h-bottom-y/boundY*(h-top-bottom);
  const chart=svgElement('svg',{viewBox:`0 0 ${w} ${h}`,class:'chart',role:'img',tabindex:'0','aria-label':`${title}，横轴${axis === 'step' ? '有效步数' : axis === 'time' ? '经过秒数' : currency+'估算费用'}；使用左右方向键查看详情`});
  for(let i=0;i<=4;i++) {
    const y=maxY*i/4;
    chart.append(svgElement('line',{x1:left,y1:yScale(y),x2:w-right,y2:yScale(y),class:'grid'}),svgElement('text',{x:left-12,y:yScale(y)+4,'text-anchor':'end'},number(Math.round(y))));
    const x=boundX*i/4;
    chart.append(svgElement('text',{x:xScale(x),y:h-bottom+26,'text-anchor':i===4?'end':'middle'},axis==='cost'?x.toFixed(6):number(x)));
  }
  chart.append(svgElement('text',{x:(left+w-right)/2,y:h-8,'text-anchor':'middle'},axis==='step'?'有效步数':axis==='time'?'经过时间 / 秒':`累计已知 API 费用（估算）/ ${currency}`));
  for(const s of projected) {
    const gap=axis==='cost'?s.plotted.findIndex(p=>p.cost_complete===false):-1;
    const draw=(points,dash)=>chart.append(svgElement('path',{d:stepPath(points,xScale,yScale,metric),class:'series-line',stroke:palette[s.key],'stroke-dasharray':dash}));
    if(gap<0) draw(s.plotted,axis==='cost'?'none':s.key.endsWith(':direct')?'7 4':s.key.endsWith(':guided')?'3 3':'none');
    else {
      draw(s.plotted.slice(0,gap),'none');
      draw(s.plotted.slice(Math.max(0,gap-1)),'8 5');
      const p=s.plotted[gap], marker=svgElement('circle',{cx:xScale(p.x),cy:yScale(p[metric]),r:6,fill:'white',stroke:palette[s.key],'stroke-width':2});
      marker.append(svgElement('title',{},`${s.label} · 第 ${p.step} 步后出现费用缺失，后续为已知小计`));chart.append(marker);
    }
    const last=s.plotted.at(-1);const circle=svgElement('circle',{cx:xScale(last.x),cy:yScale(last[metric]),r:4,fill:palette[s.key]});
    circle.append(svgElement('title',{},`${s.label} · ${number(last[metric])}`));chart.append(circle);
  }
  const cursor=svgElement('line',{x1:left,x2:left,y1:top,y2:h-bottom,class:'cursor'});chart.append(cursor);
  const detail=element('div','chart-detail');
  const positions=[...new Set(projected.flatMap(s=>s.plotted.map(p=>p.x)))].sort((a,b)=>a-b);
  let selected=positions.length-1;
  function inspect(x) {
    cursor.setAttribute('x1',xScale(x));cursor.setAttribute('x2',xScale(x));
    detail.replaceChildren(element('div','chart-detail-title',axis==='step'?`第 ${number(x)} 步`:axis==='time'?`经过 ${duration(x*1000)}`:`累计已知费用坐标 ${money(x,currency)}`));
    for(const s of projected) {
      let lo=0,hi=s.plotted.length;
      while(lo<hi){const mid=(lo+hi)>>>1;if(s.plotted[mid].x<=x)lo=mid+1;else hi=mid;}
      const p=s.plotted[Math.max(0,lo-1)];const row=element('div','chart-detail-row');const label=element('span','chart-detail-label');
      label.append(element('i','swatch '+colorClass(s.key)),document.createTextNode(s.label));
      const costNote=axis==='cost'?` · ${money(p.x,currency)}${p.cost_complete===false?` 已知小计（${p.unknown_costs || 0} 次未知${p.pending_costs?` / ${p.pending_costs} 次等待`:''}）`:''}`:'';
      row.append(label,element('span','',`${number(p[metric])}${metric==='score'?' 分':''} · 第 ${p.step} 步${costNote}${x>s.plotted.at(-1).x?' · 末条记录':''}`));detail.append(row);
    }
  }
  function atPointer(event) {
    const box=chart.getBoundingClientRect(), raw=(event.clientX-box.left)/box.width*w;
    const value=Math.max(0,Math.min(boundX,(raw-left)/(w-left-right)*boundX));
    let lo=0,hi=positions.length;while(lo<hi){const mid=(lo+hi)>>>1;if(positions[mid]<value)lo=mid+1;else hi=mid;}
    selected=Math.min(lo,positions.length-1); if(selected>0 && Math.abs(positions[selected-1]-value)<Math.abs(positions[selected]-value))selected--;
    inspect(positions[selected]);
  }
  chart.addEventListener('pointermove',atPointer);chart.addEventListener('click',atPointer);
  chart.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();selected=event.key==='Home'?0:event.key==='End'?positions.length-1:Math.max(0,Math.min(positions.length-1,selected+(event.key==='ArrowRight'?1:-1)));inspect(positions[selected]);});
  inspect(positions[selected]);card.append(chart,detail);return card;
}
