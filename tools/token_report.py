import json, subprocess, sys

BASE = 'http://127.0.0.1:9012'

def api(path):
    out = subprocess.run(['curl','-s','-m','60',BASE + path], capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except Exception:
        return {'raw': out[:300]}

def compact(n):
    """11905815 -> 11.9M ; 24500 -> 24.5K ; 812 -> 812"""
    n = float(n or 0)
    a = abs(n)
    if a >= 1e9: return f'{n/1e9:.1f}B'
    if a >= 1e6: return f'{n/1e6:.2f}M'
    if a >= 1e4: return f'{n/1e3:.1f}K'
    if a >= 1000: return f'{n/1e3:.2f}K'
    return str(int(n))

if __name__ == '__main__':
    d = api('/api/agency/tokens')
    u = d.get('usage') or {}
    pct = round(d['percent'] * 100, 1)

    print('TOKEN BUDGET')
    print(f"  autopilot today   {compact(d['spentToday'])} of {compact(d['budget'])}   ({pct}%)   "
          f"{'OK' if d['allowed'] else 'BLOCKED'}")
    print(f"  office lifetime  {compact(u.get('total',0))} tokens   "
          f"${u.get('cost',0):.2f}   cache reads {compact(u.get('cacheRead',0))}")
    print(f"  sessions         {u.get('sessionCount',0)}")

    print('\n  OFFICE SPEND TODAY BY ROLE (autopilot only)')
    roles = [r for r in u.get('byRole', []) if r.get('todayAutopilotTokens', 0) > 0]
    if not roles:
        print('    (none recorded today)')
    for r in roles:
        name = r.get('name') or r.get('matrixRole')
        share = (r['todayAutopilotTokens'] / roles[0]['todayAutopilotTokens'] * 100) if roles[0]['todayAutopilotTokens'] else 0
        bar = '#' * int(share / 5)
        print(f"    {name:<22} {compact(r['todayAutopilotTokens']):>8}   {share:>5.1f}%  {bar}")

    print('\n  TOP SESSIONS (all-time)')
    for s in u.get('bySession', [])[:8]:
        who = s.get('name') or s.get('agent') or '—'
        scope = 'auto' if s.get('root') == 'autopilot' else 'human'
        print(f"    {who:<20} {compact(s['tokens']):>8}  {scope:<6} {s.get('outcome') or 'running':<10} {s['title'][:34]}")
