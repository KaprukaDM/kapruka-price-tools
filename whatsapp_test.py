"""
WhatsApp Cloud API test script.

Usage:
    Set the token as an environment variable (do NOT hardcode it in this file):

    PowerShell:
        $env:WHATSAPP_TOKEN = "your-token-here"
        python whatsapp_test.py

Steps performed:
    1. Calls /debug_token to check if the token itself is valid/expired/scoped correctly.
    2. Registers the phone number (one-time step; safe to re-run, Meta no-ops if already registered).
    3. Sends a "hello_world" template message to the recipient number.

Set REGISTRATION_PIN to a 6-digit PIN of your choosing before first run. This PIN is used for
two-step verification on this WhatsApp number going forward — remember it.
"""

import os
import sys
import requests

TOKEN = os.environ.get("WHATSAPP_TOKEN")
PHONE_NUMBER_ID = "1301606166362499"
RECIPIENT = "94702398628"
API_VERSION = "v20.0"
REGISTRATION_PIN = os.environ.get("WHATSAPP_REGISTRATION_PIN")


def debug_token():
    url = f"https://graph.facebook.com/debug_token"
    params = {"input_token": TOKEN, "access_token": TOKEN}
    resp = requests.get(url, params=params)
    print("=== debug_token response ===")
    print(resp.status_code, resp.json())
    return resp.ok and "error" not in resp.json()


def register_number():
    if not REGISTRATION_PIN:
        print("ERROR: Set the WHATSAPP_REGISTRATION_PIN environment variable (a 6-digit PIN you choose).")
        sys.exit(1)
    url = f"https://graph.facebook.com/{API_VERSION}/{PHONE_NUMBER_ID}/register"
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {"messaging_product": "whatsapp", "pin": REGISTRATION_PIN}
    resp = requests.post(url, headers=headers, json=payload)
    print("=== register response ===")
    print(resp.status_code, resp.json())
    return resp.ok


def send_hello_world():
    url = f"https://graph.facebook.com/{API_VERSION}/{PHONE_NUMBER_ID}/messages"
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "messaging_product": "whatsapp",
        "to": RECIPIENT,
        "type": "template",
        "template": {"name": "hello_world", "language": {"code": "en_US"}},
    }
    resp = requests.post(url, headers=headers, json=payload)
    print("=== send message response ===")
    print(resp.status_code, resp.json())


if __name__ == "__main__":
    if not TOKEN:
        print("ERROR: Set the WHATSAPP_TOKEN environment variable before running this script.")
        print('  PowerShell:  $env:WHATSAPP_TOKEN = "your-token-here"')
        sys.exit(1)

    if not debug_token():
        print("Token check failed — fix the token first.")
        sys.exit(1)

    if not register_number():
        print("Registration failed — see error above; not attempting to send message.")
        sys.exit(1)

    send_hello_world()
