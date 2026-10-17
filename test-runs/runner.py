import json,os,time,urllib.request
tok=os.environ['APIFY_TOKEN']; H={"Authorization":"Bearer "+tok,"Content-Type":"application/json"}
def api(path,data=None,method="GET"):
    req=urllib.request.Request("https://api.apify.com/v2"+path,data=json.dumps(data).encode() if data is not None else None,headers=H,method=method)
    return json.load(urllib.request.urlopen(req))['data']
inputs=json.load(open('inputs.json')); runs=json.load(open('runs.json'))
pending=[k for k in inputs if k not in runs]
while pending:
    k=pending[0]
    try:
        d=api("/acts/6R6gtNcaR2LlCEB5V/runs?memory=256",inputs[k],"POST"); runs[k]=d['id']; pending.pop(0); print("started",k,d['id'],flush=True)
        json.dump(runs,open('runs.json','w'),indent=1)
    except urllib.error.HTTPError as e:
        time.sleep(10)
while True:
    st={k:api(f"/actor-runs/{v}")['status'] for k,v in runs.items()}
    if all(s not in ('READY','RUNNING') for s in st.values()): break
    time.sleep(10)
print(json.dumps(st,indent=1))
