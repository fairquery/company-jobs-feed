import json,os,urllib.request
H={"Authorization":"Bearer "+os.environ['APIFY_TOKEN']}
def get(p):
    return json.load(urllib.request.urlopen(urllib.request.Request("https://api.apify.com/v2"+p,headers=H)))
runs=json.load(open('runs.json')); out={}
P={"job-result":0.00099,"board-scanned":0.0005,"open-confirmed":0.00029,"company-discovered":0.0019,"apify-actor-start":0.00005}
for k,v in runs.items():
    r=get(f"/actor-runs/{v}")['data']
    items=get(f"/datasets/{r['defaultDatasetId']}/items?clean=1&limit=100000")
    if isinstance(items,dict): items=items.get('data',items)
    types={}
    for it in items: types[it.get('type')]=types.get(it.get('type'),0)+1
    cec=r.get('chargedEventCounts') or {}
    rev=sum(P.get(e,0)*n for e,n in cec.items())
    o=dict(id=v,status=r['status'],build=r.get('buildNumber'),mem=r['options']['memoryMbytes'],secs=r['stats'].get('runTimeSecs'),cu=r['stats'].get('computeUnits'),usageUsd=r.get('usageTotalUsd'),usage=r.get('usageUsd'),charged=cec,revenue=round(rev,6),types=types)
    out[k]=o
    summ=[i for i in items if i.get('type') in ('run_summary',)]
    json.dump(items[:400],open(f'items_{k}.json','w'),indent=1)
    print(k,json.dumps({x:o[x] for x in o if x!='usage'}))
json.dump(out,open('results.json','w'),indent=1)
