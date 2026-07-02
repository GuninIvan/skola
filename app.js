/* ===================== КОНФИГ И КОНСТАНТЫ ===================== */
const CONFIG = window.CONFIG || {};
const STATUS = {
  open:{label:"Не устранено",badge:"b-open"},
  check:{label:"На проверке",badge:"b-check"},
  done:{label:"Принято",badge:"b-done"},
};
const ROLES = {
  observer:{name:"Наблюдатель",cls:"observer",note:"Режим просмотра. Изменять статус нельзя."},
  contractor:{name:"Подрядчик",cls:"contractor",note:"Можно отметить выполнение — замечание уйдёт на проверку."},
  brusnika:{name:"Брусника",cls:"",note:"Можно принять замечание сразу и в любой момент вернуть в работу."},
};
const GROUP_FIELDS = [
  {k:"floor",label:"Этаж"},{k:"block",label:"Блок"},{k:"room",label:"Помещение"},
  {k:"org",label:"Организация"},{k:"elem",label:"Элемент"},{k:"remark",label:"Замечание"},
  {k:"deadline",label:"Срок устранения"},{k:"added",label:"Дата внесения"},{k:"by",label:"Кем внесено"},
];
const MAX_LEVELS = 6;

let DATA = [];
const state = {
  role:"observer", sessionToken:null,
  group:["block","room"], view:"list", search:"", status:"all",
  filters:{},   // { поле: Set(исключённых значений) }; пусто = показывать всё
  collapsed:new Set(), loaded:false, loadError:false
};

/* ===================== API ===================== */
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function apiGet(action, params={}){
  const url = new URL(CONFIG.API_URL);
  url.searchParams.set("action", action);
  url.searchParams.set("token", CONFIG.API_TOKEN);
  Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));
  // Apps Script изредка отдаёт HTML-заглушку вместо JSON (холодный старт/редирект) —
  // тогда JSON.parse падает на первом '<'. Это самоустраняется, поэтому делаем до 3
  // попыток с паузой. Повтор только при сбое сети/парсинга; на нормальный ответ
  // (в т.ч. {ok:false} вроде BAD_TOKEN) сразу выходим — повторять его бессмысленно.
  const ATTEMPTS = 3, GAP_MS = 1500;
  let lastErr;
  for(let i=1;i<=ATTEMPTS;i++){
    try{
      const r = await fetch(url.toString(), {method:"GET", cache:"no-store"});
      const text = await r.text();
      try{ return JSON.parse(text); }
      catch(_){ throw new Error("Сервер вернул не-JSON (возможно, временная заглушка)"); }
    }catch(err){
      lastErr = err;
      if(i < ATTEMPTS) await sleep(GAP_MS);
    }
  }
  throw lastErr;
}
async function apiPost(payload){
  // text/plain — чтобы не вызывать CORS-preflight (Apps Script его не обработает)
  const r = await fetch(CONFIG.API_URL, {
    method:"POST",
    headers:{ "Content-Type":"text/plain;charset=utf-8" },
    body: JSON.stringify({ token:CONFIG.API_TOKEN, ...payload })
  });
  return r.json();
}

/* ===================== ЗАГРУЗКА ДАННЫХ ===================== */
function configReady(){
  return CONFIG.API_URL && !/ВСТАВЬТЕ/.test(CONFIG.API_URL) &&
         CONFIG.API_TOKEN && !/ВСТАВЬТЕ/.test(CONFIG.API_TOKEN);
}

async function loadData(background=false){
  if(!configReady()){
    state.loadError = true;
    renderState("config");
    return;
  }
  if(!background && !state.loaded) renderState("loading");
  setRefreshing(true);
  try{
    const res = await apiGet(background ? "remarks" : "bootstrap");
    if(!res || !res.ok) throw new Error(res && res.error || "Ответ без ok");
    DATA = res.remarks || [];
    state.loaded = true; state.loadError = false;
    syncFilters();            // обновляем варианты фильтров под свежие данные
    render();                 // сохраняем раскрытые группы/скролл
  }catch(err){
    state.loadError = true;
    if(!background) renderState("error", String(err));
    else toast("Не удалось обновить данные", true);
  }finally{
    setRefreshing(false);
  }
}

function setRefreshing(on){
  document.getElementById("refreshBtn").classList.toggle("spin", !!on);
}

/* ===================== АВТОРИЗАЦИЯ ===================== */
const loginEl=document.getElementById("login"),pwd=document.getElementById("pwd"),loginErr=document.getElementById("loginErr"),loginBtn=document.getElementById("loginBtn");

function setRole(role){
  state.role=role;
  const R=ROLES[role],pill=document.getElementById("rolePill");
  pill.textContent=R.name;pill.className="role-pill "+R.cls;
  document.getElementById("roleNote").textContent="● "+R.note;
  render();
}
async function doLogin(){
  const password=pwd.value.trim();
  if(!password){loginErr.textContent="Введите пароль";return;}
  loginBtn.disabled=true;loginErr.textContent="Проверка…";
  try{
    const res=await apiPost({action:"login", password});
    if(res.ok){
      state.sessionToken=res.sessionToken;
      loginErr.textContent="";loginEl.classList.remove("on");
      setRole(res.role);
      toast("Вы вошли как «"+res.roleName+"»");
    }else{
      loginErr.textContent=res.message||"Неверный пароль";pwd.value="";pwd.focus();
    }
  }catch(err){
    loginErr.textContent="Ошибка сети, попробуйте ещё раз";
  }finally{
    loginBtn.disabled=false;
  }
}
loginBtn.onclick=doLogin;
pwd.addEventListener("keydown",e=>{if(e.key==="Enter")doLogin();});
document.getElementById("loginSkip").onclick=()=>{loginEl.classList.remove("on");state.sessionToken=null;setRole("observer");};
document.getElementById("changeRole").onclick=()=>{pwd.value="";loginErr.textContent="";loginEl.classList.add("on");setTimeout(()=>pwd.focus(),50);};

/* ===================== ДЕЙСТВИЯ (СТАТУС) ===================== */
function actionsFor(it){
  const r=state.role,out=[];
  if(r==="contractor"){
    if(it.status==="open") out.push({to:"check",cls:"act-done",label:"Отметить выполнение"});
  }
  if(r==="brusnika"){
    if(it.status!=="done") out.push({to:"done",cls:"act-accept",label:"Принять"});
    if(it.status!=="open") out.push({to:"open",cls:"act-reject",label:"Вернуть в работу"});
  }
  return out;
}
async function applyAction(id,to,label,photoBase64,photoMime,silentSuccess){
  const it=DATA.find(d=>d.id===id);if(!it)return;
  const prev=it.status;
  it.status=to;render();                          // оптимистично
  try{
    const payload={action:"setStatus", id, status:to, sessionToken:state.sessionToken, expectedStatus:prev};
    if(photoBase64){ payload.photoBase64=photoBase64; payload.photoMime=photoMime||"image/jpeg"; }
    const res=await apiPost(payload);
    if(res.ok && res.remark){
      Object.assign(it,res.remark);               // берём правду с сервера
      render();refreshWork();
      if(!silentSuccess) toast(label+" · "+STATUS[to].label);
    }else{
      it.status=prev;render();                     // откат
      if(res.error==="CONFLICT"){
        toast("Статус успели изменить. Обновляю…",true);
        loadData(true);
      }else if(res.error==="AUTH"){
        toast("Сессия истекла, войдите заново",true);
        state.sessionToken=null;setRole("observer");
      }else{
        toast(res.message||"Не удалось сохранить",true);
      }
    }
  }catch(err){
    it.status=prev;render();
    toast("Ошибка сети при сохранении",true);
  }
}

/* ===================== ФОТО ===================== */
const photoCache=new Map();    // remarkId -> dataUrl (для прокси/лайтбокса)
function thumbURL(fileId){ return "https://lh3.googleusercontent.com/d/"+fileId+"=w400"; }
function fullURL(fileId){ return "https://lh3.googleusercontent.com/d/"+fileId+"=w1600"; }

// IntersectionObserver — грузим миниатюры лениво
const imgObserver=("IntersectionObserver" in window)?new IntersectionObserver((entries)=>{
  entries.forEach(e=>{ if(e.isIntersecting){ loadThumb(e.target); imgObserver.unobserve(e.target);} });
},{rootMargin:"200px"}):null;

function loadThumb(img){
  const id=img.dataset.rid, fileId=img.dataset.fid;
  if(!fileId)return;
  if(CONFIG.PHOTO_VIA_PROXY){
    proxyPhoto(id).then(u=>{ if(u){img.src=u;img.classList.remove("loading");} else fail(img); }).catch(()=>fail(img));
  }else{
    img.onload=()=>img.classList.remove("loading");
    img.onerror=()=>{ // прямой thumbnail не дал картинку — пробуем прокси
      proxyPhoto(id).then(u=>{ if(u){img.onerror=null;img.src=u;img.classList.remove("loading");} else fail(img); }).catch(()=>fail(img));
    };
    img.src=thumbURL(fileId);
  }
  function fail(el){ el.classList.remove("loading"); el.classList.add("nophoto"); el.removeAttribute("src"); el.alt="нет фото"; }
}
async function proxyPhoto(remarkId){
  if(photoCache.has(remarkId))return photoCache.get(remarkId);
  try{
    const res=await apiGet("photo",{id:remarkId});
    if(res.ok&&res.dataUrl){ photoCache.set(remarkId,res.dataUrl); return res.dataUrl; }
  }catch(_){}
  return null;
}
function observeThumbs(){
  document.querySelectorAll("img.thumb[data-fid],img.big-photo[data-fid]").forEach(img=>{
    if(img.dataset.bound)return; img.dataset.bound="1";
    if(imgObserver)imgObserver.observe(img); else loadThumb(img);
  });
}

/* ===================== ЛАЙТБОКС ===================== */
const lb=document.getElementById("lightbox"),lbImg=document.getElementById("lbImg"),lbMeta=document.getElementById("lbMeta"),lbSpin=document.getElementById("lbSpin");
async function openPhoto(id){
  const d=DATA.find(x=>x.id===id);
  if(!d||!d.photo||!d.photo.available)return;
  lbMeta.textContent=`${d.elem} · Блок ${d.block} · пом. ${d.room} — ${d.remark}`;
  lbImg.style.display="none";lbSpin.style.display="block";lb.classList.add("on");
  const fileId=d.photo.fileId;
  const show=u=>{lbImg.onload=()=>{lbSpin.style.display="none";lbImg.style.display="block";};lbImg.onerror=tryProxy;lbImg.src=u;};
  const tryProxy=async()=>{const u=await proxyPhoto(id);if(u){lbImg.onerror=null;lbImg.onload=()=>{lbSpin.style.display="none";lbImg.style.display="block";};lbImg.src=u;}else{lbSpin.textContent="Фото недоступно";}};
  if(CONFIG.PHOTO_VIA_PROXY) tryProxy(); else show(fullURL(fileId));
}
function openDonePhoto(id){
  const d=DATA.find(x=>x.id===id);
  if(!d||!d.donePhoto||!d.donePhoto.available)return;
  lbMeta.textContent=`Исправление · ${d.elem} · Блок ${d.block} · пом. ${d.room}`;
  lbImg.style.display="none";lbSpin.style.display="block";lb.classList.add("on");
  const fileId=d.donePhoto.fileId;
  const tryProxy=async()=>{const u=await proxyPhoto(fileId);if(u){lbImg.onerror=null;lbImg.onload=()=>{lbSpin.style.display="none";lbImg.style.display="block";};lbImg.src=u;}else{lbSpin.textContent="Фото недоступно";}};
  if(CONFIG.PHOTO_VIA_PROXY){tryProxy();}
  else{lbImg.onload=()=>{lbSpin.style.display="none";lbImg.style.display="block";};lbImg.onerror=tryProxy;lbImg.src=fullURL(fileId);}
}
function closePhoto(){lb.classList.remove("on");lbImg.src="";lbSpin.textContent="Загрузка фото…";}
document.getElementById("lbClose").onclick=closePhoto;
lb.onclick=e=>{if(e.target===lb||e.target.classList.contains("lb-inner"))closePhoto();};
document.addEventListener("keydown",e=>{if(e.key==="Escape")closePhoto();});

/* ===================== ГРУППИРОВКА / РЕНДЕР ===================== */
function groupLabel(d,key){
  switch(key){
    case "floor":return "Этаж "+(d.floor??"—");
    case "block":return "Блок "+(d.block||"—");
    case "room":return "Помещение "+(d.room??"—");
    case "org":return d.org||"— не указано";
    case "elem":return d.elem||"— без элемента";
    case "remark":return d.remark||"—";
    case "status":return STATUS[d.status].label;
    case "by":return d.by||"— не указано";
    case "added":return d.added||"— без даты";
    case "deadline":return d.deadline||"— без срока";
  }
}
function passFilters(d){
  // проходит, если ни по одному столбцу его значение не «снято» галочкой
  for(const f of GROUP_FIELDS){
    const ex=state.filters[f.k];
    if(ex&&ex.size&&ex.has(groupLabel(d,f.k))) return false;
  }
  return true;
}
function filtered(){
  const q=state.search.trim().toLowerCase();
  return DATA.filter(d=>{
    if(state.status!=="all"&&d.status!==state.status)return false;
    if(!passFilters(d))return false;
    if(q){const hay=(d.remark+" "+d.elem+" "+d.room+" "+d.block+" "+d.org+" "+d.by).toLowerCase();if(!hay.includes(q))return false;}
    return true;
  });
}
function groupBy(items,key){
  const m=new Map();
  items.forEach(d=>{const k=groupLabel(d,key);(m.get(k)||m.set(k,[]).get(k)).push(d);});
  const entries=[...m.entries()];
  if(key==="added"||key==="deadline"){
    // даты — от раннего к позднему; группы без даты уводим в конец
    entries.sort((a,b)=>{
      const ta=ruDateVal(a[0]), tb=ruDateVal(b[0]);
      if(ta==null&&tb==null) return a[0].localeCompare(b[0],'ru',{numeric:true});
      if(ta==null) return 1;
      if(tb==null) return -1;
      return ta-tb;
    });
  }else{
    entries.sort((a,b)=>a[0].localeCompare(b[0],'ru',{numeric:true}));
  }
  return new Map(entries);
}
// «дд.мм.гггг» → сравнимое число (мс от эпохи); не дата → null
function ruDateVal(s){
  const m=/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(String(s||'').trim());
  if(!m) return null;
  let y=+m[3]; if(y<100) y+=2000;
  return new Date(y, (+m[2])-1, +m[1]).getTime();
}

const app=document.getElementById("app");

function renderState(kind,detail){
  if(kind==="loading"){
    app.className="v-list";
    app.innerHTML=`<div class="loading-state"><div class="spinner"></div>Загрузка замечаний…</div>`+
      Array.from({length:5}).map(()=>`<div class="skel"></div>`).join("");
    return;
  }
  if(kind==="error"){
    app.className="";
    app.innerHTML=`<div class="error-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
      <div>Не удалось загрузить данные.</div><div class="meta" style="margin-top:6px">${esc(detail||"Проверьте интернет и доступность сервера")}</div>
      <button class="retry-btn" id="retryBtn">Повторить</button></div>`;
    document.getElementById("retryBtn").onclick=()=>loadData(false);
    return;
  }
  if(kind==="config"){
    app.className="";
    app.innerHTML=`<div class="error-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l9 5v6c0 5-3.5 8-9 9-5.5-1-9-4-9-9V7z"/></svg>
      <div>Не настроен <b>config.js</b>.</div><div class="meta" style="margin-top:6px">Укажите <b>API_URL</b> и <b>API_TOKEN</b> из развёрнутого Apps Script.</div></div>`;
    return;
  }
}

function render(){
  if(!state.loaded){ if(state.loadError) return; return; }
  const cnt=s=>DATA.filter(d=>d.status===s).length;
  document.getElementById("cAll").textContent=DATA.length;
  document.getElementById("cOpen").textContent=cnt("open");
  document.getElementById("cCheck").textContent=cnt("check");
  document.getElementById("cDone").textContent=cnt("done");
  document.getElementById("totalCount").textContent=DATA.length;
  document.getElementById("fcount").textContent=state.group.length||"—";
  const ftgl=document.getElementById("filtersToggle");
  if(ftgl) ftgl.classList.toggle("has-filters", Object.keys(state.filters).some(k=>state.filters[k]&&state.filters[k].size));

  const scrollY=window.scrollY;
  const items=filtered();
  app.className="v-"+state.view;
  if(!items.length){
    app.innerHTML=`<div class="empty"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg><div>Ничего не найдено. Измените поиск или фильтр.</div></div>`;
    return;
  }
  if(state.group.length===0){
    app.innerHTML=`<div class="items">`+items.map(renderItem).join("")+`</div>`;
  }else{
    app.innerHTML=renderTree(items,state.group,0,"");
  }
  observeThumbs();
  window.scrollTo(0,scrollY);
}
function renderTree(items,fields,depth,prefix){
  if(depth===fields.length) return `<div class="items">`+items.map(renderItem).join("")+`</div>`;
  let html="";
  for(const[k,arr] of groupBy(items,fields[depth])){
    const path=prefix?prefix+"▸"+k:k, collapsed=state.collapsed.has(path);
    const lvlClass=depth===0?"lvl1":"lvl2";
    html+=`<section class="group ${lvlClass}${collapsed?" collapsed":""}">${head(k,arr,depth+1,path)}<div class="items-wrap">${renderTree(arr,fields,depth+1,path)}</div></section>`;
  }
  return html;
}
function head(title,arr,level,pathKey){
  const done=arr.filter(d=>d.status==="done").length;
  return `<div class="group-head${level>=2?" gh2":""}" data-key="${esc(pathKey)}"><svg class="caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg><h2>${esc(title)}</h2><span class="gcount">${arr.length} · ✓ ${done}</span><span class="gbar"></span></div>`;
}
function thumbHTML(d,cls){
  if(d.photo&&d.photo.available)
    return `<img class="thumb loading ${cls}" data-rid="${esc(d.id)}" data-fid="${esc(d.photo.fileId)}" data-photo="${esc(d.id)}" alt="Фото замечания">`;
  return `<div class="thumb ${cls} nophoto">нет<br>фото</div>`;
}
function nophotoBox(label){
  return `<div class="big-photo nophoto"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3l18 18M21 15V7a2 2 0 0 0-2-2h-8M3 7v12a2 2 0 0 0 2 2h12"/></svg><span>${label||"Фото нет"}</span></div>`;
}
function bigPhotos(d){
  const has1=d.photo&&d.photo.available, has2=d.donePhoto&&d.donePhoto.available;
  const before=has1
    ?`<img class="big-photo loading" data-rid="${esc(d.id)}" data-fid="${esc(d.photo.fileId)}" data-photo="${esc(d.id)}" alt="Фото дефекта">`
    :nophotoBox("Фото нет");
  if(!has2) return before;                               // одно фото — как раньше
  const after=`<img class="big-photo loading" data-rid="${esc(d.donePhoto.fileId)}" data-fid="${esc(d.donePhoto.fileId)}" data-donephoto="${esc(d.id)}" alt="Фото исправления">`;
  return `<div class="big-photos"><div class="ph-wrap"><span class="ph-lab was">Было</span>${before}</div><div class="ph-wrap"><span class="ph-lab now">Стало</span>${after}</div></div>`;
}
function statusBadge(d){const s=STATUS[d.status];return `<span class="badge ${s.badge}">${s.label}</span>`;}
function photoPair(d){
  const has1=d.photo&&d.photo.available, has2=d.donePhoto&&d.donePhoto.available;
  if(!has1&&!has2) return `<div class="thumb nophoto">нет<br>фото</div>`;
  if(has1&&!has2)  return `<img class="thumb loading" data-rid="${esc(d.id)}" data-fid="${esc(d.photo.fileId)}" data-photo="${esc(d.id)}" alt="Фото замечания">`;
  const t1=has1?`<div class="tp"><img class="thumb loading" data-rid="${esc(d.id)}" data-fid="${esc(d.photo.fileId)}" data-photo="${esc(d.id)}" alt="Фото дефекта"><span class="tp-lab was">Было</span></div>`:"";
  const t2=`<div class="tp"><img class="thumb loading" data-rid="${esc(d.donePhoto.fileId)}" data-fid="${esc(d.donePhoto.fileId)}" data-donephoto="${esc(d.id)}" alt="Фото исправления"><span class="tp-lab now">Стало</span></div>`;
  return `<div class="thumb-pair">${t1}${t2}</div>`;
}
function actBtns(d){
  return `<button class="act act-card" data-card="${esc(d.id)}">Карточка работы</button>`;
}
function renderItem(d){
  if(state.view==="list"){
    return `<div class="item">${photoPair(d)}<div class="li-main"><div class="li-remark">${esc(d.remark)}</div><div class="li-sub"><span class="elem-tag">${esc(d.elem)}</span><span class="meta">Блок <b>${esc(d.block)}</b> · пом. <b>${esc(String(d.room))}</b></span>${statusBadge(d)}</div></div><div class="li-act">${actBtns(d)}</div></div>`;
  }
  if(state.view==="cards"){
    return `<div class="item"><div class="c-top">${photoPair(d)}<div class="c-body"><div class="c-tags"><span class="elem-tag">${esc(d.elem)}</span>${statusBadge(d)}</div><div class="c-remark">${esc(d.remark)}</div><div class="meta">Блок <b>${esc(d.block)}</b> · пом. <b>${esc(String(d.room))}</b>${d.org?" · "+esc(d.org):""}</div></div></div><div class="c-foot"><span class="meta">${esc(d.by||"—")} · ${esc(d.added)}</span><div>${actBtns(d)}</div></div></div>`;
  }
  const photo=bigPhotos(d);
  return `<div class="item">${photo}<div class="big-body"><div class="big-tags"><span class="elem-tag">${esc(d.elem)}</span>${statusBadge(d)}</div><div class="big-remark">${esc(d.remark)}</div><dl class="big-grid"><dt>Этаж / Блок</dt><dd>${esc(String(d.floor))} · ${esc(d.block)}</dd><dt>Помещение</dt><dd>${esc(String(d.room))}</dd><dt>Организация</dt><dd>${esc(d.org||"—")}</dd><dt>Внёс</dt><dd>${esc(d.by||"—")} · ${esc(d.added)}</dd></dl><div class="big-foot"><div>${actBtns(d)}</div></div></div></div>`;
}

/* ===================== ЧИПСЫ ГРУППИРОВКИ ===================== */
const groupBar=document.getElementById("groupBar");
function renderGroupChips(){
  let html=`<span class="gb-label">Группировка:</span>`;
  GROUP_FIELDS.forEach(f=>{
    const i=state.group.indexOf(f.k),sel=i>=0;
    html+=`<span class="gchip${sel?" sel":""}" data-group="${f.k}">${sel?`<span class="lvl">${i+1}</span>`:""}${f.label}</span>`;
  });
  if(state.group.length) html+=`<button class="gb-clear" id="gbClear">сбросить</button>`;
  groupBar.innerHTML=html;
}
groupBar.addEventListener("click",e=>{
  if(e.target.id==="gbClear"){state.group=[];state.collapsed.clear();renderGroupChips();render();return;}
  const c=e.target.closest("[data-group]");if(!c)return;
  const k=c.dataset.group,i=state.group.indexOf(k);
  if(i>=0) state.group.splice(i,1);
  else{if(state.group.length>=MAX_LEVELS){toast("Максимум "+MAX_LEVELS+" уровней группировки");return;}state.group.push(k);}
  state.collapsed.clear();renderGroupChips();render();
});

/* ===================== ФИЛЬТРЫ ПО СТОЛБЦАМ ===================== */
/* На каждый из 9 столбцов (те же, что в группировке) — выпадающий список с
   чекбоксами всех встречающихся значений. По умолчанию все включены (видно всё).
   state.filters[поле] = Set(«снятых» значений); пусто/нет ключа = столбец не фильтрует.
   Значение варианта = groupLabel(d,поле) — 1:1 с тем, как бьёт группировка. */
const filterBar=document.getElementById("filterBar");
let FILTER_OPTS={}, lastOptsSig="";

function buildFilterOptions(){
  const acc={}; GROUP_FIELDS.forEach(f=>acc[f.k]=new Map());
  DATA.forEach(d=>GROUP_FIELDS.forEach(f=>{
    const v=groupLabel(d,f.k); acc[f.k].set(v,(acc[f.k].get(v)||0)+1);
  }));
  const out={};
  GROUP_FIELDS.forEach(f=>{
    const arr=[...acc[f.k].entries()];              // [значение, счётчик]
    if(f.k==="added"||f.k==="deadline"){
      arr.sort((a,b)=>{
        const ta=ruDateVal(a[0]),tb=ruDateVal(b[0]);
        if(ta==null&&tb==null) return a[0].localeCompare(b[0],'ru',{numeric:true});
        if(ta==null) return 1; if(tb==null) return -1; return ta-tb;
      });
    }else arr.sort((a,b)=>a[0].localeCompare(b[0],'ru',{numeric:true}));
    out[f.k]=arr;
  });
  return out;
}
function optsSignature(opts){
  return GROUP_FIELDS.map(f=>f.k+":"+(opts[f.k]||[]).map(e=>e[0]).join("|")).join("§");
}
function renderFilterBar(){
  const parts=[`<span class="fb-label">Фильтры:</span>`];
  GROUP_FIELDS.forEach(f=>{
    const opts=FILTER_OPTS[f.k]||[], ex=state.filters[f.k];
    const total=opts.length, sel=opts.reduce((n,[v])=>n+((ex&&ex.has(v))?0:1),0);
    const active=!!(ex&&ex.size&&sel<total);
    const rows=opts.map(([v,c])=>{
      const checked=!(ex&&ex.has(v));
      return `<label class="fopt" title="${esc(v)}"><input type="checkbox" data-val="${esc(v)}"${checked?" checked":""}><span class="fopt-txt">${esc(v)}</span><span class="fopt-c">${c}</span></label>`;
    }).join("");
    parts.push(
      `<div class="filter-dd${active?" on":""}" data-field="${f.k}">`+
        `<button type="button" class="fdd-btn">${esc(f.label)}<span class="fdd-badge">${active?sel+"/"+total:""}</span>`+
          `<svg class="fcaret" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg></button>`+
        `<div class="filter-pop">`+
          `<div class="fpop-head"><span class="fpop-title">${esc(f.label)}</span><span class="fpop-acts"><button type="button" data-fall>Все</button><button type="button" data-fnone>Снять</button><button type="button" class="fpop-close" data-fclose aria-label="Закрыть">✕</button></span></div>`+
          `<div class="fpop-list">${rows||'<div class="fpop-empty">Нет данных</div>'}</div>`+
        `</div>`+
      `</div>`
    );
  });
  parts.push(`<button type="button" class="fb-clear" id="fbClear"><span class="fbx">✕</span>Сбросить фильтры</button>`);
  filterBar.innerHTML=parts.join("");
  filterBar.dataset.built="1";
}
// перестраиваем варианты только когда реально изменился набор значений (напр. после
// подгрузки данных) — тогда открытый список при вводе/поллинге не схлопывается
function syncFilters(){
  const opts=buildFilterOptions(), sig=optsSignature(opts);
  if(sig===lastOptsSig && filterBar.dataset.built==="1") return;
  lastOptsSig=sig; FILTER_OPTS=opts;
  const openField=filterBar.querySelector(".filter-dd.open")?.dataset.field||null;
  renderFilterBar();
  if(openField){const dd=filterBar.querySelector('.filter-dd[data-field="'+openField+'"]');if(dd){dd.classList.add("open");flipPop(dd);}}
}
function updateFieldBadge(field){
  const dd=filterBar.querySelector('.filter-dd[data-field="'+field+'"]'); if(!dd)return;
  const boxes=[...dd.querySelectorAll('input[type="checkbox"][data-val]')];
  const total=boxes.length, sel=boxes.filter(b=>b.checked).length, active=sel<total;
  dd.classList.toggle("on",active);
  const badge=dd.querySelector(".fdd-badge"); if(badge) badge.textContent=active?(sel+"/"+total):"";
}
function onCheckToggle(cb){
  const dd=cb.closest(".filter-dd"); if(!dd)return;
  const field=dd.dataset.field, val=cb.dataset.val;
  let ex=state.filters[field]; if(!ex) ex=state.filters[field]=new Set();
  if(cb.checked) ex.delete(val); else ex.add(val);
  if(ex.size===0) delete state.filters[field];
  updateFieldBadge(field); render();
}
function setFieldAll(el,checkAll){
  const dd=el.closest(".filter-dd"); if(!dd)return;
  const field=dd.dataset.field, boxes=[...dd.querySelectorAll('input[type="checkbox"][data-val]')];
  boxes.forEach(b=>b.checked=checkAll);
  if(checkAll) delete state.filters[field];
  else state.filters[field]=new Set(boxes.map(b=>b.dataset.val));
  updateFieldBadge(field); render();
}
function flipPop(dd){
  dd.classList.remove("pop-right");
  if(window.matchMedia("(max-width:640px)").matches) return; // на телефоне панель во всю ширину
  const pop=dd.querySelector(".filter-pop"); if(!pop)return;
  if(pop.getBoundingClientRect().right>window.innerWidth-6) dd.classList.add("pop-right");
}
function closeAllDropdowns(){ filterBar.querySelectorAll(".filter-dd.open").forEach(x=>x.classList.remove("open","pop-right")); }
function toggleDropdown(btn){
  const dd=btn.closest(".filter-dd"); if(!dd)return;
  const willOpen=!dd.classList.contains("open");
  closeAllDropdowns();
  if(willOpen){dd.classList.add("open");flipPop(dd);}
}
function resetFilters(){ state.filters={}; closeAllDropdowns(); renderFilterBar(); render(); }

filterBar.addEventListener("click",e=>{
  if(e.target.closest("#fbClear")){resetFilters();return;}
  if(e.target.closest("[data-fclose]")){closeAllDropdowns();return;}
  const fall=e.target.closest("[data-fall]"); if(fall){setFieldAll(fall,true);return;}
  const fnone=e.target.closest("[data-fnone]"); if(fnone){setFieldAll(fnone,false);return;}
  const btn=e.target.closest(".fdd-btn"); if(btn){toggleDropdown(btn);return;}
});
filterBar.addEventListener("change",e=>{
  const cb=e.target.closest('input[type="checkbox"][data-val]'); if(cb) onCheckToggle(cb);
});
document.addEventListener("click",e=>{ if(!e.target.closest(".filter-dd")) closeAllDropdowns(); });
document.addEventListener("keydown",e=>{ if(e.key==="Escape") closeAllDropdowns(); });

/* ===================== СОБЫТИЯ СПИСКА ===================== */
app.addEventListener("click",e=>{
  const dph=e.target.closest("[data-donephoto]");if(dph&&!dph.classList.contains("nophoto")){openDonePhoto(dph.dataset.donephoto);return;}
  const ph=e.target.closest("[data-photo]");if(ph&&!ph.classList.contains("nophoto")){openPhoto(ph.dataset.photo);return;}
  const cd=e.target.closest("[data-card]");if(cd){openWork(cd.dataset.card);return;}
  const gh=e.target.closest(".group-head");if(gh){const k=gh.dataset.key;state.collapsed.has(k)?state.collapsed.delete(k):state.collapsed.add(k);render();}
});
document.getElementById("searchInp").oninput=e=>{state.search=e.target.value;render();};
document.getElementById("viewSwitch").addEventListener("click",e=>{const b=e.target.closest("button[data-view]");if(!b)return;state.view=b.dataset.view;[...document.querySelectorAll("#viewSwitch button")].forEach(x=>x.classList.toggle("active",x===b));render();});
/* На мобильных вид «Список» недоступен (кнопка скрыта в CSS) — переключаем на «Карточки» */
const mqMobile=window.matchMedia("(max-width:640px)");
function enforceMobileView(){
  if(mqMobile.matches&&state.view==="list"){
    state.view="cards";
    [...document.querySelectorAll("#viewSwitch button")].forEach(x=>x.classList.toggle("active",x.dataset.view==="cards"));
    render();
  }
}
if(mqMobile.addEventListener) mqMobile.addEventListener("change",enforceMobileView); else mqMobile.addListener(enforceMobileView);
enforceMobileView();
document.getElementById("statusFilter").addEventListener("click",e=>{const c=e.target.closest(".chip");if(!c)return;state.status=c.dataset.status;[...document.querySelectorAll(".chip")].forEach(x=>x.classList.toggle("active",x===c));render();});
document.getElementById("filtersToggle").onclick=()=>{
  const open=document.getElementById("filters").classList.toggle("open");
  if(!open) closeAllDropdowns();
};
document.getElementById("refreshBtn").onclick=()=>loadData(true);

/* ===================== УТИЛИТЫ ===================== */
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[m]));}
let toastT;function toast(msg,isErr,ms){const t=document.getElementById("toast");t.textContent=msg;t.className="toast on"+(isErr?" err":"");clearTimeout(toastT);toastT=setTimeout(()=>t.className="toast",ms||2200);}

/* ===================== АВТОСКРЫТИЕ ШАПКИ (только телефон) ===================== */
(function(){
  const header=document.querySelector("header");
  let lastY=window.scrollY||0, ticking=false;
  const isMobile=()=>window.matchMedia("(max-width:640px)").matches;
  function onScroll(){
    const y=window.scrollY||0;
    if(!isMobile()){ header.classList.remove("hide"); lastY=y; return; }
    const filtersOpen=document.getElementById("filters").classList.contains("open");
    const hh=header.offsetHeight;
    if(y<=hh+10 || filtersOpen) header.classList.remove("hide");      // у верха или открыты фильтры — всегда видна
    else if(y>lastY+6) header.classList.add("hide");                  // листаем вниз — прячем
    else if(y<lastY-6) header.classList.remove("hide");               // листаем вверх — показываем
    lastY=y;
  }
  window.addEventListener("scroll",()=>{
    if(!ticking){ requestAnimationFrame(()=>{onScroll();ticking=false;}); ticking=true; }
  },{passive:true});
  // если открыли панель фильтров — гарантированно показать шапку
  document.getElementById("filtersToggle").addEventListener("click",()=>header.classList.remove("hide"));
})();

/* ===================== PULL-TO-REFRESH ===================== */
(function(){
  const ptr=document.getElementById("ptr"),ptrText=document.getElementById("ptrText");
  let startY=0,pulling=false,dist=0;const TH=70;
  window.addEventListener("touchstart",e=>{if(window.scrollY<=0&&e.touches.length===1){startY=e.touches[0].clientY;pulling=true;}},{passive:true});
  window.addEventListener("touchmove",e=>{
    if(!pulling)return;dist=e.touches[0].clientY-startY;
    if(dist>0&&window.scrollY<=0){ptr.style.height=Math.min(dist,90)+"px";ptrText.textContent=dist>TH?"Отпустите для обновления":"Потяните для обновления";}
  },{passive:true});
  window.addEventListener("touchend",()=>{
    if(!pulling)return;pulling=false;
    if(dist>TH){ptr.classList.add("loading");ptr.style.height="44px";ptrText.textContent="Обновление…";
      loadData(true).finally(()=>{ptr.classList.remove("loading");ptr.style.height="0";});}
    else ptr.style.height="0";
    dist=0;
  });
})();

/* ===================== СЖАТИЕ ФОТО ===================== */
function compressImage(file, maxSide=1280, quality=0.7){
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file), img=new Image();
    img.onload=()=>{
      let w=img.width,h=img.height;
      if(w>h&&w>maxSide){h=Math.round(h*maxSide/w);w=maxSide;}
      else if(h>=w&&h>maxSide){w=Math.round(w*maxSide/h);h=maxSide;}
      const c=document.createElement("canvas");c.width=w;c.height=h;
      c.getContext("2d").drawImage(img,0,0,w,h);
      const dataUrl=c.toDataURL("image/jpeg",quality);
      URL.revokeObjectURL(url);
      const base64=dataUrl.split(",")[1];
      resolve({dataUrl,base64,mime:"image/jpeg",origSize:file.size,compSize:Math.round(base64.length*3/4)});
    };
    img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error("bad image"));};
    img.src=url;
  });
}
function fmtSize(b){return b<1024?b+" Б":b<1048576?Math.round(b/1024)+" КБ":(b/1048576).toFixed(1)+" МБ";}

/* ===================== ЛИСТ «ОТМЕТИТЬ ВЫПОЛНЕНИЕ» ===================== */
const doneSheet=document.getElementById("doneSheet"),doneDrop=document.getElementById("doneDrop"),
  doneFile=document.getElementById("doneFile"),donePv=document.getElementById("donePv"),
  donePvImg=document.getElementById("donePvImg"),donePvName=document.getElementById("donePvName"),
  donePvSize=document.getElementById("donePvSize"),doneConfirm=document.getElementById("doneConfirm");
let doneCtx={id:null,label:"",photo:null};
function openCompletion(id,label){
  doneCtx={id,label:label||"Отметить выполнение",photo:null};
  donePv.classList.remove("on");doneDrop.style.display="block";doneFile.value="";
  doneConfirm.disabled=true;doneConfirm.textContent="Отметить выполнение";
  doneSheet.classList.add("on");
}
function closeCompletion(){doneSheet.classList.remove("on");}
doneDrop.onclick=()=>doneFile.click();
doneFile.onchange=async e=>{
  const f=e.target.files&&e.target.files[0];if(!f)return;
  try{
    const r=await compressImage(f);
    doneCtx.photo=r;
    donePvImg.src=r.dataUrl;donePvName.textContent=f.name;
    donePvSize.innerHTML=`${fmtSize(r.origSize)} → <b>${fmtSize(r.compSize)}</b>`;
    doneDrop.style.display="none";donePv.classList.add("on");doneConfirm.disabled=false;
  }catch(_){toast("Не удалось обработать фото",true);}
};
document.getElementById("donePvDel").onclick=()=>{doneCtx.photo=null;doneFile.value="";donePv.classList.remove("on");doneDrop.style.display="block";doneConfirm.disabled=true;};
document.getElementById("doneClose").onclick=closeCompletion;
document.getElementById("doneCancel").onclick=closeCompletion;
doneSheet.onclick=e=>{if(e.target===doneSheet)closeCompletion();};
doneConfirm.onclick=()=>{
  if(!doneCtx.photo)return;
  const {id,label,photo}=doneCtx;
  closeCompletion();
  closeWork();                                          // карточка тоже закрывается сразу
  toast(label+" · "+STATUS.check.label, false, 3000);    // показываем сразу, не дожидаясь ответа сервера
  applyAction(id,"check",label,photo.base64,photo.mime,true);  // сохранение (с фото) идёт в фоне
};

/* ===================== ЛИСТ «РЕДАКТИРОВАТЬ» (Брусника) ===================== */
const editSheet=document.getElementById("editSheet"),editConfirm=document.getElementById("editConfirm");
const eF={floor:document.getElementById("eFloor"),block:document.getElementById("eBlock"),
  room:document.getElementById("eRoom"),org:document.getElementById("eOrg"),
  elem:document.getElementById("eElem"),remark:document.getElementById("eRemark"),
  deadline:document.getElementById("eDeadline")};
let editId=null;
// «дд.мм.гггг» → «гггг-мм-дд» для <input type="date">; иначе пусто
function ruToISO(s){
  const m=/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(String(s||'').trim());
  if(!m) return "";
  let y=m[3]; if(y.length===2) y="20"+y;
  return y+"-"+("0"+m[2]).slice(-2)+"-"+("0"+m[1]).slice(-2);
}
function openEdit(id){
  if(state.role!=="brusnika"){toast("Редактировать может только «Брусника»",true);return;}
  const d=DATA.find(x=>x.id===id);if(!d)return;
  editId=id;
  eF.floor.value=(d.floor??"");eF.block.value=(d.block||"");eF.room.value=(d.room||"");
  eF.org.value=(d.org||"");eF.elem.value=(d.elem||"");eF.remark.value=(d.remark||"");
  eF.deadline.value=ruToISO(d.deadline);
  editConfirm.disabled=false;editConfirm.textContent="Сохранить";
  editSheet.classList.add("on");
}
function closeEdit(){editSheet.classList.remove("on");editId=null;}
document.getElementById("editClose").onclick=closeEdit;
document.getElementById("editCancel").onclick=closeEdit;
editSheet.onclick=e=>{if(e.target===editSheet)closeEdit();};
editConfirm.onclick=async()=>{
  if(!editId)return;
  const it=DATA.find(x=>x.id===editId);if(!it)return;
  editConfirm.disabled=true;editConfirm.textContent="Сохранение…";
  try{
    const res=await apiPost({action:"editRemark", id:editId, sessionToken:state.sessionToken,
      floor:eF.floor.value.trim(), block:eF.block.value.trim(), room:eF.room.value.trim(),
      org:eF.org.value.trim(), elem:eF.elem.value.trim(), remark:eF.remark.value.trim(),
      deadline:eF.deadline.value});   // <input type="date"> → «гггг-мм-дд» или пусто
    if(res.ok&&res.remark){Object.assign(it,res.remark);render();refreshWork();closeEdit();toast("Изменения сохранены");}
    else if(res.error==="AUTH"){toast("Сессия истекла, войдите заново",true);state.sessionToken=null;setRole("observer");closeEdit();}
    else{editConfirm.disabled=false;editConfirm.textContent="Сохранить";toast(res.message||"Не удалось сохранить",true);}
  }catch(_){editConfirm.disabled=false;editConfirm.textContent="Сохранить";toast("Ошибка сети при сохранении",true);}
};

/* ===================== КАРТОЧКА РАБОТЫ ===================== */
const workSheet=document.getElementById("workSheet"),workBody=document.getElementById("workBody");
let curWorkId=null;
function workPhotoBlock(d){
  const has1=d.photo&&d.photo.available, has2=d.donePhoto&&d.donePhoto.available;
  if(!has1&&!has2) return `<div class="wc-noph">Фото пока нет</div>`;
  const before=has1?`<div class="wc-ph"><img class="wc-img big-photo loading" data-rid="${esc(d.id)}" data-fid="${esc(d.photo.fileId)}" data-photo="${esc(d.id)}" alt="Фото дефекта"><span class="ph-lab was">Было</span></div>`:"";
  const after=has2?`<div class="wc-ph"><img class="wc-img big-photo loading" data-rid="${esc(d.donePhoto.fileId)}" data-fid="${esc(d.donePhoto.fileId)}" data-donephoto="${esc(d.id)}" alt="Фото исправления"><span class="ph-lab now">Стало</span></div>`:"";
  return `<div class="wc-photos ${(has1&&has2)?'two':'one'}">${before}${after}</div>`;
}
function workActions(d){
  const r=state.role,b=[];
  if(r==="contractor"&&d.status==="open") b.push(`<button class="act act-done" data-workcomplete="1">Отметить выполнение</button>`);
  if(r==="brusnika"){
    b.push(`<button class="act act-edit" data-workedit="1"><span class="pencil">✎</span> Отредактировать</button>`);
    if(d.status!=="done") b.push(`<button class="act act-accept" data-workact="done|Принять">Принять</button>`);
    if(d.status!=="open") b.push(`<button class="act act-reject" data-workact="open|Вернуть в работу">Вернуть в работу</button>`);
  }
  return b.length?`<div class="wc-acts">${b.join("")}</div>`:"";
}
function renderWorkBody(d){
  const s=STATUS[d.status];
  return `<div class="sheet-h"><h3>Карточка работы</h3><button class="sx" data-workclose="1" aria-label="Закрыть">×</button></div>
    <div class="wc-top"><span class="elem-tag">${esc(d.elem)}</span><span class="badge ${s.badge}">${s.label}</span></div>
    ${workPhotoBlock(d)}
    <div class="wc-remark">${esc(d.remark)}</div>
    <dl class="wc-grid">
      <dt>Этаж / Блок</dt><dd>${esc(String(d.floor))} · ${esc(d.block)}</dd>
      <dt>Помещение</dt><dd>${esc(String(d.room))}</dd>
      <dt>Организация</dt><dd>${esc(d.org||"—")}</dd>
      <dt>Элемент</dt><dd>${esc(d.elem)}</dd>
      <dt>Срок</dt><dd>${esc(d.deadline||"—")}</dd>
      <dt>Внёс</dt><dd>${esc(d.by||"—")} · ${esc(d.added)}</dd>
    </dl>
    ${workActions(d)}`;
}
function openWork(id){
  const d=DATA.find(x=>x.id===id); if(!d)return;
  curWorkId=id;
  workBody.innerHTML=renderWorkBody(d);
  workBody.scrollTop=0;
  workSheet.classList.add("on");
  observeThumbs();
}
function closeWork(){workSheet.classList.remove("on");curWorkId=null;}
function refreshWork(){
  if(workSheet.classList.contains("on")&&curWorkId!=null){
    const d=DATA.find(x=>x.id===curWorkId);
    if(d){workBody.innerHTML=renderWorkBody(d);observeThumbs();}
  }
}
workSheet.addEventListener("click",e=>{
  if(e.target===workSheet){closeWork();return;}
  if(e.target.closest("[data-workclose]")){closeWork();return;}
  const dph=e.target.closest("[data-donephoto]");if(dph){openDonePhoto(dph.dataset.donephoto);return;}
  const ph=e.target.closest("[data-photo]");if(ph){openPhoto(ph.dataset.photo);return;}
  if(e.target.closest("[data-workedit]")){openEdit(curWorkId);return;}
  if(e.target.closest("[data-workcomplete]")){openCompletion(curWorkId,"Отметить выполнение");return;}
  const ac=e.target.closest("[data-workact]");
  if(ac){
    const[to,label]=ac.dataset.workact.split("|");
    const id=curWorkId;                 // запоминаем ДО закрытия — closeWork() обнуляет curWorkId
    closeWork();
    toast(label+" · "+STATUS[to].label, false, 3000);   // показываем сразу, не дожидаясь ответа сервера
    applyAction(id,to,label,undefined,undefined,true);  // сохранение идёт в фоне (silentSuccess=true)
    return;
  }
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&workSheet.classList.contains("on"))closeWork();});

/* ===================== СТАРТ ===================== */
renderGroupChips();
setRole("observer");
loadData(false);
if(CONFIG.POLL_MS>0){ setInterval(()=>{ if(state.loaded&&!document.hidden) loadData(true); }, CONFIG.POLL_MS); }
