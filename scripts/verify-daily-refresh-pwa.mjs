import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {startServer,startChrome,waitFor} from './verify-newness-sources-pwa.mjs';
const payload = JSON.parse(await fs.readFile(new URL('../results.json',import.meta.url),'utf8'));
const {server,baseUrl} = await startServer(JSON.stringify(payload));
const chrome = await startChrome(baseUrl + '/__blank.html');
try {
  await chrome.page.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__collectionState='running';window.__collectionPosts=0;
    const realFetch=window.fetch.bind(window),realTimer=window.setTimeout;
    window.setTimeout=(fn,ms,...args)=>realTimer(fn,ms===15000?100:ms,...args);
    window.fetch=async function(url,options){
      if(String(url).includes('veille-immo-actualisation.')){
        if(options.method==='POST')window.__collectionPosts++;
        if(window.__collectionState==='offline')throw new Error('offline fixture');
        return new Response(JSON.stringify({state:window.__collectionState}),{status:200,headers:{'Content-Type':'application/json'}});
      }
      const response=await realFetch(url,options);
      if(/results(?:-terrain)?\\.json/.test(String(url))&&window.__collectionState==='current'){
        const data=await response.json();data.generatedAt=new Date().toISOString();
        return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
      }
      return response;
    };
  `});
  await chrome.page.send('Page.navigate',{url:baseUrl+'/index.html'});
  await waitFor(chrome.page,"({ok:window.veilleImmoDailyRefreshState==='running' && document.querySelector('.location-chip') && window.veilleImmoRenderedMarkerLayers?.length})",60000);
  const initial=await chrome.page.evaluate(`(()=>{
    const banner=document.querySelector('#dailyRefreshStatus');
    const chip=document.querySelector('.location-chip');
    const before=chip.getAttribute('aria-pressed');chip.click();
    return {busy:banner.getAttribute('aria-busy'),text:banner.textContent,posts:window.__collectionPosts,communeClickable:before!==chip.getAttribute('aria-pressed'),cards:document.querySelectorAll('.listing-card').length};
  })()`);
  assert.equal(initial.busy,'true');assert.equal(initial.posts,1);assert.ok(initial.communeClickable);assert.ok(initial.cards>0);
  await chrome.page.evaluate("window.__collectionState='failed'");
  await waitFor(chrome.page,"({ok:window.veilleImmoDailyRefreshState==='failed'})");
  assert.equal(await chrome.page.evaluate("document.querySelector('#dailyRefreshStatus button').hidden"),false);
  await chrome.page.evaluate("window.__collectionState='current';document.querySelector('#dailyRefreshStatus button').click()");
  await waitFor(chrome.page,"({ok:window.veilleImmoDailyRefreshState==='current'})");
  assert.equal(await chrome.page.evaluate('window.__collectionPosts'),2);
  await chrome.page.evaluate("document.dispatchEvent(new Event('visibilitychange'))");
  assert.equal(await chrome.page.evaluate('window.__collectionPosts'),2);
  await chrome.page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  const mobile=await chrome.page.evaluate(`(()=>{const b=document.querySelector('#dailyRefreshStatus').getBoundingClientRect();return {width:b.width,left:b.left,right:b.right,viewport:innerWidth};})()`);
  assert.ok(mobile.left>=0&&mobile.right<=mobile.viewport+1);
  await fs.mkdir(new URL('../outputs/2.1.3/',import.meta.url),{recursive:true});
  const shot=await chrome.page.send('Page.captureScreenshot',{format:'png'});
  await fs.writeFile(new URL('../outputs/2.1.3/daily-refresh-mobile.png',import.meta.url),Buffer.from(shot.data,'base64'));
  const report={ok:true,fixture:true,initial,mobile,checks:['running banner','commune click during refresh','failure retains cards','retry then current date','same-day visibility does not redispatch','mobile layout']};
  await fs.writeFile(new URL('../outputs/2.1.3/daily-refresh-browser-test.json',import.meta.url),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {await chrome.stop();server.close();}
