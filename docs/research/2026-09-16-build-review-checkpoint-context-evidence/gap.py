import json,sys,collections
f=sys.argv[1];types=collections.Counter();att=collections.Counter();attsz=collections.Counter()
out=0;seen={}
for line in open(f):
    d=json.loads(line);t=d.get('type');types[t]+=1
    if t=='attachment':
        a=d.get('attachment',{});k=a.get('type');att[k]+=1;attsz[k]+=len(json.dumps(a))//4
    m=d.get('message') or {}
    if m.get('id') and m.get('usage'):seen[m['id']]=m['usage'].get('output_tokens',0)
print(dict(types));print('attachments n:',dict(att));print('attachment ~tok:',dict(attsz));print('output tokens total',sum(seen.values()))
