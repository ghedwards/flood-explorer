const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const site=path.resolve(__dirname,'../../site');
test('2D WASM worker, browser model switching, cancellation and input changes', {timeout:90000}, async()=>{
  const server=http.createServer((req,res)=>{
    const file=path.resolve(site,'.'+new URL(req.url,'http://localhost').pathname.replace(/\/$/,'/index.html'));
    if(!file.startsWith(site+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',({'.wasm':'application/wasm','.js':'text/javascript','.css':'text/css','.html':'text/html'})[path.extname(file)]||'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
  try{
    browser=await chromium.launch();const context=await browser.newContext({serviceWorkers:'block'});
    await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>window.FloodCore?.inertialStart);
    // Direct bundled worker: rainfall has an analytic volume and depth solution.
    const sw=fs.readFileSync(path.join(site,'sw.js'),'utf8');
    const assets=JSON.parse(sw.match(/const BUILD_ASSETS = (\[.*?\]);/)[1]);
    const file=assets.find(f=>/inertial-worker-.*\.js$/.test(f));assert.ok(file);
    const result=await page.evaluate(file=>new Promise((resolve,reject)=>{
      const w=new Worker(new URL(file,document.baseURI),{type:'module'});
      const timer=setTimeout(()=>{w.terminate();reject(new Error('2D timeout'));},15000);
      w.onmessage=({data})=>{if(data.error||data.result){clearTimeout(timer);w.terminate();if(data.error)reject(new Error(data.error));else resolve({...data.result,depth:Array.from(data.result.depth)});}};
      w.onerror=e=>{clearTimeout(timer);w.terminate();reject(new Error(e.message));};
      w.postMessage({grid:{W:8,H:8,cell:10,dem:new Float32Array(64)},opts:{seconds:60,rainMmH:60,initialDepth:0,roughness:.04,inflow:0,inflowCell:-1}});
    }),file);
    assert.ok(Math.abs(result.volume-6.4)<1e-9);assert.ok(Math.abs(result.balanceError)<1e-9);
    assert.ok(result.depth.every(d=>Math.abs(d-.001)<1e-12));
    // Startup can still be loading the national view after WASM is ready.
    await page.waitForFunction(()=>window.__floodStatus?.national?.loaded);
    // Use the existing illustrative terrain path without network datasets.
    await page.evaluate(()=>{const s=document.getElementById('area');if(!s.querySelector('option[value="sample"]'))s.add(new Option('Sample','sample'));});
    await page.selectOption('#area','sample');
    await page.waitForFunction(()=>window.__floodStatus?.area==='sample' && document.getElementById('stats').textContent.includes('Deepest'));
    await page.evaluate(()=>window.__floodOpenPanel('panel-scenario'));
    await page.selectOption('#solver','inertial');
    await page.fill('#inertialMinutes','1');await page.fill('#inertialRain','600');await page.selectOption('#inertialResolution','96');
    await page.click('#inertialRun');
    await page.waitForFunction(()=>window.__floodStatus?.inertial?.running===false && window.__floodStatus.inertial.time===60);
    assert.match(await page.locator('#summaryLine').innerText(),/Local-inertial 2D/);
    assert.ok(Math.abs(await page.evaluate(()=>window.__floodStatus.inertial.balanceError))<1e-4);
    assert.equal(await page.locator('#gaugeLevel').isDisabled(),true);
    await page.fill('#inertialMinutes','1440');
    assert.equal(await page.evaluate(()=>window.__floodStatus.inertial),null);
    await page.click('#inertialRun');await page.click('#inertialCancel');
    assert.equal(await page.locator('#solver').inputValue(),'fast');
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>window.__floodStatus.inertial),null);
    assert.doesNotMatch(await page.locator('#summaryLine').innerText(),/Local-inertial/);
    assert.equal(await page.locator('#gaugeLevel').isDisabled(),false);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:'/tmp/flood-inertial-ui.png'});
    await context.close();
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
});
