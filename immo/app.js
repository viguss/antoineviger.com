const $ = (id) => document.getElementById(id);
const integer = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const money = (n) => n == null ? 'Non renseigné' : `${integer.format(n)} €`;
const date = (s) => new Date(`${s}T12:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
const emptyGeo = () => ({ type: 'FeatureCollection', features: [] });
let data = null, map = null, mapReady = false, filtered = [], page = 0;
const size = 50;
let boundsFilter = null;
function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (className) n.className = className;
  return n;
}
function ratio(s) {
  return s.valid_ppsqm && s.price_eur > 0 && s.surface_m2 > 0 ? s.price_eur / s.surface_m2 : null;
}
function showDetails(s) {
  $('detail-title').textContent = money(s.price_eur);
  const content = $('detail-content');
  content.replaceChildren();
  const dl = node('dl');
  const entries = [
    ['Date de mutation', date(s.transaction_date)],
    ['Type', s.property_type], ['Nature', s.sale_kind],
    ['Surface appartements', s.surface_m2 == null ? 'Non renseignée' : `${s.surface_m2} m²`],
    ['Prix/m²', ratio(s) == null ? 'Exclu — voir motif ci-dessous' : `${money(ratio(s))} / m²`],
    ['Localisation', 'Centroïde cadastral, position approximative'],
    ['Identifiant source', s.source_mutation_id],
    ['Millésime', data.dataset_version], ['Licence', data.license],
    ['Publication de cet extrait', date(data.published_on)],
  ];
  for (const [name, value] of entries) dl.append(node('dt', name), node('dd', value));
  content.append(dl, node('p', s.valid_ppsqm
    ? 'Prix/m² calculable selon les règles conservatrices de cet aperçu. La surface fiscale n’est pas une surface Carrez certifiée ; ce ratio historique n’est pas une estimation du marché actuel.'
    : `Motif d’exclusion : ${s.exclusion_reason || 'Qualité insuffisante'}`, 'reason'));
  content.append(node('p', 'Le montant concerne la mutation entière. Le point ne prouve pas l’emplacement exact d’un appartement.', 'muted'));
  $('details').showModal();
}
function render() {
  $('count').textContent = integer.format(filtered.length);
  const ratios = filtered.map(ratio).filter((n) => n != null).sort((a,b) => a-b);
  $('qualified').textContent = integer.format(ratios.length);
  const median = ratios.length % 2 ? ratios[Math.floor(ratios.length/2)] : (ratios[ratios.length/2-1] + ratios[ratios.length/2])/2;
  $('median').replaceChildren();
  if (ratios.length >= 5) $('median').append(document.createTextNode(money(median)), node('small', '/ m²'));
  else $('median').append(node('small', 'Effectif insuffisant (< 5)'));
  const maxPage = Math.max(0, Math.ceil(filtered.length / size)-1);
  page = Math.min(page, maxPage);
  const rows = filtered.slice(page*size, (page+1)*size);
  $('rows').replaceChildren();
  for (const s of rows) {
    const tr = node('tr');
    tr.append(node('td', date(s.transaction_date)), node('td', s.property_type), node('td', money(s.price_eur)), node('td', s.surface_m2 == null ? '—' : `${s.surface_m2} m²`));
    const quality = node('td');
    quality.append(node('span', s.valid_ppsqm ? 'Prix/m² qualifié' : 'Prix/m² exclu', `badge${s.valid_ppsqm ? ' valid' : ''}`));
    const action = node('td');
    const button = node('button', 'Détails →');
    button.setAttribute('aria-label', `Détails de la mutation du ${date(s.transaction_date)} à ${money(s.price_eur)}`);
    button.addEventListener('click', () => showDetails(s));
    action.append(button); tr.append(quality, action); $('rows').append(tr);
  }
  $('empty').hidden = filtered.length !== 0;
  $('list-count').textContent = `${rows.length} affichées sur ${integer.format(filtered.length)} · carte : tous les résultats filtrés`;
  $('page-label').textContent = `Page ${page+1} / ${maxPage+1}`;
  $('previous').disabled = page === 0;
  $('next').disabled = page >= maxPage;
  if (mapReady) map.getSource('sales').setData({ type: 'FeatureCollection', features: filtered.map((s) => ({ type:'Feature', geometry:{type:'Point',coordinates:[s.lon,s.lat]}, properties:{id:s.id,qualified:s.valid_ppsqm} })) });
  $('map').dataset.filteredSales = String(filtered.length);
}
function number(id) { return $(id).value === '' ? null : Number($(id).value); }
function apply() {
  if (!data) return;
  const from=$('from').value, to=$('to').value;
  const smin=number('surface-min'), smax=number('surface-max'), pmin=number('price-min'), pmax=number('price-max');
  const invalid = (from && to && from > to) || (smin != null && smax != null && smin > smax) || (pmin != null && pmax != null && pmin > pmax);
  $('filter-error').hidden = !invalid;
  if (invalid) { $('filter-error').textContent = 'Le minimum doit être inférieur ou égal au maximum.'; return; }
  const q=$('quality').value;
  const b = $('in-view').checked ? boundsFilter : null;
  filtered=data.sales.filter((s) => (!from || s.transaction_date>=from) && (!to || s.transaction_date<=to)
    && (smin==null || (s.surface_m2!=null && s.surface_m2>=smin)) && (smax==null || (s.surface_m2!=null && s.surface_m2<=smax))
    && (pmin==null || (s.price_eur!=null && s.price_eur>=pmin)) && (pmax==null || (s.price_eur!=null && s.price_eur<=pmax))
    && (q==='all' || (q==='qualified' ? s.valid_ppsqm : !s.valid_ppsqm))
    && (!b || b.contains([s.lon,s.lat])));
  page=0; render();
}
async function startMap() {
  try {
    const ml=await import('./vendor/maplibre-gl.mjs');
    ml.setWorkerUrl(new URL('./vendor/maplibre-gl-worker.mjs', import.meta.url).href);
    map=new ml.Map({container:'map',center:[2.380,48.860],zoom:13.6,maxZoom:18,minZoom:10,
      style:{version:8,sources:{osm:{type:'raster',tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],tileSize:256,maxzoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}},layers:[{id:'osm',type:'raster',source:'osm'}]}});
    map.addControl(new ml.NavigationControl({showCompass:false}), 'top-right');
    map.on('error', () => { $('map-error').hidden=false; $('map-error').textContent='Une ressource cartographique est indisponible. Les transactions de la liste restent consultables.'; });
    map.on('load', () => {
      map.addSource('sales',{type:'geojson',data:emptyGeo()});
      map.addLayer({id:'sales',type:'circle',source:'sales',paint:{'circle-radius':['interpolate',['linear'],['zoom'],10,3,14,6,18,10],'circle-color':['case',['get','qualified'],'#14756d','#bc853c'],'circle-stroke-color':'#ffffff','circle-stroke-width':1.5,'circle-opacity':.85}});
      mapReady=true; boundsFilter=map.getBounds(); render();
      map.on('click','sales',(e) => {
        const f=e.features?.[0];
        const sale=data?.sales.find(s => s.id===Number(f?.properties?.id));
        if(sale) showDetails(sale);
      });
      map.on('mouseenter','sales',()=>{map.getCanvas().style.cursor='pointer';});
      map.on('mouseleave','sales',()=>{map.getCanvas().style.cursor='';});
      map.on('render',()=>{$('map').dataset.renderedSales=String(map.queryRenderedFeatures({layers:['sales']}).length);});
    });
    map.on('moveend',()=>{boundsFilter=map.getBounds(); if($('in-view').checked) apply();});
  } catch (e) {
    $('map-error').hidden=false;
    $('map-error').textContent='Carte indisponible dans ce navigateur. Toutes les transactions restent accessibles dans la liste.';
  }
}
$('filters').addEventListener('submit',(e)=>{e.preventDefault();apply();});
$('in-view').addEventListener('change',apply);
$('reset-filters').addEventListener('click',()=>{$('filters').reset();apply();});
$('previous').addEventListener('click',()=>{page--;render();});
$('next').addEventListener('click',()=>{page++;render();});
$('close-details').addEventListener('click',()=>$('details').close());
$('details').addEventListener('click',(e)=>{if(e.target===$('details')){const r=$('details').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('details').close();}});
$('recenter').addEventListener('click',()=>map?.flyTo({center:[2.380,48.860],zoom:13.6}));
try {
  const r=await fetch('./transactions.json');
  if(!r.ok) throw new Error('HTTP');
  data=await r.json();
  if(!Array.isArray(data.sales) || data.sales.length!==1000 || data.sales.some(s=>!Number.isFinite(s.lon)||!Number.isFinite(s.lat))) throw new Error('Schéma');
  apply(); await startMap();
} catch(e) {
  data=null; filtered=[];
  $('data-error').hidden=false;
  $('data-error').textContent='L’extrait officiel est indisponible. Aucune donnée de remplacement n’est affichée. Rechargez la page pour réessayer.';
  $('rows').replaceChildren(); $('list-count').textContent='Données indisponibles';
  $('previous').disabled=true; $('next').disabled=true;
}
