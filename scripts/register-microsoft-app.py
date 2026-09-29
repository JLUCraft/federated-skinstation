#!/usr/bin/env python3
"""Prepare or register the skin station OAuth app using an authenticated Azure CLI."""
import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

MANIFEST = {
    'displayName': 'JLUCraft Skin',
    'signInAudience': 'PersonalMicrosoftAccount',
    'api': {'requestedAccessTokenVersion': 2},
    'web': {
        'redirectUris': ['https://skin.jlucraft.com/api/microsoft/callback'],
        'implicitGrantSettings': {'enableIdTokenIssuance': False, 'enableAccessTokenIssuance': False},
    },
    'isFallbackPublicClient': False,
}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Create a new app in the authenticated tenant')
    args = parser.parse_args()
    if not args.apply:
        print(json.dumps(MANIFEST, ensure_ascii=False, indent=2))
        return
    if not shutil.which('az'):
        raise SystemExit('Azure CLI is not installed. Install it, then sign in to your tenant with az login.')
    account = subprocess.run(['az', 'account', 'show', '--output', 'json'], capture_output=True, text=True)
    if account.returncode:
        raise SystemExit('Sign in to the intended tenant first: az login --allow-no-subscriptions --tenant TENANT_ID')
    tenant = json.loads(account.stdout)['tenantId']
    directory = Path.home() / '.local' / 'share' / 'jlucraft' / 'microsoft-oauth'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    destination = directory / 'registration.json'
    # Refuse to create another cloud app if this machine already recorded a registration.
    if destination.exists():
        raise SystemExit(f'Registration already recorded at {destination}; review it before creating another app.')
    result = subprocess.run(['az', 'rest', '--method', 'POST', '--url', 'https://graph.microsoft.com/v1.0/applications', '--body', json.dumps(MANIFEST), '--output', 'json'], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit('Microsoft rejected app creation. Check tenant permissions in Entra; no client secret was requested.')
    app = json.loads(result.stdout)
    metadata = {'tenantId': tenant, 'objectId': app['id'], 'clientId': app['appId'], 'redirectUri': MANIFEST['web']['redirectUris'][0]}
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(metadata, stream, indent=2)
    print(f"Created application {app['appId']}; metadata saved to {destination}")
    print('Add a client secret in Entra and store its value in the server environment as JLUC_MICROSOFT_CLIENT_SECRET.')
    print('Set microsoft.clientId and microsoft.clientSecretEnv in the skin station service configuration.')

if __name__ == '__main__':
    main()
