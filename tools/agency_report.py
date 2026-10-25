import json, subprocess, sys

def api(path):
    out = subprocess.run(['curl','-s','-m','15',f'http://127.0.0.1:9012{path}'],
                         capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except Exception:
        return {}

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'standup'
    if cmd == 'standup':
        d = api('/api/agency/standup')
        print(f"STANDUP {d.get('date')}  totals={d.get('totals')}")
        for a in d.get('agents', []):
            if a['done'] or a['inProgress'] or a['blockers']:
                print(f"  {a['name']:<16} {a['matrixRole']:<30} "
                      f"done={a['done']} prog={a['inProgress']} block={a['blockers']}")
    elif cmd == 'metrics':
        m = api('/api/agency/metrics')
        cs = m.get('currentSprint') or {}
        print("METRICS")
        print(f"  sprint        {cs.get('name')}  {cs.get('doneTasks')}/{cs.get('totalTasks')} done, "
              f"{cs.get('openTasks')} open, {cs.get('blockedTasks')} blocked, {cs.get('daysRemaining')}d left")
        print(f"  utilization   {round(m['utilization']['percent']*100)}%  "
              f"({m['utilization']['totalLoadHours']}h / {m['utilization']['totalCapacityHours']}h)")
        print(f"  lead time     {m['leadTime']['avgHours']}h over {m['leadTime']['samples']} samples")
        print(f"  SLA           {round(m['sla']['compliance']*100)}%  ({m['sla']['completedOnTime']}/{m['sla']['completedTotal']})")
        print(f"  defects       {m['defects']['count']} ({round(m['defects']['rate']*100)}%)")
        print(f"  escalations   {m['escalations']['open']} open  {m['escalations']['byLevel']}")
        print(f"  throughput    {m['throughput']}")
        print(f"  velocity      {m['velocity']}")
    elif cmd == 'activity':
        d = api('/api/agency/state')
        print("ACTIVITY (last 18)")
        for a in d.get('activity', [])[:18]:
            print(f"  {a['who']:<18} {a['text'][:80]}")
    elif cmd == 'gates':
        d = api('/api/agency/state')
        print("GATES:")
        for k, g in (d.get('gates') or {}).items():
            print(f"  before {k:<12} {g['label']:<22} approvers={g['approverRoles']}")
        print("ESCALATION PATH:")
        for s in d.get('escalationPath', []):
            print(f"  L{s['level']} {s['owner']:<16} ({s['matrixRole']})")
