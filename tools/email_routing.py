"""Cloudflare Email Routing as code: forward named addresses on a domain to one inbox.

Reads a config (ops/email-routing/<domain>.json) listing the local parts to forward, then makes
Cloudflare match it: enables Email Routing on the zone, makes sure the destination address is
registered (Cloudflare emails it a one-time verification link), adds a forward rule for each
address, and sets the catch-all to drop everything else.

The destination inbox is NOT stored in the repo. Pass --to or set EMAIL_ROUTING_DESTINATION.
The token comes from CLOUDFLARE_API_TOKEN (needs Zone Email Routing edit, Account Email Routing
Addresses edit, and Zone read).

    python tools/email_routing.py plan  --config ops/email-routing/nougenai.com.json
    python tools/email_routing.py apply --config ops/email-routing/nougenai.com.json --to inbox@example.com

`plan` only reads. `apply` changes the zone. Running `apply` twice is safe: existing rules are kept.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = 'https://api.cloudflare.com/client/v4'


def load_config(path: str) -> dict:
    config = json.loads(Path(path).read_text(encoding='utf-8'))
    if not config.get('domain') or not config.get('addresses'):
        raise SystemExit(f'{path}: needs "domain" and a non-empty "addresses" list')
    return config


def wanted_addresses(config: dict) -> list[str]:
    """Full addresses from the config's local parts, lower-cased, de-duplicated, in order."""
    seen, out = set(), []
    for local in config['addresses']:
        address = f'{local.strip().lower()}@{config["domain"].lower()}'
        if address not in seen:
            seen.add(address)
            out.append(address)
    return out


def plan(wanted: list[str], existing_rules: list[dict]) -> list[str]:
    """Addresses that still need a forward rule."""
    have = {m.get('value', '').lower() for r in existing_rules for m in r.get('matchers', []) if m.get('type') == 'literal'}
    return [a for a in wanted if a not in have]


class Cloudflare:
    def __init__(self, token: str):
        self.token = token

    def call(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(API + path, data=data, method=method,
                                         headers={'Authorization': f'Bearer {self.token}', 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as err:
            return {'success': False, 'errors': [err.read().decode('utf-8', errors='replace')[:300]]}

    def zone_id(self, domain: str) -> str:
        result = self.call('GET', f'/zones?name={domain}').get('result') or []
        if not result:
            raise SystemExit(f'zone {domain} not found for this token')
        return result[0]['id']

    def account_id(self, zone: str) -> str:
        return self.call('GET', f'/zones/{zone}')['result']['account']['id']


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('action', choices=['plan', 'apply'])
    parser.add_argument('--config', required=True)
    parser.add_argument('--to', default=os.environ.get('EMAIL_ROUTING_DESTINATION'))
    args = parser.parse_args()

    token = os.environ.get('CLOUDFLARE_API_TOKEN')
    if not token:
        raise SystemExit('set CLOUDFLARE_API_TOKEN')
    config = load_config(args.config)
    cf = Cloudflare(token)
    zone = cf.zone_id(config['domain'])
    wanted = wanted_addresses(config)
    rules = cf.call('GET', f'/zones/{zone}/email/routing/rules').get('result') or []
    missing = plan(wanted, rules)
    status = (cf.call('GET', f'/zones/{zone}/email/routing').get('result') or {}).get('status')
    print(f'{config["domain"]}: routing {status}; {len(wanted)} wanted, {len(missing)} missing: {missing}')
    if args.action == 'plan':
        return 0

    if not args.to:
        raise SystemExit('apply needs --to or EMAIL_ROUTING_DESTINATION')
    if status != 'ready':
        print('enable routing:', cf.call('POST', f'/zones/{zone}/email/routing/enable').get('success'))
    account = cf.account_id(zone)
    destinations = cf.call('GET', f'/accounts/{account}/email/routing/addresses').get('result') or []
    match = [d for d in destinations if d.get('email', '').lower() == args.to.lower()]
    if not match:
        print('register destination:', cf.call('POST', f'/accounts/{account}/email/routing/addresses', {'email': args.to}).get('success'))
        print('Cloudflare has emailed a verification link to the destination. Click it, then run apply again.')
        return 2
    if not match[0].get('verified'):
        print('Destination is not verified yet. Click the link Cloudflare emailed to it, then run apply again.')
        return 2
    for address in missing:
        result = cf.call('POST', f'/zones/{zone}/email/routing/rules', {
            'name': f'{address.split("@")[0]} forward', 'enabled': True,
            'matchers': [{'type': 'literal', 'field': 'to', 'value': address}],
            'actions': [{'type': 'forward', 'value': [args.to]}]})
        print('forward', address, result.get('success'), result.get('errors') or '')
    catch_all = config.get('catch_all', 'drop')
    action = {'type': 'drop'} if catch_all == 'drop' else {'type': 'forward', 'value': [args.to]}
    result = cf.call('PUT', f'/zones/{zone}/email/routing/rules/catch_all',
                     {'enabled': True, 'matchers': [{'type': 'all'}], 'actions': [action]})
    print(f'catch-all -> {catch_all}:', result.get('success'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
