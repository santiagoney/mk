const { JSDOM } = require('jsdom');
const fs = require('fs');
const dom=new JSDOM(fs.readFileSync('/home/claude/from_zip/index.html','utf8'),{runScripts:"dangerously",pretendToBeVisual:true,url:"http://localhost/",
  beforeParse(w){
    w.localStorage=(()=>{let s={};return{getItem:k=>k in s?s[k]:null,setItem:(k,v)=>s[k]=String(v),removeItem:k=>delete s[k]};})();
    w.HTMLCanvasElement.prototype.getContext=()=>({fillRect(){},fillStyle:'',strokeStyle:'',lineWidth:0,lineCap:'',beginPath(){},moveTo(){},lineTo(){},stroke(){},getImageData:()=>({data:new Uint8ClampedArray(4)})});
    w.Element.prototype.scrollIntoView=()=>{};
    w.navigator.serviceWorker={register:()=>Promise.resolve()};
  }});
const {window}=dom;
const errors=[]; window.addEventListener('error',e=>errors.push(e.message));
const s=window.document.createElement('script');s.textContent=fs.readFileSync('/home/claude/from_zip/app.js','utf8');window.document.body.appendChild(s);
setTimeout(async ()=>{
  const $=id=>window.document.getElementById(id);
  const q=sel=>window.document.querySelector(sel);
  window.setBleUI(true);

  // marcar centro
  q('#markCenter').click();
  console.log('1) centro marcado:', $('centerOut').textContent, '| xpos:', $('xpos').textContent);

  // definir lienzo chico: ±3 en X
  $('canvasX').value=3; $('canvasY').value=3; q('#saveCanvas').click();
  console.log('2) lienzo:', $('canvasOut').textContent);

  // jog X+ debe permitir hasta +3 y frenar en el borde
  for (let i=0;i<6;i++){ await q('[data-jog="x"][data-dir="1"]').dispatchEvent(new window.Event('pointerdown')); await q('[data-jog="x"][data-dir="1"]').dispatchEvent(new window.Event('pointerup')); }
  // como es continuo por timer, en jsdom no avanza igual; probamos sendMove directo
  console.log('3) (nota: continuo usa timer, se prueba en el navegador real)');

  // verificar withinLimits directamente
  console.log('4) withinLimits x en +3:', window.withinLimits?window.withinLimits('x',3):'(scope)');
  console.log('   withinLimits x en +4 (fuera):', window.withinLimits?window.withinLimits('x',4):'(scope)');

  console.log('ERRORES JS:', errors.length?errors.join(' | '):'ninguno ✓');
},400);
