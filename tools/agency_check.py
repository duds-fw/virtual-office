import json, subprocess, sys

def api(path, method='GET', body=None, timeout=60):
    cmd = ['curl', '-s', '-m', str(timeout), '-X', method, f'http://127.0.0.1:9012{path}']
    if body is not None:
        cmd += ['-H', 'Content-Type: application/json', '-d', json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except Exception:
        return {'raw': out[:300]}

def oc_api(*args, timeout=60):
    cmd = ['/root/.opencode/bin/opencode', 'api'] + list(args)
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    try:
        return json.loads(out)
    except Exception:
        return {'raw': out[:300]}

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'summary'
    if cmd == 'autopilot':
        sf = '/home/opencode/virtual-office/state/autopilot_session.json'
        try:
            sid = json.load(open(sf))['sessionID']
        except Exception as e:
            print('no autopilot session:', e); sys.exit(0)
        print('autopilot session:', sid)
        d = oc_api('session.message.list', '--param', f'sessionID={sid}', '--param', 'limit=15')
        msgs = d.get('data', []) if isinstance(d, dict) else []
        print('messages:', len(msgs))
        for m in msgs:
            for p in (m.get('content') or []):
                if not isinstance(p, dict): continue
                if p.get('type') == 'text' and p.get('text'):
                    print(f"  [{m.get('type')}] {p['text'][:200]}")
                elif p.get('type') == 'tool':
                    st = p.get('state') or {}
                    inp = st.get('input') or {}
                    desc = inp.get('description') or inp.get('command') or inp.get('agent') or ''
                    print(f"  [TOOL {p.get('name')}] {st.get('status')} {str(desc)[:100]}")
    elif cmd == 'summary':
        d = api('/api/agency/state')
        m = d['metrics']
        print(f"projects={len(d['projects'])} sprints={len(d['sprints'])} tasks={len(d['tasks'])} roster={len(d['roster'])}")
        cs = m.get('currentSprint') or {}
        print(f"sprint={cs.get('name')} open={cs.get('openTasks')} blocked={cs.get('blockedTasks')} done={cs.get('doneTasks')} daysLeft={cs.get('daysRemaining')}")
        print(f"util={round(m['utilization']['percent']*100)}% lead={m['leadTime']['avgHours']}h sla={round(m['sla']['compliance']*100)}% escalations={m['escalations']['open']}")
        print(f"standup={d['standup']['totals']}")
    elif cmd == 'workload':
        d = api('/api/agency/workload')
        for a in d['roster']:
            pct = round(a['utilization'] * 100)
            print(f"  {a['name']:<18} {a['loadHours']:>3}h/{a['capacityHours']:<3}h {pct:>4}% {'#' * int(pct / 5):<20} {a['status']}")
    elif cmd == 'tasks':
        d = api('/api/agency/state')
        for t in d['tasks']:
            print(f"  {t['status']:<12} {t['phase']:<12} {t['role']:<32} {t['estimateHours']:>3}h owner={t['ownerId']} {t['blockedReason'] or ''} :: {t['title']}")
    elif cmd == 'delegations':
        d = api('/api/opencode/live')
        print(f"connected={d.get('connected')} delegations={len(d.get('delegations',[]))}")
        for x in d.get('delegations', [])[:8]:
            print(f"  {x.get('subagent'):<16} {x.get('status'):<12} {x.get('description','')[:70]}")
    elif cmd == 'autonomy':
        d = api('/api/autonomy/status')
        print(json.dumps(d, indent=2))
