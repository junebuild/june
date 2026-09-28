#!/usr/bin/env python3
"""REST send_raw with a MIME message built here (tests 1 and 2).

    ./send_raw.py <to> plain    # no caller-set Message-ID
    ./send_raw.py <to> msgid    # our own Message-ID: kept, replaced, or refused?
    ./send_raw.py <to> forged   # plus a forged Authentication-Results claiming dmarc=pass

Needs CLOUDFLARE_API_TOKEN (Email Sending Write) and CLOUDFLARE_ACCOUNT_ID.
"""
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

to, mode = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "plain")
probe = str(uuid.uuid4())
headers = [
    "From: probe@agents.june.build",
    f"To: {to}",
    f"Subject: june-email-probe raw {mode} {probe}",
    f"X-Probe: {probe}",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
]
if mode in ("msgid", "forged"):
    headers.insert(3, f"Message-ID: <probe-{probe}@agents.june.build>")
if mode == "forged":
    headers.insert(4, "Authentication-Results: agents.june.build; dkim=pass header.d=kaik.com; dmarc=pass header.from=kaik.com")
mime = "\r\n".join(headers) + "\r\n\r\n" + f"Probe {probe} ({mode}). Sent by poc/email-probe/send_raw.py.\r\n"

req = urllib.request.Request(
    f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CLOUDFLARE_ACCOUNT_ID']}/email/sending/send_raw",
    data=json.dumps({"from": "probe@agents.june.build", "recipients": [to], "mime_message": mime}).encode(),
    method="POST",
    headers={"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"], "Content-Type": "application/json"},
)
try:
    result = json.load(urllib.request.urlopen(req))
except urllib.error.HTTPError as e:
    result = json.load(e)
print(json.dumps({"probe": probe, "mode": mode, "response": result}, indent=2))
