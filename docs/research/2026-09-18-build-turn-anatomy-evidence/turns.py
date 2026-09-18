import json,sys,re,collections
f=sys.argv[1]; verbose='-v' in sys.argv
calls={};turnof={};turn=0;seen=set();ctx=[]
results=[]  # (turn, tool, label, is_error, text)
markers=0
for line in open(f):
    d=json.loads(line);m=d.get('message') or {};c=m.get('content')
    if d.get('type')=='assistant':
        if m.get('id') not in seen:
            seen.add(m.get('id'));turn+=1
            u=m.get('usage',{});ctx.append(u.get('input_tokens',0)+u.get('cache_creation_input_tokens',0)+u.get('cache_read_input_tokens',0))
        for x in c if isinstance(c,list) else []:
            if x.get('type')=='tool_use':
                calls[x['id']]=(x['name'],x['input']);turnof[x['id']]=turn
            elif x.get('type')=='text' and 'Turn ' in x['text'] and '/25' in x['text']:markers+=1
    elif d.get('type')=='user' and isinstance(c,list):
        for x in c:
            if x.get('type')=='tool_result':
                n,i=calls.get(x['tool_use_id'],('?',{}))
                cc=x.get('content');t=cc if isinstance(cc,str) else ''.join(y.get('text','') for y in cc if isinstance(y,dict))
                results.append((turnof.get(x['tool_use_id'],0),n,i,bool(x.get('is_error')),t))
def bcat(cmd):
    s=cmd.strip()
    if re.search(r'^\s*sleep\b|;\s*sleep\b|&&\s*sleep\b',s):return 'sleep'
    if re.search(r'check-[a-z-]+\.sh|npm (run|test|ci|exec)|pnpm (run|test|exec|lint|typecheck|tsc)|npx |vitest|jest|tsc\b|eslint|pytest|ruff|mypy|cargo (check|test|clippy)|go (test|vet)|bash scripts|uv run',s):return 'check/test'
    if re.search(r'\bgit (add|commit|push|stash|checkout|switch|worktree|merge|rebase|reset)|gh (pr|api|issue)',s):return 'git/gh write'
    if re.search(r'\bgit ',s):return 'git read'
    if re.search(r'<<\s*[\'"]?[A-Z_a-z]+|>\s*[^&]|\btee\b|\bmv\b|\bcp\b|\bmkdir\b|\brm\b|\bsed -i',s):return 'shell write'
    if re.search(r'\b(cat|sed -n|head|tail|ls|grep|rg|find|wc|awk|jq|python3 -c)\b',s):return 'shell read'
    return 'other'
def err_kind(n,i,is_err,t):
    tl=t[:600].lower()
    if n=='Bash':
        cmd=i.get('command','')
        if bcat(cmd)=='check/test':
            if is_err or re.search(r'exit code [1-9]|error ts\d+|✖|\d+ error|failed|fail\b',tl):return 'check-red'
            return None
        if is_err:
            if 'blocked' in tl or 'hook' in tl or 'permission' in tl or 'denied' in tl:return 'hook/permission block'
            if 'no such file' in tl or 'not found' in tl:return 'path/command not found'
            return 'bash error'
        if 'persisted to' in tl or 'output too large' in tl or 'truncated' in tl:return 'oversized result'
        return None
    if n in('Edit','MultiEdit','Write'):
        if is_err:
            if 'not been read' in tl or 'read it first' in tl:return 'edit-without-read'
            if 'not found in' in tl or 'old_string' in tl or 'no changes' in tl:return 'edit-mismatch'
            if 'blocked' in tl or 'hook' in tl or 'permission' in tl:return 'hook/permission block'
            return 'edit error'
        return None
    if is_err:
        if 'persisted' in tl or 'too large' in tl:return 'oversized result'
        return f'{n} error'
    if n=='Read' and ('persisted' in tl or 'too large' in tl or 'exceeds' in tl):return 'oversized result'
    return None
N=turn
tools=collections.Counter();bc=collections.Counter();errs=collections.Counter();errturns=set();samples=collections.defaultdict(list)
for tn,n,i,is_err,t in results:
    tools[n]+=1
    if n=='Bash':bc[bcat(i.get('command',''))]+=1
    k=err_kind(n,i,is_err,t)
    if k:
        errs[k]+=1;errturns.add(tn)
        lab=(i.get('command') or i.get('file_path') or '')[:90].replace('\n',' ')
        samples[k].append(f't{tn} {lab} :: {t[:140].replace(chr(10),"|")}')
# retries: identical Bash command re-issued within 4 turns
cmds=[(tn,i.get('command','').strip()) for tn,n,i,_,_ in results if n=='Bash']
retry=0
for a in range(len(cmds)):
    for b in range(a+1,len(cmds)):
        if cmds[b][0]-cmds[a][0]>4:break
        if cmds[a][1]==cmds[b][1] and cmds[a][1]:retry+=1;break
# sliced reads of same file
sl=collections.Counter()
for tn,n,i,_,_ in results:
    if n=='Bash':
        for mm in re.finditer(r"sed -n '?\d+,\d+p'? (\S+)",i.get('command','')):sl[mm.group(1)]+=1
    if n=='Read' and i.get('offset'):sl[i.get('file_path')]+=1
multi={k:v for k,v in sl.items() if v>1}
print(f'{f.split("/")[-1][:40]:40} turns {N:4} ctx {ctx[0]//1000 if ctx else 0}k->{max(ctx)//1000 if ctx else 0}k markers {markers}')
print('  tools',dict(tools.most_common()))
print('  bash ',dict(bc.most_common()))
print(f'  errors {sum(errs.values())} in {len(errturns)} turns ({100*len(errturns)/max(N,1):.0f}%):',dict(errs.most_common()))
print(f'  retries(identical bash <=4 turns) {retry}; sliced-read files {len(multi)} slices {sum(multi.values())}')
if verbose:
    for k,v in samples.items():
        print('  --',k)
        for s in v[:6]:print('    ',s)
