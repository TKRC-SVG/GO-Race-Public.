importScripts('./push-worker.js?v=14.11.10');
const CACHE_NAME='go-shell-15.11.06';
const BASE=self.registration.scope;
const SHELL=[BASE,...['index.html','manifest.webmanifest','tkrc-theme.css?v=14.11.20','cloud-sync.js?v=14.11.05','schedule-import.js?v=01.11.14','heat-alarm.js?v=14.11.08','push-notifications.js?v=14.11.10','push-worker.js?v=14.11.10','tkrc-logo.png','ans-logo.jpg','sanwa-mt44.jpg','team/jorge-atienza.jpg','team/alejandro-atienza.jpg','team/marti-atienza.png','team/willy-gato.jpg','team/jaume-figuls.png','team/rafa-albar.png','team/miquel-jardi.png','team/eric-aguijo.png','team/you.png','team/history/jorge-atienza.jpg','team/history/alejandro-atienza.jpg','team/history/marti-atienza.jpg','team/history/rafa-albar.jpg','team/history/miquel-jardi.jpg','team/history/eric-aguijo.jpg','icon-192.png','icon-512.png','apple-touch-icon.png'].map(path=>new URL(path,BASE).href)];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('go-shell-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin)return;
  // Account, live, revision and explicit update requests must reach the network.
  if(url.pathname.startsWith('/api/')||url.pathname.endsWith('/revision.json')||url.searchParams.has('update')){
    event.respondWith(fetch(request,{cache:'no-store'}));return;
  }
  const navigation=request.mode==='navigate'||url.pathname.endsWith('/index.html');
  const key=navigation?new URL('index.html',BASE).href:request;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE_NAME),cached=await cache.match(key);
    // Keep HTML network-first for immediate updates; serve installed static assets from cache.
    if(!navigation&&cached)return cached;
    try{
      const response=await fetch(request,{cache:'no-store'});
      if(response.ok&&!response.redirected)event.waitUntil(cache.put(key,response.clone()).catch(()=>{}));
      return response;
    }catch{return cached||new Response('Sin conexión. Vuelve a abrir GO! cuando se restablezca.',{status:503,headers:{'content-type':'text/plain; charset=utf-8'}})}
  })());
});
