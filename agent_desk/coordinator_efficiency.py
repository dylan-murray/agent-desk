"""Provider-reported usage and bounded, disposable planning context."""
import copy
import json

CONTEXT_BYTES = 96000
PROMPT_BYTES = 128000

def encoded_size(value):
    return len(json.dumps(value,ensure_ascii=False).encode())


def bounded_context(context):
    data=copy.deepcopy(context)
    data['context_policy']={'limit_bytes':CONTEXT_BYTES,'trimmed':False,
        'note':'Full history is saved in Agent Desk. Older excerpts may be omitted. Do not infer approvals from missing history; ask when a required decision is absent.'}
    # Keep identities and task state, not terminal transcripts, environment, or launch argv.
    for key in ('workers','saved_workers'):
        fields=('id','worker','name','cwd','profile','harness','parent_id','status','exit_code','state','session_id','can_resume','resumed_worker')
        data[key]=[{k:w[k] for k in fields if k in w} for w in data.get(key,[])]
    protected=max((i for i,m in enumerate(data.get('conversation',[])) if m['kind']=='user'),default=-1)
    while encoded_size(data)>CONTEXT_BYTES:
        data['context_policy']['trimmed']=True
        history=data.get('task_history',[])
        # First remove verbose historical results while retaining assignment IDs and state.
        verbose=next((t for t in history if t.get('result') and len(t['result'])>180),None)
        if verbose is not None:
            verbose['result']=verbose['result'][:160]+'… [report excerpt]';continue
        conversation=data.get('conversation',[])
        removable=next((i for i in range(max(0,len(conversation)-4)) if i!=protected),None)
        if removable is not None:
            conversation.pop(removable)
            if removable<protected:protected-=1
            continue
        if data.get('actions'):
            data['actions'].pop();continue
        # Completed history can be omitted; pending assignments and session identities cannot.
        done=next((i for i,t in enumerate(history) if t.get('result') is not None),None)
        if done is not None:history.pop(done);continue
        raise ValueError('Coordinator context exceeds its 96 KB budget even after trimming older history. Start a new coordinator with a focused handoff; no planning call was made.')
    return data


class PlanningReply(dict):
    """Usage metadata stays outside the model-controlled action schema."""
    pass


def usage_from_output(provider,output):
    events=[]
    try:
        value=json.loads(output)
        if isinstance(value,dict):events=[value]
    except ValueError:
        for line in output.splitlines():
            try:value=json.loads(line)
            except ValueError:continue
            if isinstance(value,dict):events.append(value)
    if provider=='codex':events=[e for e in events if e.get('type')=='turn.completed']
    def count(value):return value if type(value) is int and 0<=value<10**12 else None
    # Only terminal usage envelopes count, not repeated assistant stream events.
    result={}
    for event in events:
        usage=event.get('usage')
        if not isinstance(usage,dict):continue
        incoming=count(usage.get('input_tokens',usage.get('prompt_tokens')))
        outgoing=count(usage.get('output_tokens',usage.get('completion_tokens')))
        cache=count(usage.get('cached_input_tokens',usage.get('cache_read_input_tokens')))
        if cache is None and isinstance(usage.get('prompt_tokens_details'),dict):cache=count(usage['prompt_tokens_details'].get('cached_tokens'))
        creation=count(usage.get('cache_creation_input_tokens'))
        # Anthropic-style input excludes cache reads/writes; Codex/OpenAI input includes reads.
        if incoming is not None and provider=='claude':
            incoming+=(cache or 0)+(creation or 0)
        for key,value in [('input_tokens',incoming),('output_tokens',outgoing),('cached_input_tokens',cache),('cache_creation_tokens',creation)]:
            if value is not None:result[key]=result.get(key,0)+value
    return result
