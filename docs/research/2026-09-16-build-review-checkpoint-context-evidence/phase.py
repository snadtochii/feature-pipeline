import json,sys,re
turn=0;seen=set();ctx=[];ev=[]
for line in open(sys.argv[1]):
    d=json.loads(line);m=d.get('message') or {};c=m.get('content')
    if d.get('type')=='assistant':
        if m.get('id') not in seen:
            seen.add(m.get('id'));turn+=1;u=m.get('usage',{});ctx.append(u.get('input_tokens',0)+u.get('cache_creation_input_tokens',0)+u.get('cache_read_input_tokens',0))
        for x in c if isinstance(c,list) else []:
            if x.get('type')=='tool_use':
                i=x['input'];n=x['name']
                if n in('Agent','Task'):ev.append((turn,'SPAWN '+i.get('description','')[:40]))
                if n=='Write' and re.search(r'0[3-6]-\w+\.md',i.get('file_path','')):ev.append((turn,'WRITE '+i['file_path'].split('/')[-1]))
                if n=='Bash' and re.search(r'git commit|gh pr create|git push',i.get('command','')):ev.append((turn,'GIT '+re.search(r'git commit|gh pr create|git push',i['command']).group(0)))
N=turn;print('turns',N)
for t,e in ev:print(f't{t:3} ctx {ctx[t-1]//1000:3}k  {e}')
def cost(a,b):return sum(ctx[a-1:b])
marks=[t for t,e in ev if e.startswith('SPAWN')]
if marks:
    a=marks[0];b=max(t for t,e in ev if e.startswith('SPAWN'))
    w=[t for t,e in ev if '04-review' in e];r=w[0] if w else b
    tot=cost(1,N)
    print(f'implement t1-{a-1}: {100*cost(1,a-1)/tot:.0f}% | review wait+merge t{a}-{r}: {100*cost(a,r)/tot:.0f}% | after review t{r+1}-{N}: {100*cost(r+1,N)/tot:.0f}%')
