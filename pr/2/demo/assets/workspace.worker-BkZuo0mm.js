async function u(a,t,s,e){e({stage:"runtime",detail:"loading the Python runtime (Pyodide)",pct:5});const n=await(await import(a+"pyodide.mjs")).loadPyodide({indexURL:a});let i=0;for(const y of s)e({stage:"packages",detail:`loading ${y}`,pct:30+Math.round(50*i/s.length)}),await n.loadPackage(y,{messageCallback:()=>{}}),i++;e({stage:"code",detail:"unpacking the backend source",pct:82});const p=await fetch(t);if(!p.ok)throw new Error(`could not fetch ${t}: ${p.status}`);return n.unpackArchive(await p.arrayBuffer(),"zip",{extractDir:"/home/pyodide"}),n.runPython(`import sys
if '/home/pyodide' not in sys.path: sys.path.insert(0, '/home/pyodide')`),n}let o=null,d=null;function r(a){self.postMessage(a)}async function l(a,t,s){o=await u(a,t,["numpy","pandas"],e=>r({type:"progress",...e})),o.setStdout({batched:e=>r({type:"stdout",text:e})}),o.setStderr({batched:e=>r({type:"stderr",text:e})}),o.runPython(`
import sys
sys.path.insert(0, '/home/pyodide/workspace')
import edr
edr.API_BASE = ${JSON.stringify(s)}
`),r({type:"progress",stage:"ready",detail:"workspace ready",pct:100})}async function g(a,t){await d;const s=performance.now();try{await o.loadPackagesFromImports(t,{messageCallback:i=>r({type:"stdout",text:i})});const e=o.globals.get("dict")(),c=await o.runPythonAsync(t,{globals:e}),n=c==null?"":String(c);r({type:"done",id:a,ok:!0,result:n,ms:performance.now()-s}),e.destroy()}catch(e){r({type:"done",id:a,ok:!1,error:String((e==null?void 0:e.message)??e),ms:performance.now()-s})}}async function m(a){await d;try{await o.loadPackage("jsonschema");const t=await o.runPythonAsync(`
import json, edr
from contract_suite import suite
class _C:
    async def get(self, path, params=None):
        return await edr.get_raw(path, params)
    async def put(self, path, body):
        return await edr.put_raw(path, body)
json.dumps(await suite.run(_C()))
`);r({type:"contract",id:a,results:JSON.parse(t)})}catch(t){r({type:"contract",id:a,error:String((t==null?void 0:t.message)??t)})}}function h(a,t){if(!o){t.postMessage({status:503,headers:[["content-type","application/json"]],body:'{"code":"Unavailable","description":"workspace starting"}'});return}try{const e=o.pyimport("edr").serve(a.path),[c,n]=e.toJs({dict_converter:Object.fromEntries});e.destroy(),t.postMessage({status:c,headers:[["content-type","application/json"]],body:JSON.stringify(n)})}catch(s){t.postMessage({status:500,headers:[["content-type","application/json"]],body:JSON.stringify({code:"InternalError",description:String(s)})})}}self.onmessage=a=>{const t=a.data;if(t.type==="start")d=l(t.pyodideUrl,t.pyZipUrl,t.apiBase).catch(s=>r({type:"progress",stage:"error",detail:String(s),pct:0}));else if(t.type==="run")g(t.id,t.code);else if(t.type==="contract")m(t.id);else if(t.type==="connect"){const s=a.ports[0];s.onmessage=e=>h(e.data,e.ports[0])}};
//# sourceMappingURL=workspace.worker-BkZuo0mm.js.map
