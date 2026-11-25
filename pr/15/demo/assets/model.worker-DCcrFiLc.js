async function b(e,s,a,t){t({stage:"runtime",detail:"loading the Python runtime (Pyodide)",pct:2});const n=await(await import(e+"pyodide.mjs")).loadPyodide({indexURL:e});t({stage:"packages",detail:`loading ${a.join(", ")}`,pct:8}),await n.loadPackage(a,{messageCallback:()=>{}});const r=await fetch(s);if(!r.ok)throw new Error(`could not fetch ${s}: ${r.status}`);return n.unpackArchive(await r.arrayBuffer(),"zip",{extractDir:"/home/pyodide"}),n.runPython(`import sys
for p in ('/home/pyodide', '/home/pyodide/models'):
    p in sys.path or sys.path.insert(0, p)`),n}let o=null,u=null,c="",h="",m=!1,p=[],j=0;const v=1e3,l=e=>self.postMessage(e);function f(e){var a;const s=e!=null&&e.toJs?e.toJs({dict_converter:Object.fromEntries}):e;return(a=e==null?void 0:e.destroy)==null||a.call(e),s}async function S(e,s,a,t){var y;const i=f(a),n=t!=null&&t.toJs?t.toJs():t??null;(y=t==null?void 0:t.destroy)==null||y.call(t);let r;try{r=await fetch(h+s,{method:e,headers:i,body:n,cache:"no-store"})}catch{return null}const d={};return r.headers.forEach((g,w)=>d[w.toLowerCase()]=g),[r.status,d,new Uint8Array(await r.arrayBuffer())]}async function k(e,s){var n;const a=f(s);let t;try{t=await fetch(h+e,{method:"GET",headers:a,cache:"no-store"})}catch{return null}const i=(n=t.body)==null?void 0:n.getReader();return{status:t.status,next:async()=>{if(!i)return null;try{const{done:r,value:d}=await i.read();return r?null:d??new Uint8Array}catch{return null}}}}function $(e,s,a,t,i){i||p.push({id:`${c}-${++j}`,t:Date.now()/1e3,src:e,dst:s,letter:"I",summary:a,content:t,model:c,chain:null,hop:0})}async function E(e){c=e.model,h=e.apiUrl;const s=e.model==="analysis"?["numpy","scikit-learn"]:["numpy"];o=await b(e.pyodideUrl,e.pyZipUrl,s,t=>l({type:"progress",model:e.model,...t})),o.setStdout({batched:t=>l({type:"stdout",model:e.model,text:t})}),o.setStderr({batched:t=>l({type:"stderr",model:e.model,text:t})});const a={"data-cleanse":"data_cleanse",summaries:"summaries",analysis:"analysis"}[e.model]??`user_${e.model.replace(/-/g,"_")}`;e.code!=null&&(await o.loadPackagesFromImports(e.code),o.FS.writeFile(`/home/pyodide/models/${a}.py`,e.code)),o.globals.set("_http",S),o.globals.set("_open_stream",k),o.globals.set("_post_tap",$),o.globals.set("_user",e.user??`svc-${e.model}`),o.globals.set("_password",e.password??""),o.runPython(`
import importlib, json, csmodel
from js import Object
from pyodide.ffi import to_js

async def _transport(method, path, headers, body):
    r = await _http(method, path, to_js(headers, dict_converter=Object.fromEntries), to_js(body) if body else None)
    if r is None:
        raise csmodel.Unavailable("the data server does not answer")
    return int(r[0]), r[1].to_py(), r[2].to_bytes()

async def _stream(path, headers):
    s = await _open_stream(path, to_js(headers, dict_converter=Object.fromEntries))
    if s is None:
        raise csmodel.Unavailable("the data server does not answer")
    async def chunks():
        while True:
            c = await s.next()
            if c is None:
                return
            yield c.to_bytes()
    return int(s.status), chunks()

_mod = importlib.import_module(${JSON.stringify(a)})
model = _mod.MODEL()
api = csmodel.Api(model.id, _transport, _user, _password, stream=_stream)
def _tap(dst, summary, content=None):
    src, to = ("models", "scilibs") if dst == "scilibs" else ("scilibs", "models")
    _post_tap(src, to, f"{model.id}: {summary}", json.dumps(content, default=str)[:4000], api.quiet)
api.tap = _tap
runner = csmodel.Runner(model, api)

async def step():
    await runner.step()
    return [runner.phase, runner.detail, model.label]
`),l({type:"progress",model:e.model,stage:"ready",detail:"model loaded",pct:100}),_()}async function _(){if(!(!o||m)){m=!0;try{const e=await o.globals.get("step")(),[s,a,t]=e.toJs();e.destroy(),u.postMessage({type:"phase",phase:s,detail:a,label:t}),l({type:"status",model:c,phase:s,detail:a})}catch(e){const s=String((e==null?void 0:e.message)??e).split(`
`).slice(-2).join(" ");u.postMessage({type:"phase",phase:"failed",detail:s,label:c}),l({type:"status",model:c,phase:"failed",detail:s})}finally{m=!1}p.length&&(l({type:"tap",messages:p}),p=[]),setTimeout(_,v)}}self.onmessage=e=>{const s=e.data;s.type==="start"&&(u=e.ports[0],E(s).catch(a=>l({type:"progress",model:s.model,stage:"error",detail:String(a),pct:0})))};
//# sourceMappingURL=model.worker-DCcrFiLc.js.map
