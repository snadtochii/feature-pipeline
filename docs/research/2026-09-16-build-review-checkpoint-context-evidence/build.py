import json,sys,collections,re
f=sys.argv[1]
calls={};turn=0;seen=set();ctx=[]
items=[]  # (turn, kind, label, chars)
for line in open(f):
    d=json.loads(line);m=d.get('message') or {}
    c=m.get('content')
    if d.get('type')=='assistant':
        if m.get('id') not in seen:
            seen.add(m.get('id'));turn+=1
            u=m.get('usage',{});ctx.append(u.get('input_tokens',0)+u.get('cache_creation_input_tokens',0)+u.get('cache_read_input_tokens',0))
        for x in c if isinstance(c,list) else []:
            if x.get('type')=='tool_use':
                i=x['input'];n=x['name']
                if n=='Read':lab='Read '+i.get('file_path','').split('/feature-pipeline/')[-1].split('/cache/')[-1][-70:]
                elif n=='Bash':lab='Bash '+re.sub(r'\s+',' ',i.get('command',''))[:70]
                elif n in('Agent','Task'):lab=n+' '+i.get('description','')[:50]
                else:lab=n
                calls[x['id']]=(n,lab)
                items.append((turn,n+'(args)',lab,len(json.dumps(i))))
            elif x.get('type')=='text':items.append((turn,'assistant_text','text',len(x['text'])))
            elif x.get('type')=='thinking':items.append((turn,'thinking','thinking',len(x.get('thinking',''))))
    elif d.get('type')=='user' and isinstance(c,list):
        for x in c:
            if x.get('type')=='tool_result':
                n,lab=calls.get(x['tool_use_id'],('?','?'))
                cc=x.get('content');s=len(cc) if isinstance(cc,str) else sum(len(y.get('text','')) for y in cc if isinstance(y,dict))
                items.append((turn,n+'(result)',lab,s))
            elif x.get('type')=='text':items.append((turn,'injected_text',x['text'][:60].replace('\n',' '),len(x['text'])))
N=turn
print('turns',N,'ctx start',ctx[0],'end',ctx[-1],'peak',max(ctx))
print('ctx every 10 turns:',[c//1000 for c in ctx[::10]])
k=collections.defaultdict(lambda:[0,0,0])
for t,kind,lab,s in items:
    a=k[kind];a[0]+=1;a[1]+=s//4;a[2]+=(s//4)*(N-t)
T=sum(a[2] for a in k.values())
print('\nBY KIND: n, tokens added, carried token-turns, share')
for kk,a in sorted(k.items(),key=lambda x:-x[1][2]):print(f'{kk:28} {a[0]:4} {a[1]:8} {a[2]:10} {100*a[2]/T:4.0f}%')
floor=ctx[0]*N;print('floor carried',floor,'vs content carried',T, 'actual cache-read-ish sum',sum(ctx))
print('\nTOP 15 single items by carried cost')
for t,kind,lab,s in sorted(items,key=lambda x:-(x[3]//4)*(N-x[0]))[:15]:print(f't{t:3} {s//4:7}tok x{N-t:3} = {(s//4)*(N-t)//1000:6}k  {kind} {lab}')
tc=collections.Counter(n for n,_ in calls.values());print('\ntool calls',dict(tc))
