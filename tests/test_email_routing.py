import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('email_routing', ROOT / 'tools' / 'email_routing.py')
email_routing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(email_routing)


def test_config_lists_seven_addresses():
    config = email_routing.load_config(str(ROOT / 'ops' / 'email-routing' / 'nougenai.com.json'))
    wanted = email_routing.wanted_addresses(config)
    assert wanted == [f'{a}@nougenai.com' for a in ('contact', 'support', 'hello', 'billing', 'security', 'privacy', 'legal')]
    assert config['catch_all'] == 'drop'


def test_wanted_addresses_lowercases_and_dedupes():
    config = {'domain': 'Example.COM', 'addresses': ['Hello', 'hello ', 'billing']}
    assert email_routing.wanted_addresses(config) == ['hello@example.com', 'billing@example.com']


def test_plan_skips_existing_rules_and_ignores_catch_all():
    rules = [
        {'matchers': [{'type': 'literal', 'field': 'to', 'value': 'Contact@example.com'}]},
        {'matchers': [{'type': 'all'}]},
    ]
    wanted = ['contact@example.com', 'support@example.com']
    assert email_routing.plan(wanted, rules) == ['support@example.com']
